import { spawn } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createReadStream, readFileSync, writeFileSync, existsSync } from 'fs';

const CURRENT_DIR = dirname(fileURLToPath(import.meta.url));
import { Readable } from 'stream';
import { AssGenerator } from './ass-generator.js';

export interface WatermarkConfig {
    enabled: boolean;
    type: 'text' | 'image';
    value?: string;
}

export interface RenderOptions {
    audioPath: string;
    captionPath: string;
    assetPaths: string[];
    outputPath: string;
    preset: string;
    rendering_hints?: any;
    musicPath?: string;
    musicVolume?: number;
    width?: number;
    height?: number;
    /** When enabled, burn text watermark into video (from backend/user plan). */
    watermark?: WatermarkConfig;
}

export class VideoProcessor {
    async process(options: RenderOptions): Promise<void> {
        const { audioPath, captionPath, assetPaths, outputPath, preset, rendering_hints, musicPath, musicVolume, watermark } = options;
        const width = rendering_hints?.width || 720;
        const height = rendering_hints?.height || 1280;
        const hasWatermark = Boolean(watermark?.enabled && watermark?.type === 'text' && watermark?.value);

        const audioDuration = await this.getMediaDuration(audioPath);
        const imageCount = assetPaths.length || 1;
        const transitionDuration = rendering_hints?.pacing === 'fast' ? 0.3 : rendering_hints?.pacing === 'slow' ? 1.0 : 0.5;
        const audioDurationWithBuffer = audioDuration + 0.5;

        let slideDuration: number;
        if (imageCount > 1) {
            slideDuration = (audioDurationWithBuffer + (imageCount - 1) * transitionDuration) / imageCount;
        } else {
            slideDuration = audioDurationWithBuffer;
        }
        slideDuration = Math.max(3, slideDuration);

        const complexFilters: string[] = [];
        const videoStreams: string[] = [];

        // 1. Inputs and Per-Image Filters
        assetPaths.forEach((_, i) => {
            const effect = this.getRandomKenBurnsEffect();
            const frames = Math.ceil((slideDuration + transitionDuration) * 25);
            complexFilters.push(
                `[${i}:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1,` +
                `zoompan=${effect}d=${frames}:s=${width}x${height}:fps=25[v${i}]`
            );
            videoStreams.push(`v${i} `);
        });

        // 2. XFade Transitions
        if (videoStreams.length > 1) {
            let prevStream = videoStreams[0];
            let currentOffset = slideDuration - transitionDuration;

            for (let i = 1; i < videoStreams.length; i++) {
                const nextStream = videoStreams[i];
                const outStream = i === videoStreams.length - 1 ? 'v_merged_raw' : `x${i}`;
                complexFilters.push(
                    `[${prevStream}][${nextStream}]xfade=transition=fade:duration=${transitionDuration}:offset=${currentOffset}[${outStream}]`
                );
                prevStream = outStream;
                currentOffset += slideDuration - transitionDuration;
            }
        } else {
            complexFilters.push(`[v0]copy[v_merged_raw]`);
        }

        // 3. Sequential Stable Captions (Deterministic Drawtext Path)
        const captionsConfig = rendering_hints?.captions || {};
        const enabled = captionsConfig.enabled !== false;

        if (enabled && captionPath) {
            const isJson = captionPath.endsWith('.json');

            if (isJson) {
                const captions = JSON.parse(readFileSync(captionPath).toString());
                const captionLanguage = captionsConfig.language ?? rendering_hints?.language;
                const isHindi = captionLanguage && /hindi|hi|हिंदी/i.test(String(captionLanguage));

                // --- ASS SUBTITLE GENERATION (True Karaoke) ---
                const assPath = captionPath.replace('.json', '.ass');
                const assContent = AssGenerator.generate(captions, captionsConfig.preset || 'karaoke-card', captionsConfig.position || 'bottom', captionLanguage);
                writeFileSync(assPath, assContent);

                const escapedAssPath = this.escapeFilterPath(assPath);
                // For Hindi, use bundled font so Devanagari renders (avoids tofu). fontsdir is relative to worker root.
                const fontsDir = join(CURRENT_DIR, '..', 'fonts');
                const useFontsDir = isHindi && existsSync(fontsDir);
                const fontsDirOpt = useFontsDir ? `:fontsdir='${this.escapeFilterPath(fontsDir)}'` : '';

                // Use subtitles filter directly on the stream
                complexFilters.push(
                    `[v_merged_raw]subtitles='${escapedAssPath}'${fontsDirOpt}[v_final]`
                );

                // No loop needed, subtitles filter handles the whole file
            } else {
                // Backward compatibility for legacy ASS/SRT files
                const escapedPath = this.escapeFilterPath(captionPath);
                const filter = captionPath.endsWith('.ass') ? 'ass' : 'subtitles';
                complexFilters.push(`[v_merged_raw]${filter}='${escapedPath}'[v_final]`);
            }
        } else {
            complexFilters.push(`[v_merged_raw]copy[v_final]`);
        }

        // 3b. Optional watermark (FREE plan; backend sets monetization.watermark)
        const videoOutputLabel = hasWatermark ? 'v_watermarked' : 'v_final';
        if (hasWatermark) {
            const text = (watermark!.value ?? 'Made with AutoReels').replace(/'/g, "'\\\\\\''");
            complexFilters.push(
                `[v_final]drawtext=text='${text}':fontsize=24:fontcolor=white@0.6:x=w-tw-20:y=h-th-20[v_watermarked]`
            );
        }

        // 4. Audio Mixing
        const voIndex = assetPaths.length;
        const musicIndex = voIndex + 1;
        let finalAudioMap = `${voIndex}:a`;

        if (musicPath) {
            const bgVol = musicVolume !== undefined ? musicVolume : 0.2;
            complexFilters.push(
                // Split VO: one for output (clean), one for sidechain trigger
                `[${voIndex}:a]volume=1.0,asplit[vo_clean][vo_trigger];` +
                // Prepare BG Music: Loop is handled by input flag, just set volume
                `[${musicIndex}:a]volume=${bgVol}[bg_raw];` +
                // Sidechain Ducking: Compress BG when VO is active
                // threshold: reduce when VO > 0.05
                // ratio: 4:1 reduction
                // release: 200ms recovery time
                `[bg_raw][vo_trigger]sidechaincompress=threshold=0.05:ratio=4:attack=5:release=200[bg_ducked];` +
                // Mix clean VO and ducked BG
                `[vo_clean][bg_ducked]amix=inputs=2:duration=first:dropout_transition=0[a_final]`
            );
            finalAudioMap = '[a_final]';
        }

        const args = [
            '-y',
            ...assetPaths.flatMap(p => ['-i', p]),
            '-i', audioPath,
            ...(musicPath ? ['-stream_loop', '-1', '-i', musicPath] : []),
            '-filter_complex', complexFilters.join(';'),
            '-map', `[${videoOutputLabel}]`,
            '-map', finalAudioMap,
            '-c:v', 'libx264',
            '-preset', preset,
            '-crf', '23',
            '-c:a', 'aac',
            '-b:a', '192k',
            '-pix_fmt', 'yuv420p',
            '-shortest',
            '-f', 'mp4',
            outputPath
        ];

        console.log(`[Processor][FFmpeg] 🛠️ Command: ffmpeg ${args.join(' ')} `);
        const startTime = Date.now();

        return new Promise((resolve, reject) => {
            const ffmpeg = spawn('ffmpeg', args);
            let stderrLogs = '';

            ffmpeg.stderr.on('data', (data) => {
                const chunk = data.toString();
                stderrLogs += chunk;
                // Optional: log progress lines only (too much noise otherwise)
                if (chunk.includes('frame=')) {
                    // console.log(`[FFmpeg Progress] ${ chunk.trim() } `);
                }
            });

            ffmpeg.on('close', (code) => {
                const duration = ((Date.now() - startTime) / 1000).toFixed(2);
                if (code === 0) {
                    console.log(`[Processor][FFmpeg] ✅ Process finished successfully in ${duration} s`);
                    resolve();
                } else {
                    console.error(`[Processor][FFmpeg] ❌ Process failed with code ${code} `);
                    console.error(`[Processor][FFmpeg] 📄 Last logs: \n${stderrLogs.slice(-2000)} `);
                    reject(new Error(`FFmpeg exited with code ${code}. Check logs for details.`));
                }
            });

            ffmpeg.on('error', (err) => {
                console.error(`[Processor][FFmpeg] 💥 Failed to start subprocess: `, err);
                reject(err);
            });
        });
    }

    private async getMediaDuration(path: string): Promise<number> {
        return new Promise((resolve) => {
            const ffprobe = spawn('ffprobe', [
                '-v', 'error',
                '-show_entries', 'format=duration',
                '-of', 'default=noprint_wrappers=1:nokey=1',
                path
            ]);

            let output = '';
            ffprobe.stdout.on('data', (data) => {
                output += data.toString();
            });

            ffprobe.on('close', (code) => {
                if (code === 0) {
                    resolve(parseFloat(output) || 0);
                } else {
                    resolve(0);
                }
            });
        });
    }

    private getRandomKenBurnsEffect(): string {
        const effects = [
            "z='min(zoom+0.0015,1.5)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':",
            "z='if(eq(on,1),1.5,max(1.0,zoom-0.0015))':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':",
            "z=1.2:x='if(eq(on,1),0,min(x+1,iw-iw/zoom))':y='(ih-ih/zoom)/2':",
            "z=1.2:x='if(eq(on,1),iw-iw/zoom,max(x-1,0))':y='(ih-ih/zoom)/2':",
        ];
        return effects[Math.floor(Math.random() * effects.length)]!;
    }

    private escapeFilterPath(path: string): string {
        return path
            .replace(/\\/g, '/')
            .replace(/:/g, '\\:')
            .replace(/'/g, "'\\\\\\''"); // Triple-escaped for FFmpeg's filter parser
    }
}




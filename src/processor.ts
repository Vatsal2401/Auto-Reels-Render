import { spawn } from 'child_process';
import { join } from 'path';
import { createReadStream } from 'fs';
import { Readable } from 'stream';

export interface RenderOptions {
    audioPath: string;
    captionPath: string;
    assetPaths: string[];
    outputPath: string;
    preset: string;
    rendering_hints?: any;
    musicPath?: string;
    musicVolume?: number;
}

export class VideoProcessor {
    async process(options: RenderOptions): Promise<void> {
        const { audioPath, captionPath, assetPaths, outputPath, preset, rendering_hints, musicPath, musicVolume } = options;

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
                `[${i}:v]scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,setsar=1,` +
                `zoompan=${effect}d=${frames}:s=720x1280:fps=25[v${i}]`
            );
            videoStreams.push(`v${i}`);
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

        // 3. Captions
        const captionsConfig = rendering_hints?.captions || {};
        const enabled = captionsConfig.enabled !== false;

        if (enabled && captionPath) {
            const isAss = captionPath.endsWith('.ass');
            const escapedPath = this.escapeFilterPath(captionPath);
            if (isAss) {
                // ASS handles styles internally
                complexFilters.push(
                    `[v_merged_raw]ass='${escapedPath}'[v_final]`
                );
            } else {
                const style = this.getCaptionStyle(captionsConfig.preset, captionsConfig.position);
                complexFilters.push(
                    `[v_merged_raw]subtitles='${escapedPath}':force_style='${style}'[v_final]`
                );
            }
        } else {
            // Bypass captions if disabled or missing
            complexFilters.push(`[v_merged_raw]copy[v_final]`);
        }

        // 4. Audio Mixing
        const voIndex = assetPaths.length;
        const musicIndex = voIndex + 1;
        let finalAudioMap = `${voIndex}:a`;

        if (musicPath) {
            const bgVol = musicVolume !== undefined ? musicVolume : 0.2;
            complexFilters.push(
                `[${voIndex}:a]volume=1.0[vo];` +
                `[${musicIndex}:a]volume=${bgVol}[bg];` +
                `[vo][bg]amix=inputs=2:duration=first:dropout_transition=2[a_final]`
            );
            finalAudioMap = '[a_final]';
        }

        const args = [
            '-y',
            ...assetPaths.flatMap(p => ['-i', p]),
            '-i', audioPath,
            ...(musicPath ? ['-i', musicPath] : []),
            '-filter_complex', complexFilters.join(';'),
            '-map', '[v_final]',
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

        console.log(`[Processor] [FFmpeg] 🛠️ Command: ffmpeg ${args.join(' ')}`);
        const startTime = Date.now();

        return new Promise((resolve, reject) => {
            const ffmpeg = spawn('ffmpeg', args);
            let stderrLogs = '';

            ffmpeg.stderr.on('data', (data) => {
                const chunk = data.toString();
                stderrLogs += chunk;
                // Optional: log progress lines only (too much noise otherwise)
                if (chunk.includes('frame=')) {
                    // console.log(`[FFmpeg Progress] ${chunk.trim()}`);
                }
            });

            ffmpeg.on('close', (code) => {
                const duration = ((Date.now() - startTime) / 1000).toFixed(2);
                if (code === 0) {
                    console.log(`[Processor] [FFmpeg] ✅ Process finished successfully in ${duration}s`);
                    resolve();
                } else {
                    console.error(`[Processor] [FFmpeg] ❌ Process failed with code ${code}`);
                    console.error(`[Processor] [FFmpeg] 📄 Last logs:\n${stderrLogs.slice(-2000)}`);
                    reject(new Error(`FFmpeg exited with code ${code}. Check logs for details.`));
                }
            });

            ffmpeg.on('error', (err) => {
                console.error(`[Processor] [FFmpeg] 💥 Failed to start subprocess:`, err);
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

    private getCaptionStyle(preset: string = 'clean-minimal', position: string = 'bottom'): string {
        // Base Alignment
        // 2 = Bottom Center, 5 = Middle Center, 6 = Top Center
        const alignment = position === 'top' ? 8 : position === 'center' ? 5 : 2;
        const marginV = position === 'top' ? 100 : position === 'center' ? 50 : 150;

        let style = `Alignment=${alignment},MarginV=${marginV}`;

        switch (preset.toLowerCase()) {
            case 'bold-stroke':
                style += `,FontName=DejaVu Sans,FontSize=18,PrimaryColour=&H00FFFFFF,SecondaryColour=&H000000FF,OutlineColour=&H000000,BorderStyle=1,Outline=4,Shadow=0,Bold=1`;
                break;
            case 'red-highlight':
                style += `,FontName=DejaVu Sans,FontSize=18,PrimaryColour=&H00FFFFFF,SecondaryColour=&H000000FF,OutlineColour=&H000000FF,BorderStyle=1,Outline=4,Shadow=1,Bold=1`;
                break;
            case 'sleek':
                style += `,FontName=DejaVu Sans,FontSize=16,PrimaryColour=&H00FFFFFF,SecondaryColour=&H00FFA500,BackColour=&H00FFFFFF,BorderStyle=1,Outline=0,Shadow=3,Bold=0`;
                break;
            case 'karaoke-card':
                style += `,FontName=DejaVu Sans,FontSize=16,PrimaryColour=&H00FFFFFF,SecondaryColour=&H00FF00FF,BackColour=&H00FF00FF,BorderStyle=3,Outline=0,Shadow=0,Bold=1`;
                break;
            case 'majestic':
                style += `,FontName=DejaVu Sans,FontSize=20,PrimaryColour=&H00FFFFFF,SecondaryColour=&H00FF00FF,OutlineColour=&H000000,BorderStyle=1,Outline=1,Shadow=4,Bold=1`;
                break;
            case 'beast':
                style += `,FontName=DejaVu Sans,FontSize=20,PrimaryColour=&H00FFFFFF,SecondaryColour=&H000000FF,OutlineColour=&H000000,BorderStyle=1,Outline=5,Shadow=0,Bold=1,Italic=1`;
                break;
            case 'elegant':
                style += `,FontName=DejaVu Serif,FontSize=14,PrimaryColour=&H00FFFFFF,SecondaryColour=&H00FFCCCC,OutlineColour=&H000000,BorderStyle=1,Outline=0,Shadow=1,Bold=0`;
                break;
            case 'clean-minimal':
            default:
                style += `,FontName=Arial,FontSize=16,PrimaryColour=&HFFFFFF,SecondaryColour=&H000000FF,OutlineColour=&H80000000,BorderStyle=1,Outline=1,Shadow=1,Bold=1`;
                break;
        }

        return style;
    }
}

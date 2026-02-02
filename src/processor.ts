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
}

export class VideoProcessor {
    async process(options: RenderOptions): Promise<void> {
        const { audioPath, captionPath, assetPaths, outputPath, preset, rendering_hints } = options;

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
        complexFilters.push(
            `[v_merged_raw]subtitles='${captionPath}':force_style='FontSize=16,PrimaryColour=&Hffffff,OutlineColour=&H000000,BorderStyle=1,Outline=1,Shadow=0,Bold=1,Alignment=2,MarginV=50'[v_final]`
        );

        const audioIndex = assetPaths.length;
        const args = [
            '-y',
            ...assetPaths.flatMap(p => ['-i', p]),
            '-i', audioPath,
            '-filter_complex', complexFilters.join(';'),
            '-map', '[v_final]',
            '-map', `${audioIndex}:a`,
            '-c:v', 'libx264',
            '-preset', preset,
            '-threads', '1',
            '-filter_threads', '1',
            '-filter_complex_threads', '1',
            '-crf', '23',
            '-c:a', 'aac',
            '-b:a', '192k',
            '-pix_fmt', 'yuv420p',
            '-shortest',
            '-f', 'mp4',
            outputPath
        ];

        console.log(`[Processor] [FFmpeg] 🛠️ Command: ffmpeg ${args.join(' ')}`);

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
                if (code === 0) {
                    console.log(`[Processor] [FFmpeg] ✅ Process finished successfully.`);
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
}

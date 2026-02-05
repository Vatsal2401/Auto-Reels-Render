import { VideoProcessor } from './processor';
import { join } from 'path';
import { existsSync } from 'fs';

async function main() {
    const processor = new VideoProcessor();
    const debugDir = join(process.cwd(), 'debug_output');

    const videoPath = join(debugDir, 'final_fixed_video_vFinal.mp4');

    const images = [
        join(debugDir, 'image_0.jpg'),
        join(debugDir, 'image_1.jpg'),
        join(debugDir, 'image_2.jpg'),
    ].filter(p => existsSync(p));

    const audioPath = join(debugDir, 'audio.mp3');
    const captionPath = join(debugDir, 'captions.json');

    if (!existsSync(audioPath) || !existsSync(captionPath)) {
        console.error('❌ Missing audio or captions in debug_output');
        return;
    }

    console.log('🚀 Starting final debug render...');

    await processor.process({
        audioPath,
        captionPath,
        assetPaths: images,
        outputPath: videoPath,
        preset: 'medium',
        rendering_hints: {
            pacing: 'fast',
            captions: {
                preset: 'bold-stroke',
                position: 'bottom'
            }
        }
    });

    console.log(`✅ Render complete! Video saved to: ${videoPath}`);
}

main().catch(console.error);

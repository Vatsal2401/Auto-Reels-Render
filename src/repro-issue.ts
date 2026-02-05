import { StorageService } from './storage.js';
import { VideoProcessor } from './processor.js';
import { join } from 'path';
import { mkdirSync } from 'fs';

async function main() {
    const storage = new StorageService();
    const processor = new VideoProcessor();
    const workDir = join(process.cwd(), 'debug_repro_final');
    mkdirSync(workDir, { recursive: true });

    console.log('📥 Downloading assets...');

    // Asset Map
    const assets = {
        audio: 'users/777964c7-2284-4e00-b504-f1bb215a2bec/media/bd6cec91-eef0-43ba-aa2a-d535c94dacb8/audio/audio/ce025697-f25a-450f-9558-29c3d15fbd2a.mp3',
        caption: 'users/777964c7-2284-4e00-b504-f1bb215a2bec/media/bd6cec91-eef0-43ba-aa2a-d535c94dacb8/caption/captions/captions.json',
        images: [
            'users/777964c7-2284-4e00-b504-f1bb215a2bec/media/bd6cec91-eef0-43ba-aa2a-d535c94dacb8/image/images/dcbf9b9a-c276-4dda-b01f-ce14b72bdc63.jpg',
            'users/777964c7-2284-4e00-b504-f1bb215a2bec/media/bd6cec91-eef0-43ba-aa2a-d535c94dacb8/image/images/e32cd239-227d-4736-9933-94f1a957e51d.jpg',
            'users/777964c7-2284-4e00-b504-f1bb215a2bec/media/bd6cec91-eef0-43ba-aa2a-d535c94dacb8/image/images/74f33d29-da5d-45fb-b091-4d1d024d0370.jpg',
            'users/777964c7-2284-4e00-b504-f1bb215a2bec/media/bd6cec91-eef0-43ba-aa2a-d535c94dacb8/image/images/4c21aead-8d40-46d0-89ee-0b26c3ff995d.jpg'
        ]
    };

    const audioPath = join(workDir, 'audio.mp3');
    const captionPath = join(workDir, 'captions.json');
    const imagePaths = assets.images.map((_, i) => join(workDir, `image_${i}.jpg`));
    const outputPath = join(workDir, 'output_final.mp4');

    await Promise.all([
        storage.downloadToFile(assets.audio, audioPath),
        // storage.downloadToFile(assets.caption, captionPath), // SKIP: Use local gap-filled captions
        ...assets.images.map((id, i) => storage.downloadToFile(id, imagePaths[i]!))
    ]);

    console.log('✅ Assets downloaded.');

    console.log('🎬 Processing video...');
    // IMPORTANT: passing 'captionPath' ending in .json triggers AssGenerator
    await processor.process({
        assetPaths: imagePaths,
        audioPath,
        captionPath,
        outputPath,
        preset: 'medium',
        rendering_hints: {
            pacing: 'fast',
            captions: {
                preset: 'bold-stroke',
                position: 'bottom',
                enabled: true
            }
        }
    });

    console.log(`✅ Video rendered to: ${outputPath}`);
}

main().catch(console.error);

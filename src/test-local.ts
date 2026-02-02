import { StorageService } from './storage.js';
import { DbService } from './db.js';
import { VideoProcessor } from './processor.js';
import { join } from 'path';
import { mkdirSync, rmSync, existsSync, createReadStream } from 'fs';
import { tmpdir } from 'os';
import 'dotenv/config';

async function runLocalTest() {
    const storage = new StorageService();
    const db = new DbService();
    const processor = new VideoProcessor();

    await db.connect();
    console.log('Connected to database');

    const jobData = {
        mediaId: 'fcacd286-a79e-4507-9ae4-1af1e756ee5e',
        stepId: 'a1fc1841-b834-49d6-a371-89e96c152965',
        userId: '777964c7-2284-4e00-b504-f1bb215a2bec',
        assets: {
            audio: 'users/777964c7-2284-4e00-b504-f1bb215a2bec/media/fcacd286-a79e-4507-9ae4-1af1e756ee5e/audio/audio/3989b4e5-a906-422d-86d4-309e21b26f7d.mp3',
            caption: 'users/777964c7-2284-4e00-b504-f1bb215a2bec/media/fcacd286-a79e-4507-9ae4-1af1e756ee5e/caption/captions/a4578e12-c0bf-4066-a8f7-d556647be0e7.srt',
            images: [
                'users/777964c7-2284-4e00-b504-f1bb215a2bec/media/fcacd286-a79e-4507-9ae4-1af1e756ee5e/image/images/0aa91d02-4c5d-4591-8ffb-ca9220926431.jpg',
                'users/777964c7-2284-4e00-b504-f1bb215a2bec/media/fcacd286-a79e-4507-9ae4-1af1e756ee5e/image/images/9ea34d81-16ae-447d-9fd1-081e65bc9420.jpg',
                'users/777964c7-2284-4e00-b504-f1bb215a2bec/media/fcacd286-a79e-4507-9ae4-1af1e756ee5e/image/images/3cf586dc-9be9-4d86-8fec-ed53038d8fcf.jpg',
                'users/777964c7-2284-4e00-b504-f1bb215a2bec/media/fcacd286-a79e-4507-9ae4-1af1e756ee5e/image/images/dcb4bb88-8cbb-4fdb-8b37-f0d89f5d3b12.jpg'
            ],
        },
        options: {
            preset: 'fast',
            rendering_hints: {
                pacing: 'moderate'
            }
        },
    };

    const workDir = join(tmpdir(), `test-local-manual`);
    if (existsSync(workDir)) rmSync(workDir, { recursive: true });
    mkdirSync(workDir, { recursive: true });

    const audioPath = join(workDir, 'audio.mp3');
    const captionPath = join(workDir, 'captions.srt');
    const imagePaths = jobData.assets.images.map((_, i) => join(workDir, `image_${i}.jpg`));
    const outputPath = join(workDir, 'output.mp4');

    try {
        console.log('[Test] Downloading assets...');
        await Promise.all([
            storage.downloadToFile(jobData.assets.audio, audioPath),
            storage.downloadToFile(jobData.assets.caption, captionPath),
            ...jobData.assets.images.map((id, i) => storage.downloadToFile(id, imagePaths[i]!))
        ]);

        console.log('[Test] Processing video...');
        await processor.process({
            assetPaths: imagePaths,
            audioPath,
            captionPath,
            preset: jobData.options.preset,
            rendering_hints: jobData.options.rendering_hints,
            outputPath
        });

        console.log('[Test] Uploading result...');
        const resultBlobId = `users/${jobData.userId}/media/${jobData.mediaId}/video/render/test_render_${Date.now()}.mp4`;
        await storage.upload(resultBlobId, createReadStream(outputPath));

        console.log('[Test] Updating database...');
        await db.updateStepStatus(jobData.stepId, 'success', resultBlobId);

        console.log('✅ Local test completed successfully!');
    } catch (error: any) {
        console.error('❌ Local test failed:', error.message);
        await db.updateStepStatus(jobData.stepId, 'failed', undefined, error.message);
    } finally {
        await db.disconnect();
        // Skip cleanup for manual inspection if needed
        // rmSync(workDir, { recursive: true });
    }
}

runLocalTest().catch(console.error);

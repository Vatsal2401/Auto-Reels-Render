import { Worker, Job } from 'bullmq';
import { StorageService } from './storage.js';
import { DbService } from './db.js';
import { VideoProcessor } from './processor.js';
import { join } from 'path';
import { mkdirSync, rmSync, existsSync, createReadStream } from 'fs';
import { tmpdir } from 'os';
import 'dotenv/config';

interface RenderJobPayload {
    mediaId: string;
    stepId: string;
    userId: string;
    assets: {
        audio: string;
        caption: string;
        images: string[];
    };
    options: {
        preset: string;
        rendering_hints?: any;
    };
}

const storage = new StorageService();
const db = new DbService();
const processor = new VideoProcessor();

const worker = new Worker('render-tasks', async (job: Job<RenderJobPayload>) => {
    const { mediaId, stepId, userId, assets, options } = job.data;
    console.log(`[Worker] Starting job ${job.id} for media ${mediaId}`);

    const sessionDir = join(tmpdir(), `render-worker-${job.id}`);
    if (!existsSync(sessionDir)) mkdirSync(sessionDir, { recursive: true });

    try {
        // 1. Download Assets
        console.log(`[Worker] Downloading assets...`);
        const audioPath = join(sessionDir, 'audio.mp3');
        const captionPath = join(sessionDir, 'captions.srt');
        const imagePaths = assets.images.map((_, i) => join(sessionDir, `image-${i}.jpg`));

        await Promise.all([
            storage.downloadToFile(assets.audio, audioPath),
            storage.downloadToFile(assets.caption, captionPath),
            ...assets.images.map((id, i) => storage.downloadToFile(id!, imagePaths[i]!))
        ]);

        // 2. Process Video
        console.log(`[Worker] Processing video with preset ${options.preset}...`);
        const outputPath = join(sessionDir, 'output.mp4');
        await processor.process({
            audioPath,
            captionPath,
            assetPaths: imagePaths,
            outputPath,
            preset: options.preset,
            rendering_hints: options.rendering_hints
        });

        // 3. Upload Result
        console.log(`[Worker] Uploading final video...`);
        const blobId = `users/${userId}/media/${mediaId}/video/render/final_render.mp4`;
        const videoStream = createReadStream(outputPath);
        await storage.upload(blobId, videoStream);

        // 4. Update Database
        console.log(`[Worker] Finalizing job in database...`);
        await db.updateStepStatus(stepId, 'success', blobId);
        await db.addAsset(mediaId, 'video', blobId);

        console.log(`[Worker] Job ${job.id} completed successfully!`);
    } catch (error: any) {
        console.error(`[Worker] Job ${job.id} failed:`, error);
        await db.updateStepStatus(stepId, 'failed', undefined, error.message);
        throw error;
    } finally {
        // 5. Cleanup
        try {
            if (existsSync(sessionDir)) rmSync(sessionDir, { recursive: true, force: true });
        } catch (e) {
            console.error(`[Worker] Failed to cleanup session ${sessionDir}:`, e);
        }
    }
}, {
    connection: {
        url: process.env.REDIS_URL as string,
    },
    concurrency: 1, // Mandatory constraint
});

worker.on('ready', () => {
    console.log('🚀 Render Worker is ready and waiting for jobs...');
});

worker.on('failed', (job: Job<RenderJobPayload> | undefined, err: Error) => {
    console.error(`Job ${job?.id} failed with error: ${err.message}`);
});

// Initialize DB connection
db.connect().then(() => {
    console.log('Connected to database');
}).catch(err => {
    console.error('Database connection failed:', err);
    process.exit(1);
});

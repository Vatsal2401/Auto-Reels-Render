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

const logMemory = (stage: string) => {
    const mem = process.memoryUsage();
    const toMB = (bytes: number) => (bytes / 1024 / 1024).toFixed(2);
    console.log(`[Memory] ${stage} - RSS: ${toMB(mem.rss)}MB, Heap: ${toMB(mem.heapUsed)}/${toMB(mem.heapTotal)}MB`);
};

// Global services (pooled)
const storage = new StorageService();
const db = new DbService();
const processor = new VideoProcessor();

const worker = new Worker('render-tasks', async (job: Job<RenderJobPayload>) => {
    const { mediaId, stepId, userId, assets, options } = job.data;
    const workDir = join(tmpdir(), `render-${job.id}`);

    console.log(`[Worker] 🚀 Starting job ${job.id} for media ${mediaId} (User: ${userId})`);
    logMemory('Job Start');

    try {
        if (!existsSync(workDir)) {
            mkdirSync(workDir, { recursive: true });
        }

        // 1. Download Assets
        console.log(`[Worker] [${job.id}] 📥 Downloading assets to ${workDir}...`);
        const audioPath = join(workDir, 'audio.mp3');
        const captionPath = join(workDir, 'captions.srt');
        const imagePaths = assets.images.map((_, i) => join(workDir, `image_${i}.jpg`));

        await Promise.all([
            storage.downloadToFile(assets.audio, audioPath),
            storage.downloadToFile(assets.caption, captionPath),
            ...assets.images.map((id, i) => storage.downloadToFile(id, imagePaths[i]!))
        ]);
        console.log(`[Worker] [${job.id}] ✅ Assets downloaded.`);
        logMemory('Post-Download');

        // 2. Process Video
        console.log(`[Worker] [${job.id}] 🎬 Processing video with FFmpeg (preset: ${options.preset})...`);
        const outputPath = join(workDir, 'output.mp4');
        await processor.process({
            assetPaths: imagePaths,
            audioPath,
            captionPath,
            preset: options.preset,
            rendering_hints: options.rendering_hints,
            outputPath
        });
        console.log(`[Worker] [${job.id}] ✅ Video processed successfully.`);
        logMemory('Post-Process');

        // 3. Upload Result
        console.log(`[Worker] [${job.id}] 📤 Uploading final video...`);
        const resultBlobId = `users/${userId}/media/${mediaId}/video/render/final_render.mp4`;
        await storage.upload(resultBlobId, createReadStream(outputPath));

        // 4. Update Database
        console.log(`[Worker] [${job.id}] 💾 Finalizing job in database...`);
        await db.addAsset(mediaId, 'video', resultBlobId);
        await db.updateStepStatus(stepId, 'success', resultBlobId);

        console.log(`[Worker] ✨ Job ${job.id} completed successfully!`);
    } catch (error: any) {
        console.error(`[Worker] ❌ Job ${job.id} failed:`, error.message);
        console.error(error.stack);
        try {
            await db.updateStepStatus(stepId, 'failed', undefined, error.message);
        } catch (dbErr) {
            console.error(`[Worker] 💀 Critical: Failed to update error status in DB:`, dbErr);
        }
        throw error;
    } finally {
        try {
            if (existsSync(workDir)) {
                rmSync(workDir, { recursive: true, force: true });
            }
        } catch (cleanupErr) {
            console.error(`[Worker] ⚠️ Cleanup failed for ${workDir}:`, cleanupErr);
        }
        logMemory('Job Cleanup');
    }
}, {
    connection: {
        url: process.env.REDIS_URL as string,
    },
    concurrency: 1,
});

worker.on('ready', () => {
    console.log('🚀 Render Worker is ready and waiting for jobs...');
});

worker.on('failed', (job, err) => {
    console.error(`[Queue] Job ${job?.id} failed globally: ${err.message}`);
});

// Initialize DB connection
db.connect().then(() => {
    console.log('Connected to database');
}).catch(err => {
    console.error('Database connection failed:', err);
    process.exit(1);
});

// Periodic Health Check Ping to Backend
const API_BASE_URL = process.env.API_BASE_URL || 'https://ai-gen-reels-backend.onrender.com';
setInterval(async () => {
    try {
        const response = await fetch(`${API_BASE_URL}/health`);
        if (response.ok) {
            // console.log(`[Health] Ping to backend successful: ${response.status}`);
        } else {
            console.warn(`[Health] Ping to backend returned status: ${response.status}`);
        }
    } catch (error: any) {
        console.error(`[Health] Failed to ping backend: ${error.message}`);
    }
}, 5000);

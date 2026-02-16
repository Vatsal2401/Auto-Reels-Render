import { Worker, Job } from 'bullmq';
import { StorageService } from './storage.js';
import { DbService } from './db.js';
import { VideoProcessor } from './processor.js';
import { MailService } from './mail.js';
import { finalizeRenderSuccess } from './finalize.js';
import { runRemotionRender } from './remotion-render.js';
import type { RemotionJobPayload } from './remotion-render.js';
import { runKineticRemotionRender } from './remotion-kinetic-render.js';
import type { KineticJobPayload } from './remotion-kinetic-render.js';
import { join } from 'path';
import { mkdirSync, rmSync, existsSync, createReadStream } from 'fs';
import { tmpdir } from 'os';
import 'dotenv/config';

export interface RenderJobPayload {
    mediaId: string;
    stepId: string;
    userId: string;
    assets: {
        audio: string;
        caption: string;
        images: string[];
        music?: string;
    };
    options: {
        preset: string;
        rendering_hints?: Record<string, unknown>;
    };
    monetization?: { watermark: { enabled: boolean; type: 'text' | 'image'; value?: string } };
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
const mailer = new MailService();

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
        const captionExt = assets.caption.endsWith('.ass') ? 'ass' : assets.caption.endsWith('.json') ? 'json' : 'srt';
        const captionPath = join(workDir, `captions.${captionExt}`);
        const imagePaths = assets.images.map((_, i) => join(workDir, `image_${i}.jpg`));
        const musicPath = assets.music ? join(workDir, 'music.mp3') : undefined;

        await Promise.all([
            storage.downloadToFile(assets.audio, audioPath),
            storage.downloadToFile(assets.caption, captionPath),
            ...assets.images.map((id, i) => storage.downloadToFile(id, imagePaths[i]!)),
            ...(assets.music && musicPath ? [storage.downloadToFile(assets.music, musicPath)] : [])
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
            outputPath,
            musicPath,
            musicVolume: typeof options.rendering_hints?.musicVolume === 'number' ? options.rendering_hints.musicVolume : undefined,
            watermark: job.data.monetization?.watermark,
        });
        console.log(`[Worker] [${job.id}] ✅ Video processed successfully.`);
        logMemory('Post-Process');

        // 3. Upload Result
        console.log(`[Worker] [${job.id}] 📤 Uploading final video...`);
        const resultBlobId = `users/${userId}/media/${mediaId}/video/render/final_render.mp4`;
        await storage.upload(resultBlobId, createReadStream(outputPath));

        // 4 & 5. Idempotent finalization (step, media, credits, email)
        console.log(`[Worker] [${job.id}] 💾 Finalizing (idempotent)...`);
        await finalizeRenderSuccess({
            mediaId,
            stepId,
            resultBlobId,
            db,
            mailer,
            storage: { getSignedUrl: (id, exp) => storage.getSignedUrl(id, exp) },
        });

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
    concurrency: parseInt(process.env.FFMPEG_WORKER_CONCURRENCY ?? '2', 10) || 2,
});

const remotionWorker = new Worker<RemotionJobPayload>(
    'remotion-render-tasks',
    async (job: Job<RemotionJobPayload>) => {
        const { mediaId, stepId, userId, assets, options } = job.data;
        console.log(`[Remotion] 🚀 Starting job ${job.id} for media ${mediaId} (User: ${userId})`);
        try {
            await runRemotionRender({
                payload: job.data,
                storage,
                db,
                mailer,
            });
            console.log(`[Remotion] ✨ Job ${job.id} completed successfully!`);
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            console.error(`[Remotion] ❌ Job ${job.id} failed:`, msg);
            try {
                await db.updateStepStatus(stepId, 'failed', undefined, msg);
            } catch (dbErr) {
                console.error(`[Remotion] Failed to update step status:`, dbErr);
            }
            throw error;
        }
    },
    {
        connection: {
            url: process.env.REDIS_URL as string,
        },
        concurrency: parseInt(process.env.REMOTION_WORKER_CONCURRENCY ?? '1', 10) || 1,
    },
);

worker.on('ready', () => {
    const redisUrl = process.env.REDIS_URL || 'unknown';
    const obfuscatedUrl = redisUrl.replace(/:[^:@]*@/, ':****@');
    console.log(`🚀 Render Worker is ready and waiting for jobs on ${obfuscatedUrl}`);
});

worker.on('failed', (job, err) => {
    console.error(`[Queue] render-tasks job ${job?.id} failed globally: ${err.message}`);
});

remotionWorker.on('ready', () => {
    console.log(`[Remotion] Worker ready for remotion-render-tasks`);
});

remotionWorker.on('failed', (job, err) => {
    console.error(`[Queue] remotion-render-tasks job ${job?.id} failed globally: ${err.message}`);
});

const kineticWorker = new Worker<KineticJobPayload>(
    'remotion-kinetic-typography-tasks',
    async (job: Job<KineticJobPayload>) => {
        const { projectId, userId } = job.data;
        console.log(`[Kinetic] 🚀 Starting job ${job.id} for project ${projectId} (User: ${userId})`);
        try {
            await runKineticRemotionRender({
                payload: job.data,
                storage,
                db,
                mailer,
            });
            console.log(`[Kinetic] ✨ Job ${job.id} completed successfully!`);
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            console.error(`[Kinetic] ❌ Job ${job.id} failed:`, msg);
            try {
                await db.updateProjectStatus(projectId, 'failed', msg);
            } catch (dbErr) {
                console.error(`[Kinetic] Failed to update project status:`, dbErr);
            }
            throw error;
        }
    },
    {
        connection: {
            url: process.env.REDIS_URL as string,
        },
        concurrency: parseInt(process.env.REMOTION_KINETIC_WORKER_CONCURRENCY ?? '1', 10) || 1,
    },
);

kineticWorker.on('ready', () => {
    console.log(`[Kinetic] Worker ready for remotion-kinetic-typography-tasks`);
});

kineticWorker.on('failed', (job, err) => {
    console.error(`[Queue] remotion-kinetic-typography-tasks job ${job?.id} failed globally: ${err.message}`);
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

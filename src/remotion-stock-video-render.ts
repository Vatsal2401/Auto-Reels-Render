import { renderMediaOnLambda, getRenderProgress, presignUrl } from '@remotion/lambda';
import { Readable } from 'node:stream';
import type { StorageService } from './storage.js';
import type { DbService } from './db.js';
import type { MailService } from './mail.js';
import { finalizeRenderSuccess } from './finalize.js';
import type { WatermarkConfig } from './remotion-render.js';

const REMOTION_POLL_TIMEOUT_MS = 20 * 60 * 1000; // 20 minutes
const REMOTION_POLL_INTERVAL_MS = 3000;
const ASSET_SIGNED_URL_EXPIRES_SEC = 7200;
const FPS = 30;
const MIN_DURATION_FRAMES = 30 * FPS;
const MAX_ALLOWED_FRAMES = 60 * FPS;

export interface StockVideoJobPayload {
    mediaId: string;
    stepId: string;
    userId: string;
    assets: {
        audio: string;
        caption: string;
        /** blobIds of STOCK_VIDEO assets (may include IMAGE fallbacks) */
        stockVideos: string[];
        /** asset types parallel to stockVideos — 'stock_video' | 'image' */
        stockVideoTypes: string[];
        music?: string;
    };
    options: {
        preset: string;
        rendering_hints?: {
            width?: number;
            height?: number;
            captions?: unknown;
            language?: string;
            musicVolume?: number;
        };
    };
    monetization?: { watermark: WatermarkConfig };
}

export interface StockVideoRenderParams {
    payload: StockVideoJobPayload;
    storage: StorageService;
    db: DbService;
    mailer: MailService;
}

export type CaptionEntry = {
    start: number;
    end: number;
    text: string;
    words?: { start: number; end: number; text: string }[];
};

async function fetchCaptionEntries(captionUrl: string): Promise<CaptionEntry[]> {
    try {
        const res = await fetch(captionUrl);
        if (!res.ok) return [];
        const text = await res.text();
        if (captionUrl.endsWith('.json') || text.trimStart().startsWith('[')) {
            const data = JSON.parse(text);
            return Array.isArray(data) ? data : [];
        }
        return [];
    } catch {
        return [];
    }
}

export async function runStockVideoRemotionRender(params: StockVideoRenderParams): Promise<string> {
    const { payload, storage, db, mailer } = params;
    const { mediaId, stepId, userId, assets, options } = payload;

    const serveUrl = process.env.REMOTION_SERVE_URL;
    const functionName = process.env.REMOTION_LAMBDA_FUNCTION_NAME;
    const region = (process.env.REMOTION_LAMBDA_REGION || 'us-east-1') as import('@remotion/lambda').AwsRegion;
    const composition = process.env.REMOTION_STOCK_COMPOSITION_ID || 'StockVideoReelComposition';

    if (!serveUrl || !functionName) {
        throw new Error('REMOTION_SERVE_URL and REMOTION_LAMBDA_FUNCTION_NAME must be set');
    }

    const hints = options.rendering_hints ?? {};
    const width = hints.width ?? 720;
    const height = hints.height ?? 1280;
    const captionConfig = (hints.captions as Record<string, unknown>) ?? {};

    console.log(`[StockVideoRemotion] Building signed URLs for media ${mediaId} (${assets.stockVideos.length} clips)...`);

    const [audioUrl, captionUrl] = await Promise.all([
        storage.getSignedUrl(assets.audio, ASSET_SIGNED_URL_EXPIRES_SEC),
        storage.getSignedUrl(assets.caption, ASSET_SIGNED_URL_EXPIRES_SEC),
    ]);

    // Build per-scene URL arrays: videoUrls for stock clips, imageUrls for AI fallbacks
    const videoUrls: string[] = [];
    const imageUrls: string[] = [];
    // sceneAssets maps sceneIndex → { type, url }
    const sceneAssets: { type: 'video' | 'image'; url: string }[] = [];

    for (let i = 0; i < assets.stockVideos.length; i++) {
        const blobId = assets.stockVideos[i]!;
        const assetType = assets.stockVideoTypes[i] ?? 'stock_video';
        const signedUrl = await storage.getSignedUrl(blobId, ASSET_SIGNED_URL_EXPIRES_SEC);

        if (assetType === 'stock_video') {
            videoUrls.push(signedUrl);
            sceneAssets.push({ type: 'video', url: signedUrl });
        } else {
            // IMAGE fallback
            imageUrls.push(signedUrl);
            sceneAssets.push({ type: 'image', url: signedUrl });
        }
    }

    console.log(`[StockVideoRemotion] ${videoUrls.length} video clips, ${imageUrls.length} image fallbacks`);

    const captionEntries = captionConfig.enabled !== false ? await fetchCaptionEntries(captionUrl) : [];

    // Estimate total duration from captions if available, otherwise use max allowed
    let totalDurationInFrames: number;
    if (captionEntries.length > 0) {
        const durationSec = Math.max(...captionEntries.map((e) => e.end)) + 1;
        totalDurationInFrames = Math.max(
            MIN_DURATION_FRAMES,
            Math.min(MAX_ALLOWED_FRAMES, Math.round(durationSec * FPS)),
        );
    } else {
        totalDurationInFrames = MAX_ALLOWED_FRAMES;
    }

    let musicUrl: string | undefined;
    if (assets.music) {
        const musicExists = await storage.objectExists(assets.music);
        if (musicExists) {
            musicUrl = await storage.getSignedUrl(assets.music, ASSET_SIGNED_URL_EXPIRES_SEC);
        } else {
            console.warn(`[StockVideoRemotion] Music asset not found, skipping for media ${mediaId}`);
        }
    }

    const watermark = payload.monetization?.watermark;
    const watermarkEnabled = Boolean(watermark?.enabled && watermark?.type === 'text' && watermark?.value);

    const inputProps = {
        audioUrl,
        captionUrl,
        captionEntries,
        captionConfig: {
            enabled: captionConfig.enabled !== false,
            preset: (captionConfig.preset as string) || 'karaoke-card',
            position: (captionConfig.position as string) || 'bottom',
            language: (captionConfig.language as string) ?? (hints.language as string),
        },
        sceneAssets,
        musicUrl,
        width,
        height,
        musicVolume: hints.musicVolume ?? 0.2,
        totalDurationInFrames,
        watermark: {
            enabled: watermarkEnabled,
            type: 'text' as const,
            value: watermark?.value ?? 'Made with AutoReels',
        },
    };

    const framesPerLambda = parseInt(process.env.REMOTION_FRAMES_PER_LAMBDA ?? '200', 10) || 200;
    console.log(`[StockVideoRemotion] Invoking Lambda (${functionName}) for media ${mediaId}...`);

    const { renderId, bucketName } = await renderMediaOnLambda({
        region,
        functionName,
        serveUrl,
        composition,
        inputProps,
        codec: 'h264',
        imageFormat: 'jpeg',
        maxRetries: 1,
        outName: `render-${mediaId}.mp4`,
        framesPerLambda,
    });

    console.log(`[StockVideoRemotion] Lambda started renderId=${renderId}, polling...`);

    const deadline = Date.now() + REMOTION_POLL_TIMEOUT_MS;
    let pollCount = 0;

    while (Date.now() < deadline) {
        const progress = await getRenderProgress({
            renderId,
            bucketName,
            functionName,
            region,
        });

        if (progress.done) {
            const outKey = (progress as { outKey?: string }).outKey;
            const outputFile = progress.outputFile;
            const objectKey = outKey ?? (typeof outputFile === 'string' && !outputFile.startsWith('http') ? outputFile : undefined);
            if (!objectKey) {
                throw new Error('Remotion render finished but no output key');
            }

            console.log(`[StockVideoRemotion] Render done, downloading output...`);
            const downloadUrl = await presignUrl({
                region,
                bucketName,
                objectKey,
                expiresInSeconds: 900,
            });

            const maxDownloadAttempts = 3;
            const downloadDelayMs = 2000;
            let response: Response | null = null;
            for (let attempt = 1; attempt <= maxDownloadAttempts; attempt++) {
                response = await fetch(downloadUrl);
                if (response.ok) break;
                if (response.status === 404 && attempt < maxDownloadAttempts) {
                    console.warn(`[StockVideoRemotion] Download attempt ${attempt} got 404, retrying...`);
                    await new Promise((r) => setTimeout(r, downloadDelayMs));
                } else {
                    break;
                }
            }
            if (!response || !response.ok) {
                throw new Error(`Failed to download render: ${response?.status ?? 'unknown'}`);
            }

            const buffer = Buffer.from(await response.arrayBuffer());
            const nodeStream = Readable.from(buffer);
            const resultBlobId = `users/${userId}/media/${mediaId}/video/render/final_render.mp4`;
            await storage.upload(resultBlobId, nodeStream);

            await finalizeRenderSuccess({
                mediaId,
                stepId,
                resultBlobId,
                db,
                mailer,
                storage,
            });
            return resultBlobId;
        }

        if (progress.fatalErrorEncountered) {
            const errMsg = (progress as { errorMessage?: string }).errorMessage || 'Remotion render failed';
            console.error('[StockVideoRemotion] Lambda reported fatal error:', errMsg);
            throw new Error(errMsg);
        }

        pollCount += 1;
        const overall = (progress as { overallProgress?: number }).overallProgress;
        if (pollCount === 1 || pollCount % 10 === 0) {
            console.log(`[StockVideoRemotion] Poll #${pollCount}${typeof overall === 'number' ? ` progress=${Math.round(overall * 100)}%` : ''}`);
        }
        await new Promise((r) => setTimeout(r, REMOTION_POLL_INTERVAL_MS));
    }

    throw new Error('Stock video Remotion render timeout (20 minutes)');
}

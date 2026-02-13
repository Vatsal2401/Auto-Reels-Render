import { renderMediaOnLambda, getRenderProgress, presignUrl } from '@remotion/lambda';
import { Readable } from 'node:stream';
import type { StorageService } from './storage.js';
import type { DbService } from './db.js';
import type { MailService } from './mail.js';
import { finalizeRenderSuccess } from './finalize.js';

const REMOTION_POLL_TIMEOUT_MS = 20 * 60 * 1000; // 20 minutes
const REMOTION_POLL_INTERVAL_MS = 3000;
const ASSET_SIGNED_URL_EXPIRES_SEC = 7200; // 2 hours for Lambda to fetch assets

export interface RemotionJobPayload {
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
        rendering_hints?: {
            width?: number;
            height?: number;
            captions?: unknown;
            musicVolume?: number;
        };
    };
}

export interface RemotionRenderParams {
    payload: RemotionJobPayload;
    storage: StorageService;
    db: DbService;
    mailer: MailService;
}

export async function runRemotionRender(params: RemotionRenderParams): Promise<string> {
    const { payload, storage, db, mailer } = params;
    const { mediaId, stepId, userId, assets, options } = payload;

    const serveUrl = process.env.REMOTION_SERVE_URL;
    const functionName = process.env.REMOTION_LAMBDA_FUNCTION_NAME;
    const region = (process.env.REMOTION_LAMBDA_REGION || 'us-east-1') as import('@remotion/lambda').AwsRegion;
    const composition = process.env.REMOTION_COMPOSITION_ID || 'ReelComposition';

    if (!serveUrl || !functionName) {
        throw new Error('REMOTION_SERVE_URL and REMOTION_LAMBDA_FUNCTION_NAME must be set');
    }

    const hints = options.rendering_hints ?? {};
    const width = hints.width ?? 720;
    const height = hints.height ?? 1280;

    const [audioUrl, captionUrl, ...imageUrls] = await Promise.all([
        storage.getSignedUrl(assets.audio, ASSET_SIGNED_URL_EXPIRES_SEC),
        storage.getSignedUrl(assets.caption, ASSET_SIGNED_URL_EXPIRES_SEC),
        ...assets.images.map((id) => storage.getSignedUrl(id, ASSET_SIGNED_URL_EXPIRES_SEC)),
    ]);

    let musicUrl: string | undefined;
    if (assets.music) {
        musicUrl = await storage.getSignedUrl(assets.music, ASSET_SIGNED_URL_EXPIRES_SEC);
    }

    const inputProps = {
        audioUrl,
        captionUrl,
        imageUrls,
        musicUrl,
        width,
        height,
        captions: hints.captions ?? {},
        musicVolume: hints.musicVolume ?? 0.2,
    };

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
    });

    const deadline = Date.now() + REMOTION_POLL_TIMEOUT_MS;

    while (Date.now() < deadline) {
        const progress = await getRenderProgress({
            renderId,
            bucketName,
            functionName,
            region,
        });

        if (progress.done) {
            if (progress.outputFile === undefined || progress.outputFile === null) {
                throw new Error('Remotion render finished but no output file');
            }
            const downloadUrl = await presignUrl({
                region,
                bucketName,
                objectKey: progress.outputFile,
                expiresInSeconds: 900,
            });

            // Download from Remotion Lambda's S3 (temporary); then upload to app storage
            // (Supabase or S3 per CURRENT_BLOB_STORAGE). User-facing URL always comes from
            // app storage via backend getSignedUrl(blob_storage_id).
            const response = await fetch(downloadUrl);
            if (!response.ok) {
                throw new Error(`Failed to download render: ${response.status}`);
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
            throw new Error(errMsg);
        }

        await new Promise((r) => setTimeout(r, REMOTION_POLL_INTERVAL_MS));
    }

    throw new Error('Remotion render timeout (20 minutes)');
}

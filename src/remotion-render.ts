import { renderMediaOnLambda, getRenderProgress, presignUrl } from '@remotion/lambda';
import { Readable } from 'node:stream';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync, existsSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { StorageService } from './storage.js';
import type { DbService } from './db.js';
import type { MailService } from './mail.js';
import { finalizeRenderSuccess } from './finalize.js';
import { runBeatSync } from './beat-sync/index.js';
import { buildScenes } from './engines/PacingEngine.js';

const REMOTION_POLL_TIMEOUT_MS = 20 * 60 * 1000; // 20 minutes
const REMOTION_POLL_INTERVAL_MS = 3000;
const ASSET_SIGNED_URL_EXPIRES_SEC = 7200; // 2 hours for Lambda to fetch assets
const FPS = 30;
const MIN_DURATION_FRAMES = 30 * FPS;
const MAX_ALLOWED_FRAMES = 60 * FPS;
const CAPTION_DURATION_BUFFER_SEC = 1;

export type CaptionEntry = {
    start: number;
    end: number;
    text: string;
    words?: { start: number; end: number; text: string }[];
};

function parseSrt(body: string): CaptionEntry[] {
    const entries: CaptionEntry[] = [];
    const blocks = body.trim().split(/\n\s*\n/);
    for (const block of blocks) {
        const lines = block.trim().split('\n');
        if (lines.length < 2) continue;
        const match = lines[1]!.match(/(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/);
        if (!match || !match[1]) continue;
        const start = parseInt(match[1], 10) * 3600 + parseInt(match[2]!, 10) * 60 + parseInt(match[3]!, 10) + parseInt(match[4]!, 10) / 1000;
        const end = parseInt(match[5]!, 10) * 3600 + parseInt(match[6]!, 10) * 60 + parseInt(match[7]!, 10) + parseInt(match[8]!, 10) / 1000;
        const text = lines.slice(2).join(' ').trim();
        if (text) entries.push({ start, end, text });
    }
    return entries;
}

async function fetchCaptionEntries(captionUrl: string): Promise<CaptionEntry[]> {
    try {
        const res = await fetch(captionUrl);
        if (!res.ok) return [];
        const text = await res.text();
        if (captionUrl.endsWith('.json') || text.trimStart().startsWith('[')) {
            const data = JSON.parse(text);
            return Array.isArray(data) ? data : [];
        }
        return parseSrt(text);
    } catch {
        return [];
    }
}

export type PacingStyle = 'smooth' | 'rhythmic' | 'viral' | 'dramatic';

export interface PacingSceneInput {
    durationInFrames: number;
    imageUrl: string;
    imageIndex: number;
}

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
            motion_preset?: string;
            motion_presets?: string[];
            motion_emotion?: string;
            pacing_style?: PacingStyle;
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

    const imageCount = assets.images?.length ?? 0;
    const defaultPresetList = ['kenBurns', 'cinematicZoom', 'documentarySlowPan'];
    let motionPresets: string[];
    if (Array.isArray(hints.motion_presets) && hints.motion_presets.length > 0) {
        const list = hints.motion_presets as string[];
        motionPresets = Array.from({ length: Math.max(imageCount, 1) }, (_, i) => list[i % list.length] ?? defaultPresetList[0]!);
    } else if (typeof hints.motion_preset === 'string' && hints.motion_preset) {
        motionPresets = Array.from({ length: Math.max(imageCount, 1) }, () => hints.motion_preset as string);
    } else {
        motionPresets = Array.from({ length: Math.max(imageCount, 1) }, (_, i) => defaultPresetList[i % defaultPresetList.length] ?? defaultPresetList[0]!);
    }

    const motionEmotion = typeof hints.motion_emotion === 'string' && hints.motion_emotion
        ? hints.motion_emotion
        : undefined;

    const pacingStyle: PacingStyle = (hints.pacing_style === 'rhythmic' || hints.pacing_style === 'viral' || hints.pacing_style === 'dramatic')
        ? hints.pacing_style
        : 'smooth';

    const transitionOverlapByStyle: Record<PacingStyle, number> = {
        smooth: 20,
        rhythmic: 16,
        viral: 12,
        dramatic: 16,
    };
    const transitionOverlap = transitionOverlapByStyle[pacingStyle];

    console.log(`[Remotion] Building signed URLs for media ${mediaId} (audio, caption, ${imageCount} images)...`);
    const [audioUrl, captionUrl, ...imageUrlsRaw] = await Promise.all([
        storage.getSignedUrl(assets.audio, ASSET_SIGNED_URL_EXPIRES_SEC),
        storage.getSignedUrl(assets.caption, ASSET_SIGNED_URL_EXPIRES_SEC),
        ...(assets.images ?? []).map((id) => storage.getSignedUrl(id, ASSET_SIGNED_URL_EXPIRES_SEC)),
    ]);
    const imageUrls: string[] = imageUrlsRaw.filter((u): u is string => typeof u === 'string');
    console.log(`[Remotion] Signed URLs ready, preparing input props...`);

    let pacingScenes: PacingSceneInput[] | undefined;
    let totalDurationInFrames: number | undefined;
    let beatFrames: number[] | undefined;
    let strongBeatFrames: number[] | undefined;

    const captionConfig = (hints.captions as Record<string, unknown>) ?? {};
    let captionEntries: CaptionEntry[] = captionConfig.enabled !== false ? await fetchCaptionEntries(captionUrl) : [];

    // Build scenes: for smooth pacing use caption duration when available to skip audio download
    if (assets.audio && imageCount > 0 && imageUrls.length > 0) {
        const isSmoothWithCaptions = pacingStyle === 'smooth' && captionEntries.length > 0;
        if (isSmoothWithCaptions) {
            const durationSec = Math.max(...captionEntries.map((e) => e.end)) + CAPTION_DURATION_BUFFER_SEC;
            totalDurationInFrames = Math.max(
                MIN_DURATION_FRAMES,
                Math.min(MAX_ALLOWED_FRAMES, Math.round(durationSec * FPS))
            );
            beatFrames = [];
            strongBeatFrames = [];
            const built = buildScenes({
                imageUrls,
                totalDurationInFrames,
                cutFrames: [],
                pacingStyle,
                transitionOverlapFrames: transitionOverlap,
            });
            if (built.length > 0) {
                pacingScenes = built;
                console.log(`[Remotion] ${pacingScenes.length} scenes from caption duration (smooth, no audio), ~${Math.round((pacingScenes[0]?.durationInFrames ?? 0) / 30)}s per image`);
            }
        } else {
            console.log(`[Remotion] Getting duration and building scenes (equal split by video length)...`);
            const workDir = join(tmpdir(), `remotion-pacing-${mediaId}-${randomUUID()}`);
            if (!existsSync(workDir)) mkdirSync(workDir, { recursive: true });
            try {
                const audioPath = join(workDir, 'audio.mp3');
                await storage.downloadToFile(assets.audio, audioPath);
                const result = await runBeatSync({
                    audioPath,
                    pacingStyle,
                    imageCount,
                });
                totalDurationInFrames = result.totalDurationInFrames;
                beatFrames = result.beatFrames;
                strongBeatFrames = result.strongBeatFrames;
                const built = buildScenes({
                    imageUrls,
                    totalDurationInFrames: result.totalDurationInFrames,
                    cutFrames: result.cutFrames,
                    pacingStyle,
                    transitionOverlapFrames: transitionOverlap,
                });
                if (built.length > 0) {
                    pacingScenes = built;
                    console.log(`[Remotion] ${pacingScenes.length} scenes, ~${Math.round((pacingScenes[0]?.durationInFrames ?? 0) / 30)}s per image`);
                }
            } finally {
                try {
                    if (existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
                } catch {
                    // ignore cleanup
                }
            }
        }
    }

    let musicUrl: string | undefined;
    if (assets.music) {
        const musicExists = await storage.objectExists(assets.music);
        if (musicExists) {
            musicUrl = await storage.getSignedUrl(assets.music, ASSET_SIGNED_URL_EXPIRES_SEC);
        } else {
            console.warn(`[Remotion] Music asset not found in current storage (likely in Supabase), skipping background music for media ${mediaId}`);
        }
    }

    const inputProps = {
        audioUrl,
        captionUrl,
        captionEntries,
        captionConfig: {
            enabled: captionConfig.enabled !== false,
            preset: (captionConfig.preset as string) || 'karaoke-card',
            position: (captionConfig.position as string) || 'bottom',
        },
        imageUrls,
        musicUrl,
        width,
        height,
        captions: hints.captions ?? {},
        musicVolume: hints.musicVolume ?? 0.2,
        motionPresets,
        ...(motionEmotion ? { motionEmotion } : {}),
        pacingStyle,
        transitionOverlap,
        ...(pacingScenes ? {
            scenes: pacingScenes,
            totalDurationInFrames,
            beatFrames: beatFrames ?? [],
            strongBeatFrames: strongBeatFrames ?? [],
        } : {}),
    };

    // Use higher framesPerLambda to reduce concurrent Lambda invocations (avoids "Rate Exceeded" on low account limits)
    const framesPerLambda = parseInt(process.env.REMOTION_FRAMES_PER_LAMBDA ?? '200', 10) || 200;
    console.log(`[Remotion] Invoking Lambda (${functionName}) for media ${mediaId} (framesPerLambda=${framesPerLambda})...`);
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
    console.log(`[Remotion] Lambda started renderId=${renderId}, polling progress every ${REMOTION_POLL_INTERVAL_MS / 1000}s...`);

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
            // Remotion: outputFile can be a URL; outKey is the S3 key. presignUrl() requires the key, not a URL.
            const outKey = (progress as { outKey?: string }).outKey;
            const outputFile = progress.outputFile;
            const objectKey = outKey ?? (typeof outputFile === 'string' && !outputFile.startsWith('http') ? outputFile : undefined);
            if (!objectKey) {
                throw new Error('Remotion render finished but no output key (outKey or non-URL outputFile)');
            }
            console.log(`[Remotion] Render done, downloading output (bucket=${bucketName}, key=${objectKey}) and uploading to storage...`);
            const downloadUrl = await presignUrl({
                region,
                bucketName,
                objectKey,
                expiresInSeconds: 900,
            });

            // Download from Remotion Lambda's S3 (temporary). Retry a few times for S3 eventual consistency.
            const maxDownloadAttempts = 3;
            const downloadDelayMs = 2000;
            let response: Response | null = null;
            for (let attempt = 1; attempt <= maxDownloadAttempts; attempt++) {
                response = await fetch(downloadUrl);
                if (response.ok) break;
                if (response.status === 404 && attempt < maxDownloadAttempts) {
                    console.warn(`[Remotion] Download attempt ${attempt} got 404, retrying in ${downloadDelayMs / 1000}s...`);
                    await new Promise((r) => setTimeout(r, downloadDelayMs));
                } else {
                    break;
                }
            }
            if (!response || !response.ok) {
                throw new Error(
                    `Failed to download render: ${response?.status ?? 'unknown'}. ` +
                    `Ensure your AWS user has s3:GetObject on the Remotion bucket (${bucketName}).`
                );
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
            const errors = (progress as { errors?: unknown[] }).errors;
            console.error('[Remotion] Lambda reported fatal error:', errMsg);
            if (errors?.length) console.error('[Remotion] Errors detail:', JSON.stringify(errors, null, 2));
            throw new Error(errMsg);
        }

        pollCount += 1;
        const overall = (progress as { overallProgress?: number }).overallProgress;
        if (pollCount === 1 || pollCount % 10 === 0 || (typeof overall === 'number' && overall >= 0)) {
            console.log(`[Remotion] Poll #${pollCount}${typeof overall === 'number' ? ` progress=${Math.round(overall * 100)}%` : ''}`);
        }
        await new Promise((r) => setTimeout(r, REMOTION_POLL_INTERVAL_MS));
    }

    throw new Error('Remotion render timeout (20 minutes)');
}

import { renderMediaOnLambda, getRenderProgress, presignUrl } from '@remotion/lambda';
import { Readable } from 'node:stream';
import type { StorageService } from './storage.js';
import type { DbService } from './db.js';
import type { MailService } from './mail.js';
import { finalizeProjectSuccess } from './finalize.js';

const REMOTION_POLL_TIMEOUT_MS = 20 * 60 * 1000; // 20 minutes
const REMOTION_POLL_INTERVAL_MS = 3000;
const DEFAULT_COMPOSITION_ID = 'KineticTypographyComposition';

/** Ensure each scene has words (array), rhythm, transitionIn so Remotion never hits undefined. */
function normalizeGraphicScenes(raw: unknown[]): unknown[] {
    return raw.map((s) => {
        const scene = s && typeof s === 'object' ? (s as Record<string, unknown>) : {};
        const text = typeof scene.text === 'string' ? scene.text : '';
        const words = Array.isArray(scene.words) && scene.words.length > 0
            ? scene.words
            : text.split(/\s+/).filter(Boolean);
        const rhythm = scene.rhythm && typeof scene.rhythm === 'object' && scene.rhythm !== null
            ? scene.rhythm
            : { entryFrames: 30, holdFrames: 60, exitFrames: 15, totalFrames: 105 };
        const transitionIn = scene.transitionIn && typeof scene.transitionIn === 'object' && scene.transitionIn !== null
            ? scene.transitionIn
            : { transitionType: 'fade', transitionDuration: 0 };
        return { ...scene, text, words, rhythm, transitionIn };
    });
}

export interface KineticJobPayload {
    projectId: string;
    userId: string;
    compositionId?: string;
    monetization?: { watermark: { enabled: boolean; type: 'text' | 'image'; value?: string } };
    inputProps: {
        timeline?: Array<{
            text: string;
            words: string[];
            durationInFrames: number;
            animationPreset: string;
            highlightWordIndices?: number[];
        }>;
        graphicMotionTimeline?: unknown;
        width: number;
        height: number;
        fps?: number;
        fontFamily?: string;
    };
    /** Background music: blob storage id for worker to resolve to signed URL. */
    musicBlobId?: string;
    /** Background music volume 0–1. */
    musicVolume?: number;
}

export interface KineticRenderParams {
    payload: KineticJobPayload;
    storage: StorageService;
    db: DbService;
    mailer: MailService;
}

export async function runKineticRemotionRender(params: KineticRenderParams): Promise<string> {
    const { payload, storage, db, mailer } = params;
    const { projectId, userId, inputProps: rawInputProps } = payload;

    if (!rawInputProps || typeof rawInputProps !== 'object') {
        throw new Error('Kinetic job missing inputProps');
    }
    const inputProps = rawInputProps as KineticJobPayload['inputProps'];

    const serveUrl = process.env.REMOTION_SERVE_URL;
    const functionName = process.env.REMOTION_LAMBDA_FUNCTION_NAME;
    const region = (process.env.REMOTION_LAMBDA_REGION || 'us-east-1') as import('@remotion/lambda').AwsRegion;

    if (!serveUrl || !functionName) {
        throw new Error('REMOTION_SERVE_URL and REMOTION_LAMBDA_FUNCTION_NAME must be set');
    }

    const width = inputProps.width ?? 1080;
    const height = inputProps.height ?? 1920;
    const compositionId = payload.compositionId ?? DEFAULT_COMPOSITION_ID;
    const hasGraphicMotion = inputProps.graphicMotionTimeline != null && typeof inputProps.graphicMotionTimeline === 'object';
    const rawTimeline = hasGraphicMotion ? (inputProps.graphicMotionTimeline as { scenes?: unknown[]; width?: number; height?: number; fps?: number; fontFamily?: string; templateStyle?: string; styleConfig?: unknown }) : null;
    const rawScenes = rawTimeline?.scenes;
    const graphicScenes = Array.isArray(rawScenes) ? normalizeGraphicScenes(rawScenes) : undefined;
    const isGraphicMotion = Boolean(hasGraphicMotion && graphicScenes && graphicScenes.length > 0);

    const legacyTimeline = Array.isArray(inputProps.timeline) ? inputProps.timeline : undefined;
    const useLegacy = !isGraphicMotion && legacyTimeline && legacyTimeline.length > 0;

    const effectiveCompositionId = isGraphicMotion ? compositionId : (useLegacy ? DEFAULT_COMPOSITION_ID : compositionId);
    if (!isGraphicMotion && !useLegacy) {
        throw new Error(
            'Kinetic job has no valid timeline: need either graphicMotionTimeline.scenes (array) or timeline (array)',
        );
    }

    const blockCount = isGraphicMotion
        ? (graphicScenes as unknown[]).length
        : (legacyTimeline?.length ?? 0);
    console.log(`[Kinetic] Invoking Lambda for project ${projectId} (${effectiveCompositionId}, ${blockCount} scenes/blocks)...`);
    const framesPerLambda = parseInt(process.env.REMOTION_FRAMES_PER_LAMBDA ?? '200', 10) || 200;

    const graphicMotionTimelinePayload = isGraphicMotion && rawTimeline
        ? { ...rawTimeline, scenes: graphicScenes }
        : inputProps.graphicMotionTimeline;

    const ASSET_SIGNED_URL_EXPIRES_SEC = 3600;
    let musicUrl: string | undefined;
    let musicVolume: number | undefined;
    if (payload.musicBlobId) {
        try {
            const exists = await storage.objectExists(payload.musicBlobId);
            if (exists) {
                musicUrl = await storage.getSignedUrl(payload.musicBlobId, ASSET_SIGNED_URL_EXPIRES_SEC);
                musicVolume = typeof payload.musicVolume === 'number' ? payload.musicVolume : 0.2;
                console.log(`[Kinetic] Background music: volume=${musicVolume}`);
            } else {
                console.warn(`[Kinetic] Music blob not found in storage, skipping background music`);
            }
        } catch (err) {
            console.warn(`[Kinetic] Failed to get music signed URL:`, err);
        }
    }

    const watermark = payload.monetization?.watermark;
    const watermarkEnabled = Boolean(watermark?.enabled && watermark?.type === 'text' && watermark?.value);

    const lambdaInputProps = isGraphicMotion
        ? {
            graphicMotionTimeline: graphicMotionTimelinePayload,
            width,
            height,
            fps: inputProps.fps ?? 30,
            fontFamily: inputProps.fontFamily,
            ...(musicUrl && { musicUrl, musicVolume: musicVolume ?? 0.2 }),
            watermark: {
                enabled: watermarkEnabled,
                type: 'text' as const,
                value: watermark?.value ?? 'Made with AutoReels',
            },
        }
        : {
            timeline: legacyTimeline,
            width,
            height,
            fps: inputProps.fps ?? 30,
            fontFamily: inputProps.fontFamily,
            ...(musicUrl && { musicUrl, musicVolume: musicVolume ?? 0.2 }),
            watermark: {
                enabled: watermarkEnabled,
                type: 'text' as const,
                value: watermark?.value ?? 'Made with AutoReels',
            },
        };

    const { renderId, bucketName } = await renderMediaOnLambda({
        region,
        functionName,
        serveUrl,
        composition: effectiveCompositionId,
        inputProps: lambdaInputProps,
        codec: 'h264',
        imageFormat: 'jpeg',
        maxRetries: 1,
        outName: `kinetic-${projectId}.mp4`,
        framesPerLambda,
    });

    console.log(`[Kinetic] Lambda started renderId=${renderId}, polling...`);
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
            const objectKey =
                outKey ?? (typeof outputFile === 'string' && !outputFile.startsWith('http') ? outputFile : undefined);
            if (!objectKey) {
                throw new Error('Remotion render finished but no output key');
            }

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
                    await new Promise((r) => setTimeout(r, downloadDelayMs));
                } else break;
            }
            if (!response || !response.ok) {
                throw new Error(`Failed to download render: ${response?.status ?? 'unknown'}`);
            }

            const buffer = Buffer.from(await response.arrayBuffer());
            const nodeStream = Readable.from(buffer);
            const resultBlobId = `users/${userId}/projects/${projectId}/output.mp4`;
            await storage.upload(resultBlobId, nodeStream);

            await finalizeProjectSuccess({
                projectId,
                resultBlobId,
                db,
                storage,
                mailer,
            });
            return resultBlobId;
        }

        if (progress.fatalErrorEncountered) {
            const errors = (progress as { errors?: Array<{ message?: string; stack?: string }> }).errors;
            const firstError = Array.isArray(errors) && errors.length > 0 ? errors[0] : null;
            const errMsg = firstError?.message ?? (progress as { errorMessage?: string }).errorMessage ?? 'Kinetic render failed';
            console.error('[Kinetic] Lambda fatal error:', errMsg);
            if (Array.isArray(errors) && errors.length > 0) {
                errors.forEach((e, i) => console.error(`[Kinetic] Lambda error[${i}]:`, e?.message ?? e));
            }
            throw new Error(errMsg);
        }

        pollCount += 1;
        const overall = (progress as { overallProgress?: number }).overallProgress;
        if (pollCount === 1 || pollCount % 10 === 0) {
            console.log(`[Kinetic] Poll #${pollCount}${typeof overall === 'number' ? ` progress=${Math.round(overall * 100)}%` : ''}`);
        }
        await new Promise((r) => setTimeout(r, REMOTION_POLL_INTERVAL_MS));
    }

    throw new Error('Kinetic Remotion render timeout (20 minutes)');
}

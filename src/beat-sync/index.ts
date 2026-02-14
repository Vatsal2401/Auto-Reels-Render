import type { PacingStyle } from './types.js';
import type { BeatSyncResult } from './types.js';
import { extractBeats, extractBeatsFallback, getAudioDurationSec } from './extractBeats.js';
import { detectStrongBeats } from './detectStrongBeats.js';
import { generateCutPoints } from './generateCutPoints.js';

const FPS = 30;
const MIN_DURATION_FRAMES = 30 * FPS; // 30s
const MAX_ALLOWED_FRAMES = 60 * FPS; // 60s
const DURATION_FALLBACK_SEC = 45;

export type { PacingStyle, BeatSyncResult };
export { extractBeats, extractBeatsFallback, getAudioDurationSec, detectStrongBeats, generateCutPoints };

export interface RunBeatSyncParams {
    audioPath: string;
    pacingStyle: PacingStyle;
    imageCount: number;
    fps?: number;
}

/**
 * Run beat extraction and cut point generation.
 * Returns beatFrames, strongBeatFrames, cutFrames (all in frame numbers).
 * If pacingStyle is smooth or beat extraction fails, returns empty arrays.
 * When ffprobe fails, uses a safe default duration and logs a warning.
 * totalDurationInFrames is clamped to [MIN_DURATION_FRAMES, MAX_ALLOWED_FRAMES].
 */
export async function runBeatSync(params: RunBeatSyncParams): Promise<BeatSyncResult & { totalDurationInFrames: number }> {
    const { audioPath, pacingStyle, imageCount, fps = FPS } = params;

    let durationSec = await getAudioDurationSec(audioPath);
    if (durationSec <= 0) {
        durationSec = DURATION_FALLBACK_SEC;
        console.warn(
            '[runBeatSync] ffprobe failed or returned invalid duration; using fallback',
            { audioPath, fallbackSec: DURATION_FALLBACK_SEC }
        );
    }
    let totalDurationInFrames = Math.round(durationSec * fps);
    totalDurationInFrames = Math.max(
        MIN_DURATION_FRAMES,
        Math.min(MAX_ALLOWED_FRAMES, totalDurationInFrames)
    );

    if (pacingStyle === 'smooth') {
        return {
            beatFrames: [],
            strongBeatFrames: [],
            cutFrames: [],
            totalDurationInFrames,
        };
    }

    const cappedDuration = totalDurationInFrames;

    let beatTimesSec = await extractBeats(audioPath);
    if (beatTimesSec.length === 0) {
        beatTimesSec = extractBeatsFallback(durationSec);
    }
    const beatFrames = beatTimesSec.map((t) => Math.round(t * fps));
    const strongBeatFrames = detectStrongBeats(beatFrames, {
        pacingStyle,
        fps,
        totalDurationInFrames: cappedDuration,
    });
    const cutFrames = generateCutPoints({
        beatFrames,
        strongBeatFrames,
        pacingStyle,
        imageCount,
        totalDurationInFrames: cappedDuration,
    });

    return {
        beatFrames,
        strongBeatFrames,
        cutFrames,
        totalDurationInFrames: cappedDuration,
    };
}

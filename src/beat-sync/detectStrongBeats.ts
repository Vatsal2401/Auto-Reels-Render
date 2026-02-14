import type { PacingStyle } from './types.js';

const DEFAULT_PERIOD = 4;
const MIN_STRONG_BEAT_INTERVAL_FRAMES = 60; // ~2s at 30fps
const MIN_PERIOD = 2;

export interface DetectStrongBeatsOptions {
    pacingStyle?: PacingStyle;
    fps?: number;
    totalDurationInFrames?: number;
}

/**
 * Strong beats = every period-th beat (e.g. 4/4 downbeats).
 * Period is pacing-aware (dramatic: 2, rhythmic/viral: 4) and reduced if beat count
 * is low so we get at least one strong beat every ~2s. Deterministic.
 */
export function detectStrongBeats(
    beatFrames: number[],
    options: DetectStrongBeatsOptions = {}
): number[] {
    const { pacingStyle, fps = 30, totalDurationInFrames } = options;
    let period = DEFAULT_PERIOD;
    if (pacingStyle === 'dramatic') period = 2;
    else if (pacingStyle === 'rhythmic' || pacingStyle === 'viral') period = 4;

    if (beatFrames.length < period) return [];

    const gaps: number[] = [];
    for (let i = 1; i < beatFrames.length; i++) {
        gaps.push(beatFrames[i]! - beatFrames[i - 1]!);
    }
    const medianGap =
        gaps.length > 0
            ? [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)] ?? 0
            : 0;
    const strongBeatInterval = period * medianGap;
    if (
        strongBeatInterval > MIN_STRONG_BEAT_INTERVAL_FRAMES &&
        period > MIN_PERIOD
    ) {
        period = MIN_PERIOD;
    }

    const out: number[] = [];
    for (let i = period - 1; i < beatFrames.length; i += period) {
        out.push(beatFrames[i]!);
    }
    return out;
}

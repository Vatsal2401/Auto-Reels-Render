import type { PacingStyle } from './types.js';

export interface GenerateCutPointsParams {
    beatFrames: number[];
    strongBeatFrames: number[];
    pacingStyle: PacingStyle;
    imageCount: number;
    totalDurationInFrames: number;
}

/**
 * Returns cut frame positions (boundaries between segments).
 * Always returns [] so every image gets equal screen time (equal split).
 * Beat data is still used in Remotion for punch/shake effects; only segment duration is equalized.
 */
export function generateCutPoints(_params: GenerateCutPointsParams): number[] {
    return [];
}

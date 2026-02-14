import type { PacingStyle } from '../beat-sync/types.js';

export interface PacingScene {
    durationInFrames: number;
    imageUrl: string;
    imageIndex: number;
}

export interface BuildScenesParams {
    imageUrls: string[];
    totalDurationInFrames: number;
    cutFrames: number[];
    pacingStyle: PacingStyle;
    transitionOverlapFrames: number;
}

/**
 * Build ordered scenes for TransitionSeries. No startFrame; TransitionSeries controls order.
 * If cutFrames empty: equal split. Else: segment from boundaries [0, ...cutFrames, totalDurationInFrames].
 */
export function buildScenes(params: BuildScenesParams): PacingScene[] {
    const {
        imageUrls,
        totalDurationInFrames,
        cutFrames,
        pacingStyle,
        transitionOverlapFrames,
    } = params;

    const imageCount = Math.max(1, imageUrls.length);
    const urls = imageUrls.length > 0 ? imageUrls : [''];

    if (cutFrames.length === 0) {
        const seqDuration = Math.floor(
            (totalDurationInFrames + (imageCount - 1) * transitionOverlapFrames) / imageCount
        );
        return urls.map((imageUrl, i) => ({
            durationInFrames: seqDuration,
            imageUrl,
            imageIndex: i,
        }));
    }

    const boundaries = [0, ...cutFrames.slice().sort((a, b) => a - b), totalDurationInFrames];
    const segments: number[] = [];
    for (let i = 0; i < boundaries.length - 1; i++) {
        const a = boundaries[i]!;
        const b = boundaries[i + 1]!;
        segments.push(Math.max(1, b - a));
    }

    const scenes: PacingScene[] = [];
    for (let i = 0; i < segments.length; i++) {
        const imageIndex = i % imageCount;
        scenes.push({
            durationInFrames: segments[i]!,
            imageUrl: urls[imageIndex]!,
            imageIndex,
        });
    }

    if (scenes.length < imageCount) {
        const last = scenes[scenes.length - 1];
        if (last) {
            const extendBy = (imageCount - scenes.length) * Math.floor(totalDurationInFrames / imageCount);
            last.durationInFrames += extendBy;
        }
    }

    return scenes;
}

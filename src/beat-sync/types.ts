export type PacingStyle = 'smooth' | 'rhythmic' | 'viral' | 'dramatic';

export interface BeatSyncResult {
    beatFrames: number[];
    strongBeatFrames: number[];
    cutFrames: number[];
}

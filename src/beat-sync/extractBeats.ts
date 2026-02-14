import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Extract beat timestamps in seconds from an audio file.
 * Uses aubio CLI if available; otherwise returns empty array (fallback to smooth).
 * Deterministic: same file yields same beats.
 */
export async function extractBeats(audioPath: string): Promise<number[]> {
    try {
        const result = await execFileAsync('aubio', ['beat', audioPath], {
            encoding: 'utf8',
            maxBuffer: 1024 * 1024,
            timeout: 60000,
        });
        const lines = (result.stdout ?? '').trim().split(/\n/);
        const beats: number[] = [];
        for (const line of lines) {
            const t = parseFloat(line.trim());
            if (Number.isFinite(t) && t >= 0) beats.push(t);
        }
        return beats;
    } catch {
        return [];
    }
}

/**
 * Fallback: generate a deterministic grid of "beats" from audio duration.
 * Interval derived from duration: ~2/s for short clips, slightly slower for long,
 * so fallback feels less mechanical than a fixed 0.5s grid. Used when aubio is unavailable.
 */
export function extractBeatsFallback(audioDurationSec: number): number[] {
    const sec = Math.max(1, audioDurationSec);
    const interval =
        sec < 20 ? 0.5 : sec < 45 ? 0.55 : sec < 90 ? 0.6 : 0.65;
    const beats: number[] = [];
    let t = 0;
    while (t < sec) {
        beats.push(t);
        t += interval;
    }
    return beats;
}

/**
 * Get audio duration in seconds via ffprobe. Returns 0 on failure.
 */
export async function getAudioDurationSec(audioPath: string): Promise<number> {
    try {
        const result = await execFileAsync(
            'ffprobe',
            ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', audioPath],
            { encoding: 'utf8', timeout: 10000 }
        );
        const out = (result.stdout ?? '').trim();
        const sec = parseFloat(out);
        return Number.isFinite(sec) && sec > 0 ? sec : 0;
    } catch {
        return 0;
    }
}

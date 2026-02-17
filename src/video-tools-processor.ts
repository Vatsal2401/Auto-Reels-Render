import { spawn } from 'child_process';
import { join } from 'path';
import { createReadStream, existsSync, mkdirSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import type { StorageService } from './storage.js';
import type { DbService } from './db.js';

const MAX_VIDEO_SIZE_BYTES = 100 * 1024 * 1024;
const FFMPEG_TIMEOUT_MS = 15 * 60 * 1000; // 15 min

export interface VideoToolsJobPayload {
  projectId: string;
  userId: string;
  inputBlobId: string;
  toolType: 'video-resize' | 'video-compress';
  options: VideoResizeOptions | VideoCompressOptions;
  outputFileName: string;
}

export interface VideoResizeOptions {
  width: number;
  height: number;
  fit: 'fill' | 'contain' | 'cover';
}

export interface VideoCompressOptions {
  width: number;
  height: number;
  crf: number;
  presetLabel: string;
}

function buildResizeFilter(w: number, h: number, fit: string): string {
  if (fit === 'fill') {
    return `scale=${w}:${h}`;
  }
  if (fit === 'contain') {
    return `scale='min(iw,${w})':min(ih,${h}):force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2`;
  }
  // cover
  return `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`;
}

function runFfmpegWithTimeout(
  args: string[],
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';

    ffmpeg.stderr?.on('data', (d) => {
      stderr += d.toString();
    });

    const timer = setTimeout(() => {
      ffmpeg.kill('SIGKILL');
      reject(new Error(`FFmpeg timeout after ${timeoutMs / 60000} minutes`));
    }, timeoutMs);

    ffmpeg.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg exited ${code}. ${stderr.slice(-500)}`));
    });

    ffmpeg.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

export async function runVideoToolsJob(
  payload: VideoToolsJobPayload,
  storage: StorageService,
  db: DbService,
): Promise<void> {
  const { projectId, userId, inputBlobId, toolType, options, outputFileName } = payload;
  const workDir = join(tmpdir(), `video-tools-${projectId}`);

  if (!existsSync(workDir)) {
    mkdirSync(workDir, { recursive: true });
  }

  const inputPath = join(workDir, 'input');
  const outputPath = join(workDir, 'output.mp4');

  try {
    await storage.downloadToFile(inputBlobId, inputPath);

    const stat = statSync(inputPath);
    if (stat.size > MAX_VIDEO_SIZE_BYTES) {
      throw new Error('Input file exceeds 100MB limit');
    }

    let args: string[];

    if (toolType === 'video-resize') {
      const opts = options as VideoResizeOptions;
      const w = Math.max(1, Math.min(4096, opts.width));
      const h = Math.max(1, Math.min(4096, opts.height));
      const vf = buildResizeFilter(w, h, opts.fit || 'contain');
      args = [
        '-y',
        '-i', inputPath,
        '-vf', vf,
        '-c:v', 'libx264',
        '-preset', 'fast',
        '-crf', '23',
        '-c:a', 'aac',
        '-movflags', '+faststart',
        outputPath,
      ];
    } else {
      const opts = options as VideoCompressOptions;
      const w = opts.width && opts.height ? Math.max(1, Math.min(4096, opts.width)) : 0;
      const h = opts.width && opts.height ? Math.max(1, Math.min(4096, opts.height)) : 0;
      const crf = Math.max(18, Math.min(28, opts.crf ?? 23));
      const scaleFilter = w && h
        ? `scale=${w}:${h}:force_original_aspect_ratio=decrease`
        : 'copy';
      args = [
        '-y',
        '-i', inputPath,
        ...(scaleFilter !== 'copy' ? ['-vf', scaleFilter] : []),
        '-c:v', 'libx264',
        '-preset', 'fast',
        '-crf', String(crf),
        '-c:a', 'aac',
        '-movflags', '+faststart',
        outputPath,
      ];
    }

    await runFfmpegWithTimeout(args, FFMPEG_TIMEOUT_MS);

    const resultBlobId = `users/${userId}/media/${projectId}/video/${outputFileName}`;
    const stream = createReadStream(outputPath);
    await storage.upload(resultBlobId, stream, 'video/mp4');

    const updated = await db.finalizeProjectOnlyIfNotCompleted(projectId, resultBlobId);
    if (!updated) {
      console.log(`[VideoTools] Project ${projectId} already finalized (idempotent)`);
    }
  } catch (error: any) {
    const msg = error?.message ?? String(error);
    await db.updateProjectStatus(projectId, 'failed', msg);
    throw error;
  } finally {
    try {
      if (existsSync(workDir)) {
        rmSync(workDir, { recursive: true, force: true });
      }
    } catch (e) {
      console.error(`[VideoTools] Cleanup failed for ${workDir}:`, e);
    }
  }
}

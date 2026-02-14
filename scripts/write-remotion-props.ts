#!/usr/bin/env node
/**
 * Build full Remotion input props (including pacing scenes) for a media ID and write to JSON.
 * Uses backend API for signed URLs, then runs beat sync + buildScenes (same as worker).
 *
 * Usage (from render-worker):
 *   BACKEND_URL=http://localhost:3000 npx tsx scripts/write-remotion-props.ts <mediaId>
 *   REMOTION_PROPS_PATH=../remotion-app/.render-props.json npx tsx scripts/write-remotion-props.ts baf551eb-6657-4f67-8560-ff649b8075b7
 *
 * Then in remotion-app: npx remotion render src/index.ts ReelComposition out.mp4 --props=.render-props.json
 * Or open Remotion Studio and use the same props file.
 */

import { writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { runBeatSync } from '../src/beat-sync/index.js';
import { buildScenes } from '../src/engines/PacingEngine.js';
import type { PacingStyle } from '../src/beat-sync/types.js';

const MEDIA_ID = process.argv[2];
const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3000';
const EXPIRES_IN = 7200;
const FPS = 30;
const MIN_DURATION_FRAMES = 30 * FPS;
const MAX_ALLOWED_FRAMES = 60 * FPS;
const CAPTION_DURATION_BUFFER_SEC = 1;

const remotionAppDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'remotion-app');
const DEFAULT_PROPS_PATH = join(remotionAppDir, '.render-props.json');
const PROPS_PATH = process.env.REMOTION_PROPS_PATH || DEFAULT_PROPS_PATH;

function dimensionsFromAspectRatio(ratio: string): { width: number; height: number } {
  switch (ratio) {
    case '1:1':
      return { width: 1080, height: 1080 };
    case '16:9':
      return { width: 1280, height: 720 };
    case '9:16':
    default:
      return { width: 720, height: 1280 };
  }
}

function parseSrt(body: string): { start: number; end: number; text: string }[] {
  const entries: { start: number; end: number; text: string }[] = [];
  const blocks = body.trim().split(/\n\s*\n/);
  for (const block of blocks) {
    const lines = block.trim().split('\n');
    if (lines.length < 2) continue;
    const match = lines[1]!.match(/(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/);
    if (!match) continue;
    const start =
      parseInt(match[1], 10) * 3600 +
      parseInt(match[2]!, 10) * 60 +
      parseInt(match[3]!, 10) +
      parseInt(match[4]!, 10) / 1000;
    const end =
      parseInt(match[5]!, 10) * 3600 +
      parseInt(match[6]!, 10) * 60 +
      parseInt(match[7]!, 10) +
      parseInt(match[8]!, 10) / 1000;
    const text = lines.slice(2).join(' ').trim();
    if (text) entries.push({ start, end, text });
  }
  return entries;
}

async function fetchCaptionEntries(captionUrl: string): Promise<{ start: number; end: number; text: string }[]> {
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

async function main() {
  if (!MEDIA_ID) {
    console.error('Usage: BACKEND_URL=<url> npx tsx scripts/write-remotion-props.ts <mediaId>');
    process.exit(1);
  }

  console.log(`Fetching media ${MEDIA_ID} from ${BACKEND_URL}...`);
  const res = await fetch(`${BACKEND_URL}/media/${MEDIA_ID}?expiresIn=${EXPIRES_IN}`);
  if (!res.ok) {
    console.error(`Failed to fetch media: ${res.status} ${res.statusText}`);
    process.exit(1);
  }
  const media = (await res.json()) as {
    assets_by_type?: { audio?: { url: string }[]; caption?: { url: string }[]; image?: { url: string }[] };
    input_config?: {
      aspectRatio?: string;
      captions?: Record<string, unknown>;
      music?: { url?: string; volume?: number };
      pacing_style?: string;
    };
  };

  const assets = media.assets_by_type || {};
  const audioUrl = assets.audio?.[0]?.url ?? '';
  const captionUrl = assets.caption?.[0]?.url ?? '';
  const imageUrls = (assets.image || []).map((a: { url: string }) => a.url).filter(Boolean);

  if (!audioUrl || !captionUrl || imageUrls.length === 0) {
    console.error('Missing required assets: need audio, caption, and at least one image.');
    process.exit(1);
  }

  const config = media.input_config || {};
  const { width, height } = dimensionsFromAspectRatio(config.aspectRatio || '9:16');
  const musicVolume = typeof config.music?.volume === 'number' ? config.music.volume : 0.2;
  const envPacing = process.env.PACING_STYLE as PacingStyle | undefined;
  const pacingStyle: PacingStyle =
    envPacing === 'smooth' || envPacing === 'rhythmic' || envPacing === 'viral' || envPacing === 'dramatic'
      ? envPacing
      : config.pacing_style === 'rhythmic' || config.pacing_style === 'viral' || config.pacing_style === 'dramatic'
        ? config.pacing_style
        : 'smooth';

  const transitionOverlapByStyle: Record<PacingStyle, number> = {
    smooth: 20,
    rhythmic: 16,
    viral: 12,
    dramatic: 16,
  };
  const transitionOverlap = transitionOverlapByStyle[pacingStyle];

  const captionConfig = config.captions ?? {};
  const captionEntries = captionConfig && (captionConfig as { enabled?: boolean }).enabled !== false ? await fetchCaptionEntries(captionUrl) : [];

  const motionPresets = Array.from({ length: Math.max(imageUrls.length, 1) }, () => 'kenBurns');

  const baseProps: Record<string, unknown> = {
    audioUrl,
    captionUrl,
    captionEntries,
    captionConfig: {
      enabled: (captionConfig as { enabled?: boolean })?.enabled !== false,
      preset: ((captionConfig as { preset?: string })?.preset as string) || 'karaoke-card',
      position: ((captionConfig as { position?: string })?.position as string) || 'bottom',
    },
    imageUrls,
    width,
    height,
    musicVolume,
    motionPresets,
    pacingStyle,
    transitionOverlap,
    captions: captionConfig,
  };
  if (config.music?.url) baseProps.musicUrl = config.music.url;

  let scenes: { durationInFrames: number; imageUrl: string; imageIndex: number }[] | undefined;
  let totalDurationInFrames: number | undefined;
  let beatFrames: number[] | undefined;
  let strongBeatFrames: number[] | undefined;

  // Build scenes: for smooth pacing use caption duration when available to skip audio download
  if (imageUrls.length > 0) {
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
        scenes = built;
        console.log(`Built ${scenes.length} scenes from caption duration (smooth, no audio), ~${Math.round((scenes[0]?.durationInFrames ?? 0) / 30)}s per image, total=${totalDurationInFrames} frames`);
      }
    } else {
      const workDir = join(tmpdir(), `remotion-props-${MEDIA_ID}-${randomUUID()}`);
      if (!existsSync(workDir)) mkdirSync(workDir, { recursive: true });
      try {
        const audioPath = join(workDir, 'audio.mp3');
        const audioRes = await fetch(audioUrl);
        if (!audioRes.ok) throw new Error(`Failed to download audio: ${audioRes.status}`);
        const buf = Buffer.from(await audioRes.arrayBuffer());
        writeFileSync(audioPath, buf);
        console.log('Running beat sync (equal split by video length)...');
        const result = await runBeatSync({
          audioPath,
          pacingStyle,
          imageCount: imageUrls.length,
          fps: FPS,
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
          scenes = built;
          console.log(`Built ${scenes.length} scenes, ~${Math.round((scenes[0]?.durationInFrames ?? 0) / 30)}s per image, total=${totalDurationInFrames} frames`);
        }
      } finally {
        try {
          if (existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
        } catch {
          // ignore
        }
      }
    }
  }

  if (scenes) {
    baseProps.scenes = scenes;
    baseProps.totalDurationInFrames = totalDurationInFrames;
    baseProps.beatFrames = beatFrames ?? [];
    baseProps.strongBeatFrames = strongBeatFrames ?? [];
  }

  writeFileSync(PROPS_PATH, JSON.stringify(baseProps, null, 2), 'utf8');
  console.log('Wrote', PROPS_PATH);
  console.log('Next: cd remotion-app && npx remotion render src/index.ts ReelComposition out.mp4 --props=' + (PROPS_PATH.endsWith('.render-props.json') ? '.render-props.json' : PROPS_PATH));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

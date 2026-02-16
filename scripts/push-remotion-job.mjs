#!/usr/bin/env node
/**
 * Push a single media's render job to the Remotion queue (remotion-render-tasks).
 * Use when backend is stopped but assets already exist in S3 and you want the
 * worker to process this media.
 *
 * Usage: node scripts/push-remotion-job.mjs <mediaId>
 * Example: node scripts/push-remotion-job.mjs baf551eb-6657-4f67-8560-ff649b8075b7
 *
 * Requires: DATABASE_URL, REDIS_URL in .env (from render-worker root)
 */

import 'dotenv/config';
import pg from 'pg';
import { Queue } from 'bullmq';

const { Pool } = pg;

const mediaId = process.argv[2];
if (!mediaId) {
  console.error('Usage: node scripts/push-remotion-job.mjs <mediaId>');
  process.exit(1);
}

const DATABASE_URL = process.env.DATABASE_URL;
const REDIS_URL = process.env.REDIS_URL;
if (!DATABASE_URL || !REDIS_URL) {
  console.error('Missing DATABASE_URL or REDIS_URL in env');
  process.exit(1);
}

async function main() {
  const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  try {
    const mediaRes = await pool.query(
      'SELECT id, user_id, input_config FROM media WHERE id = $1',
      [mediaId]
    );
    if (mediaRes.rows.length === 0) {
      console.error('Media not found:', mediaId);
      process.exit(1);
    }
    const media = mediaRes.rows[0];
    const inputConfig = media.input_config || {};
    const durationCategory = inputConfig.duration ?? '30-60';

    const stepRes = await pool.query(
      "SELECT id FROM media_steps WHERE media_id = $1 AND step = 'render'",
      [mediaId]
    );
    if (stepRes.rows.length === 0) {
      console.error('Render step not found for media:', mediaId);
      process.exit(1);
    }
    const stepId = stepRes.rows[0].id;

    const assetsRes = await pool.query(
      `SELECT type, blob_storage_id, metadata FROM media_assets WHERE media_id = $1`,
      [mediaId]
    );
    const rows = assetsRes.rows;
    const audio = rows.find((r) => r.type === 'audio');
    const caption = rows.find((r) => r.type === 'caption');
    const images = rows.filter((r) => r.type === 'image').map((r) => r.blob_storage_id);
    const intentRow = rows.find((r) => r.type === 'intent');
    const intentData = intentRow?.metadata || null;

    if (!audio || !caption || images.length === 0) {
      console.error('Missing assets. Need audio, caption, and at least one image.');
      console.error('Found: audio=', !!audio, 'caption=', !!caption, 'images=', images.length);
      process.exit(1);
    }

    let musicBlobId;
    const musicConfig = inputConfig.music;
    if (musicConfig?.id) {
      const musicRes = await pool.query(
        'SELECT blob_storage_id FROM background_music WHERE id = $1',
        [musicConfig.id]
      );
      if (musicRes.rows.length > 0) {
        musicBlobId = musicRes.rows[0].blob_storage_id;
      }
    }

    const aspectRatio = inputConfig.aspectRatio;
    const width =
      aspectRatio === '1:1' ? 1080 : aspectRatio === '16:9' ? 1280 : 720;
    const height =
      aspectRatio === '1:1' ? 1080 : aspectRatio === '16:9' ? 720 : 1280;

    // Watermark from user plan (same as backend: FREE = watermark on)
    let isPremium = false;
    const userRes = await pool.query(
      'SELECT is_premium FROM users WHERE id = $1',
      [media.user_id]
    );
    if (userRes.rows.length > 0) {
      isPremium = userRes.rows[0].is_premium === true;
    }
    const hasWatermark = !isPremium;

    const payload = {
      mediaId: media.id,
      stepId,
      userId: media.user_id,
      assets: {
        audio: audio.blob_storage_id,
        caption: caption.blob_storage_id,
        images,
        music: musicBlobId,
      },
      options: {
        preset: 'superfast',
        rendering_hints: {
          ...(intentData?.rendering_hints || {}),
          motion_preset: intentData?.rendering_hints?.motion_preset || 'kenBurns',
          fast_mode: true,
          smart_micro_scenes: true,
          captions: inputConfig.captions,
          pacing_style: inputConfig.pacing_style ?? intentData?.rendering_hints?.pacing_style,
          musicVolume:
            typeof musicConfig?.volume === 'number' ? musicConfig.volume : 0.2,
          width,
          height,
        },
      },
      monetization: {
        watermark: {
          enabled: hasWatermark,
          type: 'text',
          value: 'Made with AutoReels',
        },
      },
    };

    const queue = new Queue('remotion-render-tasks', {
      connection: { url: REDIS_URL },
    });

    const job = await queue.add('remotion-render', payload, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: true,
      removeOnFail: false,
    });

    console.log('Queued Remotion job:', job.id, 'for media:', mediaId);
    console.log('Watermark:', hasWatermark ? 'ON (FREE user)' : 'OFF (PRO user)');
    if (durationCategory !== '30-60') {
      console.warn('Note: media duration is', durationCategory, '- worker still uses Remotion for this job.');
    }
    await queue.close();
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

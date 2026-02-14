#!/usr/bin/env node
/**
 * Debug a Remotion render by renderId.
 * Usage: node scripts/debug-render.mjs <renderId>
 * Example: node scripts/debug-render.mjs kas3t77d9q
 *
 * Run from render-worker with .env loaded (or: cd render-worker && source .env && node scripts/debug-render.mjs kas3t77d9q)
 */

import 'dotenv/config';
import { getRenderProgress, presignUrl } from '@remotion/lambda';

const renderId = process.argv[2];
if (!renderId) {
  console.error('Usage: node scripts/debug-render.mjs <renderId>');
  process.exit(1);
}

const functionName = process.env.REMOTION_LAMBDA_FUNCTION_NAME;
const region = (process.env.REMOTION_LAMBDA_REGION || 'us-east-1');
const serveUrl = process.env.REMOTION_SERVE_URL;

if (!functionName || !serveUrl) {
  console.error('Set REMOTION_LAMBDA_FUNCTION_NAME and REMOTION_SERVE_URL in .env');
  process.exit(1);
}

const bucketName = process.env.REMOTION_BUCKET || (serveUrl && new URL(serveUrl).hostname.split('.')[0]) || null;
if (!bucketName) {
  console.error('Set REMOTION_BUCKET or use a REMOTION_SERVE_URL with host like remotionlambda-xxx.s3.region.amazonaws.com');
  process.exit(1);
}

console.log('Fetching progress for renderId:', renderId);
console.log('Bucket (from serve URL):', bucketName);
console.log('Function:', functionName);
console.log('Region:', region);

try {
  const progress = await getRenderProgress({
    renderId,
    bucketName,
    functionName,
    region,
  });

  console.log('\n--- Progress ---');
  console.log(JSON.stringify(progress, null, 2));

  const done = progress.done === true;
  const outKey = progress.outKey ?? progress.outputFile;
  const outputFile = progress.outputFile;

  console.log('\n--- Summary ---');
  console.log('done:', done);
  console.log('outputFile (URL?):', outputFile);
  console.log('outKey (S3 key):', outKey);
  console.log('bucket (from progress):', progress.bucket);
  console.log('fatalErrorEncountered:', progress.fatalErrorEncountered);
  if (progress.errors?.length) {
    console.log('errors:', progress.errors.length);
    progress.errors.slice(0, 2).forEach((e, i) => console.log(`  [${i}]`, e.message || e));
  }

  if (done && outKey) {
    const keyToUse = typeof outKey === 'string' && !outKey.startsWith('http') ? outKey : progress.outKey;
    if (keyToUse) {
      console.log('\n--- Presigning and testing download ---');
      const url = await presignUrl({
        region,
        bucketName: progress.bucket || bucketName,
        objectKey: keyToUse,
        expiresInSeconds: 60,
      });
      console.log('Presigned URL (first 100 chars):', url.substring(0, 100) + '...');
      const res = await fetch(url);
      console.log('GET result status:', res.status, res.statusText);
      if (!res.ok) {
        console.log('Body snippet:', (await res.text()).slice(0, 200));
      }
    } else {
      console.log('\nNo outKey in progress; outputFile might be a URL. Try opening outputFile in browser.');
    }
  }
} catch (err) {
  console.error('Error:', err.message);
  process.exit(1);
}

#!/usr/bin/env node
/**
 * Tests watermark derivation logic used in remotion-render and remotion-kinetic-render.
 * Run from repo root: node render-worker/scripts/test-watermark.mjs
 * Or from render-worker: node scripts/test-watermark.mjs
 */
import assert from 'node:assert';

// Same logic as in remotion-render.ts and remotion-kinetic-render.ts
function deriveWatermarkEnabled(payload) {
  const watermark = payload.monetization?.watermark;
  return Boolean(watermark?.enabled && watermark?.type === 'text' && watermark?.value);
}

function deriveWatermarkValue(payload) {
  const watermark = payload.monetization?.watermark;
  return watermark?.value ?? 'Made with AutoReels';
}

console.log('Testing render-worker watermark derivation...\n');

// 1. Payload with watermark enabled (FREE user)
const freePayload = {
  mediaId: 'm1',
  userId: 'u1',
  monetization: {
    watermark: { enabled: true, type: 'text', value: 'Made with AutoReels' },
  },
};
assert.strictEqual(deriveWatermarkEnabled(freePayload), true, 'FREE: watermark should be enabled');
assert.strictEqual(deriveWatermarkValue(freePayload), 'Made with AutoReels', 'FREE: value');
console.log('  ✓ FREE user payload → watermark enabled, correct value');

// 2. Payload with watermark disabled (PRO user)
const proPayload = {
  mediaId: 'm2',
  userId: 'u2',
  monetization: {
    watermark: { enabled: false, type: 'text', value: 'Made with AutoReels' },
  },
};
assert.strictEqual(deriveWatermarkEnabled(proPayload), false, 'PRO: watermark should be disabled');
console.log('  ✓ PRO user payload → watermark disabled');

// 3. Payload without monetization (legacy/backward compat)
const legacyPayload = { mediaId: 'm3', userId: 'u3' };
assert.strictEqual(deriveWatermarkEnabled(legacyPayload), false, 'Legacy: no monetization → disabled');
assert.strictEqual(deriveWatermarkValue(legacyPayload), 'Made with AutoReels', 'Legacy: default value');
console.log('  ✓ Legacy payload (no monetization) → disabled, default value');

// 4. Payload with type image (should not enable text watermark path)
const imagePayload = {
  monetization: { watermark: { enabled: true, type: 'image', value: 'https://example.com/logo.png' } },
};
assert.strictEqual(deriveWatermarkEnabled(imagePayload), false, 'Image type: not text → disabled');
console.log('  ✓ Image watermark type → disabled for text path');

// 5. Kinetic payload shape
const kineticPayload = {
  projectId: 'p1',
  userId: 'u1',
  monetization: { watermark: { enabled: true, type: 'text', value: 'Made with AutoReels' } },
  inputProps: { width: 1080, height: 1920 },
};
assert.strictEqual(deriveWatermarkEnabled(kineticPayload), true, 'Kinetic: watermark enabled');
console.log('  ✓ Kinetic payload → watermark enabled');

console.log('\nAll render-worker watermark tests passed.');

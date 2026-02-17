#!/usr/bin/env node
/**
 * Verifies that AssGenerator uses DejaVu Sans for Hindi and Arial for others.
 * Run from render-worker: node scripts/verify-hindi-ass.mjs
 * (AssGenerator is in dist/ after npm run build, or use tsx to run TypeScript)
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

// Dynamic import of compiled AssGenerator (run after npm run build)
async function loadAssGenerator() {
  try {
    const mod = await import(join(root, 'dist/ass-generator.js'));
    return mod.AssGenerator;
  } catch (e) {
    console.error('Build render-worker first: cd render-worker && npm run build');
    throw e;
  }
}

const sampleCaptions = [
  { start: 0, end: 2, text: 'नमस्ते दुनिया', words: [{ start: 0, end: 1, text: 'नमस्ते' }, { start: 1, end: 2, text: 'दुनिया' }] },
];

async function main() {
  const AssGenerator = await loadAssGenerator();

  const assHindi = AssGenerator.generate(sampleCaptions, 'karaoke-card', 'bottom', 'Hindi');
  const assEnglish = AssGenerator.generate(sampleCaptions, 'karaoke-card', 'bottom', 'English');
  const assNoLang = AssGenerator.generate(sampleCaptions, 'karaoke-card', 'bottom');

  let passed = 0;
  let failed = 0;

  if (assHindi.includes('Noto Sans Devanagari')) {
    console.log('✅ Hindi language → ASS uses Noto Sans Devanagari');
    passed++;
  } else {
    console.log('❌ Hindi language → ASS should use DejaVu Sans, got:', assHindi.match(/Style: Default,(\w+\s*\w*),/)?.[1] || '?');
    failed++;
  }

  if (assEnglish.includes('Arial')) {
    console.log('✅ English language → ASS uses Arial');
    passed++;
  } else {
    console.log('❌ English language → ASS should use Arial');
    failed++;
  }

  if (assNoLang.includes('Arial')) {
    console.log('✅ No language → ASS uses Arial (default)');
    passed++;
  } else {
    console.log('❌ No language → ASS should use Arial');
    failed++;
  }

  if (assHindi.includes('नमस्ते') || assHindi.includes('दुनिया')) {
    console.log('✅ Hindi caption text is preserved in ASS');
    passed++;
  } else {
    console.log('❌ Hindi text should appear in ASS output');
    failed++;
  }

  console.log('');
  console.log(passed > 0 && failed === 0 ? `All ${passed} checks passed.` : `Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

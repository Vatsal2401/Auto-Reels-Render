#!/usr/bin/env node
/**
 * Local test: generate Hindi ASS (with mixed text stripped), burn into a short test video.
 * Run from render-worker: npm run ensure-fonts && npm run build && node scripts/test-hindi-captions-local.mjs
 * Opens: test-hindi-captions-output.mp4 (play to verify Hindi captions render, not boxes).
 */

import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import { spawn } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const fontsDir = join(root, 'fonts');
const fontFile = join(fontsDir, 'NotoSansDevanagari-Regular.ttf');

async function main() {
  if (!existsSync(fontFile)) {
    console.error('Hindi font not found. Run: npm run ensure-fonts');
    process.exit(1);
  }

  const mod = await import(join(root, 'dist/ass-generator.js'));
  const AssGenerator = mod.AssGenerator;

  const sampleHindiCaptions = [
    { start: 0, end: 2.5, text: 'ऊँची इमारत, घना कोहरा।', words: [{ start: 0, end: 0.8, text: 'ऊँची' }, { start: 0.8, end: 1.4, text: 'इमारत' }, { start: 1.4, end: 2.5, text: 'घना कोहरा।' }] },
    { start: 2.5, end: 5, text: 'बंदर हवा में उड़ रहा है।', words: [{ start: 2.5, end: 3.2, text: 'बंदर' }, { start: 3.2, end: 4, text: 'हवा में' }, { start: 4, end: 5, text: 'उड़ रहा है।' }] },
  ];

  const ass = AssGenerator.generate(sampleHindiCaptions, 'karaoke-card', 'bottom', 'Hindi');
  const outDir = join(root, 'tmp-test');
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const assPath = join(outDir, 'test-hindi.ass');
  const mp4Path = join(outDir, 'test-hindi-captions-output.mp4');
  writeFileSync(assPath, ass, 'utf8');
  console.log('Wrote ASS:', assPath);

  const escapedAss = assPath.replace(/\\/g, '/').replace(/'/g, "'\\''");
  const escapedFonts = fontsDir.replace(/\\/g, '/').replace(/'/g, "'\\''");
  const ffmpegArgs = [
    '-y',
    '-f', 'lavfi', '-i', 'color=c=black:s=720x1280:d=5:r=25',
    '-vf', `subtitles='${escapedAss}':fontsdir='${escapedFonts}'`,
    '-t', '5',
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    mp4Path,
  ];

  const proc = spawn('ffmpeg', ffmpegArgs, { stdio: 'inherit' });
  await new Promise((resolve, reject) => {
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}`))));
  });

  console.log('Output video:', mp4Path);
  console.log('Play it to verify Hindi captions render (no empty boxes).');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

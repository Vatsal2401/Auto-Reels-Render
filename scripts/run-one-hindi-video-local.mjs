#!/usr/bin/env node
/**
 * Full local test: one video with Hindi script/captions using the real VideoProcessor (same as worker).
 * Creates: 1 image, 1 audio, Hindi captions JSON → runs processor.process() → output MP4.
 * Run: cd render-worker && npm run ensure-fonts && npm run build && node scripts/run-one-hindi-video-local.mjs
 * Output: tmp-test/hindi-full-video.mp4 (play to verify Hindi captions).
 */

import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import { spawn } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const outDir = join(root, 'tmp-test');
const fontsDir = join(root, 'fonts');
const fontFile = join(fontsDir, 'NotoSansDevanagari-Regular.ttf');

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-y', ...args], { stdio: 'pipe' });
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}`))));
  });
}

async function main() {
  if (!existsSync(fontFile)) {
    console.error('Hindi font missing. Run: npm run ensure-fonts');
    process.exit(1);
  }
  if (!existsSync(join(root, 'dist/processor.js'))) {
    console.error('Build first: npm run build');
    process.exit(1);
  }

  mkdirSync(outDir, { recursive: true });

  const imagePath = join(outDir, 'frame.jpg');
  const audioPath = join(outDir, 'audio.mp3');
  const captionPath = join(outDir, 'captions.json');
  const outputPath = join(outDir, 'hindi-full-video.mp4');

  console.log('Creating test assets...');
  await runFfmpeg(['-f', 'lavfi', '-i', 'color=c=#1a1a2e:s=720x1280:d=1', '-vframes', '1', imagePath]);
  await runFfmpeg(['-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-t', '10', '-q:a', '9', audioPath]);

  const hindiCaptions = [
    { start: 0, end: 2.5, text: 'ऊँची इमारत, घना कोहरा।', words: [{ start: 0, end: 0.8, text: 'ऊँची' }, { start: 0.8, end: 1.4, text: 'इमारत' }, { start: 1.4, end: 2.5, text: 'घना कोहरा।' }] },
    { start: 2.5, end: 5, text: 'बंदर हवा में उड़ रहा है।', words: [{ start: 2.5, end: 3.2, text: 'बंदर' }, { start: 3.2, end: 4, text: 'हवा में' }, { start: 4, end: 5, text: 'उड़ रहा है।' }] },
    { start: 5, end: 7.5, text: 'वह कचरे के ढेर पर गिरा!', words: [{ start: 5, end: 5.7, text: 'वह' }, { start: 5.7, end: 6.4, text: 'कचरे के ढेर पर' }, { start: 6.4, end: 7.5, text: 'गिरा!' }] },
    { start: 7.5, end: 10, text: 'बंदर अब स्वतंत्र है।', words: [{ start: 7.5, end: 8.2, text: 'बंदर' }, { start: 8.2, end: 8.8, text: 'अब' }, { start: 8.8, end: 10, text: 'स्वतंत्र है।' }] },
  ];
  writeFileSync(captionPath, JSON.stringify(hindiCaptions, null, 2), 'utf8');
  console.log('Wrote', captionPath);

  const { VideoProcessor } = await import(join(root, 'dist/processor.js'));
  const processor = new VideoProcessor();

  console.log('Rendering video with Hindi captions (VideoProcessor)...');
  await processor.process({
    audioPath,
    captionPath,
    assetPaths: [imagePath],
    outputPath,
    preset: 'superfast',
    rendering_hints: {
      width: 720,
      height: 1280,
      captions: { enabled: true, preset: 'karaoke-card', position: 'bottom', language: 'Hindi' },
    },
  });

  console.log('Done. Output:', outputPath);
  console.log('Play the file to verify Hindi captions render correctly (no empty boxes).');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

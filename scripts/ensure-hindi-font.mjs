#!/usr/bin/env node
/**
 * Ensures Noto Sans Devanagari is present in render-worker/fonts/
 * so Hindi captions render correctly (no tofu). Run: node scripts/ensure-hindi-font.mjs
 */
import { mkdirSync, existsSync } from 'fs';
import { createWriteStream } from 'fs';
import { get as httpsGet } from 'https';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const fontsDir = join(root, 'fonts');
const fontUrl = 'https://github.com/google/fonts/raw/main/ofl/notosansdevanagari/NotoSansDevanagari%5Bwdth%2Cwght%5D.ttf';
const fontFile = join(fontsDir, 'NotoSansDevanagari-Regular.ttf');

async function download(url) {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(fontFile);
    httpsGet(url, (res) => {
      if (res.statusCode !== 200) {
        file.close();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      res.pipe(file);
      file.on('finish', () => {
        file.close();
        resolve();
      });
    }).on('error', (err) => {
      file.close();
      reject(err);
    });
  });
}

async function main() {
  if (existsSync(fontFile)) {
    console.log('Hindi font already present:', fontFile);
    return;
  }
  if (!existsSync(fontsDir)) {
    mkdirSync(fontsDir, { recursive: true });
  }
  console.log('Downloading Noto Sans Devanagari for Hindi captions...');
  await download(fontUrl);
  console.log('Done:', fontFile);
}

main().catch((err) => {
  console.error('Failed to download font:', err.message);
  process.exit(1);
});

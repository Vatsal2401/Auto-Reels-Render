# Fonts for Hindi (Devanagari) captions

This folder is used by the FFmpeg subtitles filter when rendering Hindi captions. Without a Devanagari-capable font here, Hindi text will appear as empty boxes (tofu).

**To populate the font (required for Hindi captions):**

```bash
cd render-worker && node scripts/ensure-hindi-font.mjs
```

This downloads `NotoSansDevanagari-Regular.ttf` from Google Fonts. The render worker uses it automatically when `language` is Hindi.

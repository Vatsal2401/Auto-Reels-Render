# Render flow: Remotion vs FFmpeg

## How the backend chooses the path

**Orchestrator** (`backend/src/media/media-orchestrator.service.ts` → `handleRenderStep`):

- Builds a **single payload** for both paths: `mediaId`, `stepId`, `userId`, `assets` (audio, caption, images, optional music), `options` (rendering_hints: width, height, captions, musicVolume).
- **Branch:**
  - If `input_config.duration === '30-60'` and `REMOTION_QUEUE_ENABLED !== 'false'` → job is queued to **`remotion-render-tasks`** (Remotion Lambda).
  - Otherwise (`60-90`, `90-120`, or Remotion disabled) → job is queued to **`render-tasks`** (FFmpeg worker).

So: **30–60s → Remotion**, **60–90s / 90–120s → FFmpeg**. Same payload shape; different queue and renderer.

---

## What each path actually renders

**We are not** “only image motion in Remotion and audio/music/captions in FFmpeg.”  
**Both paths produce a full video.** Each path does images + voice + music; only captions differ.

| What                | Remotion (30–60s)                    | FFmpeg (60–90s, 90–120s)              |
|---------------------|--------------------------------------|---------------------------------------|
| **Where it runs**   | AWS Lambda (Remotion)                 | Render worker process (FFmpeg)        |
| **Images**          | Yes – zoom (Ken Burns) in composition| Yes – zoompan + xfade between images  |
| **Voice audio**     | Yes – in ReelComposition             | Yes – mixed in FFmpeg                 |
| **Background music**| Yes – in ReelComposition             | Yes – mixed + sidechain ducking       |
| **Captions**        | **Yes** – overlay (preset/position, karaoke) | **Yes** – burned in (ASS/subtitles)   |

So:

- **Remotion path:** full video = image motion + voice + music + **captions**. The worker fetches the caption file (JSON/SRT), parses it, and passes `captionEntries` + `captionConfig` (preset, position) to the composition. ReelComposition renders a caption overlay with the same presets (e.g. karaoke-card, bold-stroke) and optional word-level karaoke.
- **FFmpeg path:** full video = image motion + voice + music + **captions** (ASS/subtitles filter).

---

## Worker process (this repo)

One Node process runs **two BullMQ workers**:

1. **`render-tasks`** (FFmpeg worker)
   - Downloads assets (audio, caption, images, optional music) to a temp dir.
   - Calls `VideoProcessor.process()`: FFmpeg builds one MP4 (images + Ken Burns + xfade + captions + audio + music).
   - Uploads result to storage and finalizes (step, media, credits, email).
   - Concurrency: `FFMPEG_WORKER_CONCURRENCY` (default 2).

2. **`remotion-render-tasks`** (Remotion worker)
   - Does **not** download assets. Gets **signed URLs** for audio, caption, images, music.
   - Sends those URLs + options to **Remotion Lambda** via `renderMediaOnLambda()`.
   - Lambda runs **ReelComposition** with `inputProps` (audioUrl, captionUrl, imageUrls, musicUrl, width, height, captions, musicVolume).
   - Lambda outputs MP4 to its S3; worker downloads that MP4 and uploads it to **app storage**, then runs the same **finalize** logic (step, media, credits, email).
   - Concurrency: `REMOTION_WORKER_CONCURRENCY` (default 1).

Same **finalize** (DB step status, media completion, credits, email) is used for both paths.

---

## Summary

- **30–60s:** Remotion Lambda does the whole video (images + zoom + voice + music + captions).
- **60–90s / 90–120s:** FFmpeg in the worker does the whole video (images + motion + voice + music + captions).
- There is no “Remotion only images, FFmpeg only audio/music/captions” split; each path is a full render. Remotion now renders captions with the same preset/position and karaoke effects as FFmpeg.

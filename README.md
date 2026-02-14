# FFmpeg Render Worker

This is a standalone Node.js worker for processing video rendering tasks using FFmpeg. It is designed to run in a distributed environment, triggered by BullMQ via Upstash Redis.

## Architecture

- **Runtime**: Node.js (TypeScript)
- **Queues**: BullMQ (Redis-backed). Two queues: `render-tasks` (FFmpeg, 60–90s / 90–120s) and `remotion-render-tasks` (Remotion Lambda, 30–60s).
- **FFmpeg**: Executed via `child_process.spawn` (non-blocking). Used for medium/long durations.
- **Remotion Lambda**: Used for 30–60s videos. Worker invokes Lambda, polls until done, downloads output, uploads to storage, then runs the same idempotent finalization as FFmpeg path.
- **Storage**: S3 / Supabase Storage for assets and final renders.
- **Database**: PostgreSQL for status updates.

## Performance Constraints

- **Concurrency**: 1 (Processes one job at a time to prevent CPU/RAM exhaustion)
- **FFmpeg Threads**: Limited to 1 thread per job (`-threads 1`)
- **Disk Usage**: All processing is done in `/tmp/{jobId}` and cleaned up after completion.

## Deployment on GCP VM

### 1. Provision a VM

- OS: Ubuntu 22.04 LTS
- Machine Type: `e2-medium` (2 vCPU, 4GB RAM) or larger recommended.
- Allow HTTP/HTTPS traffic.

### 2. Install FFmpeg

```bash
sudo apt update
sudo apt install -y ffmpeg
```

### 3. Install Node.js

```bash
# Node.js 22 or higher is required
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
```

### 4. Clone and Setup

```bash
git clone <this-repo-url> render-worker
cd render-worker
npm install
npm run build
```

### 5. Configure Environment

Create a `.env` file based on `.env.example`.

### 6. Run with PM2

```bash
sudo npm install -g pm2
pm2 start dist/index.js --name render-worker
pm2 save
pm2 startup
```

## Environment Variables

| Variable                       | Description                                    |
| :----------------------------- | :--------------------------------------------- |
| `REDIS_URL`                    | Upstash Redis connection string (rediss://...) |
| `DATABASE_URL`                 | PostgreSQL connection string                   |
| `CURRENT_BLOB_STORAGE`         | `s3` or `supabase` – **must match backend**   |
| `AWS_REGION`                   | AWS Region (if using s3)                       |
| `AWS_ACCESS_KEY_ID`            | AWS Access Key                                 |
| `AWS_SECRET_ACCESS_KEY`        | AWS Secret Key                                 |
| `S3_BUCKET_NAME`               | S3 Bucket name                                 |
| `SUPABASE_STORAGE_*`           | Supabase endpoint, keys, bucket (if supabase)  |

**Storage consistency:** Both FFmpeg and Remotion paths upload the final video to the **same** storage (Supabase or S3) via `CURRENT_BLOB_STORAGE`. Set the worker’s `CURRENT_BLOB_STORAGE` (and bucket/credentials) to match the backend so `final_url` and completion emails use the correct signed URLs (Supabase or S3).

| **Remotion (30–60s path)**     |                                                 |
| :----------------------------- | :---------------------------------------------- |
| `REMOTION_SERVE_URL`           | Deployed Remotion site URL (from remotion-app)  |
| `REMOTION_LAMBDA_FUNCTION_NAME`| Lambda function name (from remotion-app deploy) |
| `REMOTION_LAMBDA_REGION`       | AWS region (e.g. `us-east-1`)                   |
| `REMOTION_COMPOSITION_ID`      | Optional; default `ReelComposition`              |
| `REMOTION_WORKER_CONCURRENCY`  | Optional; default `1`                            |
| `FFMPEG_WORKER_CONCURRENCY`    | Optional; default `2`                            |

**Remotion and S3:** You do **not** need your own S3 bucket or S3 credentials for Remotion Lambda. Remotion uses a bucket it creates in your AWS account; the worker only needs **AWS credentials** (e.g. `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`) that can **invoke Lambda** and **read that Remotion bucket** (so we can download the render). The final video is then uploaded to **your app storage** (Supabase or S3) via `CURRENT_BLOB_STORAGE`. So you can use Supabase-only for app storage and still use Remotion Lambda.

### Beat sync (aubio and ffprobe)

For **30–60s** renders, pacing styles (rhythmic, viral, dramatic) use beat extraction to align cuts and motion to music. The worker expects:

- **ffprobe** – used to get audio duration (same binary as FFmpeg; usually already present).
- **aubio** – CLI `aubio beat <audiofile>` to get beat timestamps. Install locally (e.g. `apt install aubio-tools` or `brew install aubio`) so beat-based pacing works in development.

If **aubio** is missing (e.g. in a minimal Lambda runtime), the worker falls back to a duration-based beat grid so pacing still runs without music-aware beats. For **Remotion Lambda**, add **aubio** (and ensure **ffprobe** is available) in your Lambda layer or container image so production renders get full beat-aware pacing.

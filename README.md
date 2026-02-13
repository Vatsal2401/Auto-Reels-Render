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

**Storage consistency:** Both FFmpeg and Remotion paths upload the final video to the **same** storage (Supabase or S3) via `CURRENT_BLOB_STORAGE`. Remotion Lambda’s own S3 is only used temporarily; we download from it and re-upload to your storage. Set the worker’s `CURRENT_BLOB_STORAGE` (and bucket/credentials) to match the backend so `final_url` and completion emails use the correct signed URLs (Supabase or S3).
| **Remotion (30–60s path)**     |                                                 |
| `REMOTION_SERVE_URL`           | Deployed Remotion site URL (from remotion-app)  |
| `REMOTION_LAMBDA_FUNCTION_NAME`| Lambda function name (from remotion-app deploy)|
| `REMOTION_LAMBDA_REGION`       | AWS region (e.g. `us-east-1`)                  |
| `REMOTION_COMPOSITION_ID`      | Optional; default `ReelComposition`           |
| `REMOTION_WORKER_CONCURRENCY`  | Optional; default `1`                          |
| `FFMPEG_WORKER_CONCURRENCY`    | Optional; default `2`                          |

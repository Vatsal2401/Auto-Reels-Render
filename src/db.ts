import { Client } from 'pg';
import 'dotenv/config';

export class DbService {
    private client: Client;

    constructor() {
        this.client = new Client({
            connectionString: process.env.DATABASE_URL,
            ssl: { rejectUnauthorized: false },
        });
    }

    async connect() {
        await this.client.connect();
    }

    async updateStepStatus(stepId: string, status: string, blobId?: string | string[], errorMessage?: string) {
        const query = `
      UPDATE media_steps 
      SET status = $1, 
          blob_storage_id = $2, 
          error_message = $3, 
          completed_at = $4 
      WHERE id = $5
    `;
        const completedAt = status === 'success' ? new Date() : null;
        const blobIdJson = blobId ? JSON.stringify(blobId) : null;
        await this.client.query(query, [status, blobIdJson, errorMessage, completedAt, stepId]);
    }

    async addAsset(mediaId: string, type: string, blobId: string) {
        const query = `
      INSERT INTO media_assets (id, media_id, type, blob_storage_id, created_at)
      VALUES (gen_random_uuid(), $1, $2, $3, NOW())
    `;
        await this.client.query(query, [mediaId, type, blobId]);
    }

    async disconnect() {
        await this.client.end();
    }
}

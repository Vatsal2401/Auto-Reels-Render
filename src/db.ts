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

    async finalizeMedia(mediaId: string, resultBlobId: string) {
        const query = `
      UPDATE media 
      SET status = 'completed', 
          blob_storage_id = $1, 
          completed_at = NOW(),
          updated_at = NOW()
      WHERE id = $2
    `;
        await this.client.query(query, [resultBlobId, mediaId]);
    }

    async getMediaInfo(mediaId: string) {
        const query = `SELECT user_id, input_config FROM media WHERE id = $1`;
        const res = await this.client.query(query, [mediaId]);
        return res.rows[0];
    }

    async deductCredits(userId: string, amount: number, description: string, referenceId: string, metadata?: any) {
        // 1. Get current balance
        const userRes = await this.client.query('SELECT credits_balance FROM users WHERE id = $1 FOR UPDATE', [userId]);
        if (userRes.rowCount === 0) throw new Error('User not found');
        const currentBalance = userRes.rows[0].credits_balance;

        if (currentBalance < amount) {
            throw new Error('Insufficient credits');
        }

        const newBalance = currentBalance - amount;

        // 2. Update balance
        await this.client.query('UPDATE users SET credits_balance = $1 WHERE id = $2', [newBalance, userId]);

        // 3. Create transaction
        const txQuery = `
      INSERT INTO credit_transactions (id, user_id, transaction_type, amount, balance_after, description, reference_id, metadata, created_at)
      VALUES (gen_random_uuid(), $1, 'deduction', $2, $3, $4, $5, $6, NOW())
    `;
        await this.client.query(txQuery, [userId, -amount, newBalance, description, referenceId, metadata ? JSON.stringify(metadata) : null]);
    }

    async disconnect() {
        await this.client.end();
    }
}

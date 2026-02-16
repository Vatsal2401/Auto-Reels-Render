import { Pool } from 'pg';
import 'dotenv/config';

export class DbService {
    private pool: Pool;

    constructor() {
        this.pool = new Pool({
            connectionString: process.env.DATABASE_URL,
            ssl: { rejectUnauthorized: false },
            max: 5, // Max clients in the pool
            idleTimeoutMillis: 30000,
        });

        this.pool.on('error', (err) => {
            console.error('Unexpected error on idle client', err);
            // Don't exit, pool handles this
        });
    }

    async connect() {
        // Pool connects lazily, but let's test it
        const client = await this.pool.connect();
        client.release();
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
        await this.pool.query(query, [status, blobIdJson, errorMessage, completedAt, stepId]);
    }

    /** Returns current step status or null if not found. */
    async getStepStatus(stepId: string): Promise<string | null> {
        const res = await this.pool.query(
            'SELECT status FROM media_steps WHERE id = $1',
            [stepId],
        );
        return res.rows[0]?.status ?? null;
    }

    /** Updates step only if current status is 'processing'. Returns true if updated, false otherwise (idempotent). */
    async updateStepStatusOnlyIfProcessing(
        stepId: string,
        status: string,
        blobId?: string | string[],
        errorMessage?: string,
    ): Promise<boolean> {
        const completedAt = status === 'success' ? new Date() : null;
        const blobIdJson = blobId ? JSON.stringify(blobId) : null;
        const res = await this.pool.query(
            `UPDATE media_steps 
             SET status = $1, blob_storage_id = $2, error_message = $3, completed_at = $4, updated_at = NOW()
             WHERE id = $5 AND status = 'processing'
             RETURNING id`,
            [status, blobIdJson, errorMessage, completedAt, stepId],
        );
        return (res.rowCount ?? 0) > 0;
    }

    /** Finalizes media only if not already completed. Returns true if updated, false otherwise (idempotent). */
    async finalizeMediaOnlyIfNotCompleted(mediaId: string, resultBlobId: string): Promise<boolean> {
        const res = await this.pool.query(
            `UPDATE media 
             SET status = 'completed', blob_storage_id = $1, completed_at = NOW(), updated_at = NOW()
             WHERE id = $2 AND status != 'completed'
             RETURNING id`,
            [resultBlobId, mediaId],
        );
        return (res.rowCount ?? 0) > 0;
    }

    async addAsset(mediaId: string, type: string, blobId: string) {
        const query = `
      INSERT INTO media_assets (id, media_id, type, blob_storage_id, created_at)
      VALUES (gen_random_uuid(), $1, $2, $3, NOW())
    `;
        await this.pool.query(query, [mediaId, type, blobId]);
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
        await this.pool.query(query, [resultBlobId, mediaId]);
    }

    async getMediaInfo(mediaId: string) {
        const query = `
            SELECT m.user_id, m.input_config, m.project_id, u.email, u.name 
            FROM media m
            LEFT JOIN users u ON m.user_id = u.id
            WHERE m.id = $1
        `;
        const res = await this.pool.query(query, [mediaId]);
        return res.rows[0];
    }

    /** When media completes, update linked project (status + output_url as blob id). Idempotent. */
    async updateProjectOnMediaComplete(mediaId: string, resultBlobId: string): Promise<void> {
        await this.pool.query(
            `UPDATE projects p
             SET status = 'completed', output_url = $1, completed_at = NOW(), updated_at = NOW()
             FROM media m
             WHERE m.id = $2 AND m.project_id = p.id AND p.status != 'completed'`,
            [resultBlobId, mediaId],
        );
    }

    /** Get project info for finalization (kinetic typography). Returns user_id, credit_cost, metadata. */
    async getProjectInfo(projectId: string): Promise<{ user_id: string; credit_cost: number; metadata?: any } | null> {
        const res = await this.pool.query(
            'SELECT user_id, credit_cost, metadata FROM projects WHERE id = $1',
            [projectId],
        );
        const row = res.rows[0];
        return row ? { user_id: row.user_id, credit_cost: row.credit_cost ?? 0, metadata: row.metadata } : null;
    }

    /** Finalize project (kinetic typography): set completed and output_url only if not already completed. Idempotent. */
    async finalizeProjectOnlyIfNotCompleted(projectId: string, resultBlobId: string): Promise<boolean> {
        const res = await this.pool.query(
            `UPDATE projects
             SET status = 'completed', output_url = $1, completed_at = NOW(), updated_at = NOW()
             WHERE id = $2 AND status != 'completed'
             RETURNING id`,
            [resultBlobId, projectId],
        );
        return (res.rowCount ?? 0) > 0;
    }

    /** Update project status (e.g. failed). Used by kinetic worker on error. */
    async updateProjectStatus(projectId: string, status: string, errorMessage?: string): Promise<void> {
        await this.pool.query(
            `UPDATE projects SET status = $1, error_message = $2, updated_at = NOW() WHERE id = $3`,
            [status, errorMessage ?? null, projectId],
        );
    }

    async deductCredits(userId: string, amount: number, description: string, referenceId: string, metadata?: any) {
        // 1. Get current balance
        const userRes = await this.pool.query('SELECT credits_balance FROM users WHERE id = $1 FOR UPDATE', [userId]);
        if (userRes.rowCount === 0) throw new Error('User not found');
        const currentBalance = userRes.rows[0].credits_balance;

        if (currentBalance < amount) {
            throw new Error('Insufficient credits');
        }

        const newBalance = currentBalance - amount;

        // 2. Update balance
        await this.pool.query('UPDATE users SET credits_balance = $1 WHERE id = $2', [newBalance, userId]);

        // 3. Create transaction
        const txQuery = `
      INSERT INTO credit_transactions (id, user_id, transaction_type, amount, balance_after, description, reference_id, metadata, created_at)
      VALUES (gen_random_uuid(), $1, 'deduction', $2, $3, $4, $5, $6, NOW())
    `;
        await this.pool.query(txQuery, [userId, -amount, newBalance, description, referenceId, metadata ? JSON.stringify(metadata) : null]);
    }

    async disconnect() {
        await this.pool.end();
    }
}

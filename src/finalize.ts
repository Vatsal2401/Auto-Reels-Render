import type { DbService } from './db.js';
import type { MailService } from './mail.js';

export interface FinalizeProjectParams {
    projectId: string;
    resultBlobId: string;
    db: DbService;
    storage: { getSignedUrl: (objectId: string, expiresIn?: number) => Promise<string> };
    mailer?: MailService;
}

/**
 * Idempotent project finalization (kinetic typography): update project to completed, deduct credits.
 * Safe to call on retries.
 */
export async function finalizeProjectSuccess(params: FinalizeProjectParams): Promise<void> {
    const { projectId, resultBlobId, db, mailer } = params;

    const updated = await db.finalizeProjectOnlyIfNotCompleted(projectId, resultBlobId);
    if (!updated) return;

    const projectInfo = await db.getProjectInfo(projectId);
    if (!projectInfo || !projectInfo.user_id) return;

    const { user_id: userId, credit_cost: creditCost } = projectInfo;
    try {
        await db.deductCredits(
            userId,
            creditCost,
            'Kinetic Typography render',
            projectId,
            { project_id: projectId, tool_type: 'kinetic-typography', creditCost },
        );
    } catch (creditErr: unknown) {
        const msg = creditErr instanceof Error ? creditErr.message : String(creditErr);
        console.error('[Finalize] Project credit deduction failed:', msg);
    }
}

const CREDIT_COSTS: Record<string, number> = {
    '30-60': 1,
    '60-90': 2,
    '90-120': 3,
    default: 1,
};

export interface FinalizeParams {
    mediaId: string;
    stepId: string;
    resultBlobId: string;
    db: DbService;
    mailer: MailService;
    storage: { getSignedUrl: (objectId: string, expiresIn?: number) => Promise<string> };
}

/**
 * Idempotent finalization: update step to success only if still processing,
 * then finalize media only if not already completed, then deduct credits and send email.
 * Safe to call on retries; avoids double-deduct or double-finalize.
 */
export async function finalizeRenderSuccess(params: FinalizeParams): Promise<void> {
    const { mediaId, stepId, resultBlobId, db, mailer, storage } = params;

    const stepUpdated = await db.updateStepStatusOnlyIfProcessing(stepId, 'success', resultBlobId);
    if (!stepUpdated) {
        return; // Step already finalized (e.g. previous retry completed)
    }

    const mediaFinalized = await db.finalizeMediaOnlyIfNotCompleted(mediaId, resultBlobId);
    if (!mediaFinalized) {
        return; // Media already completed
    }

    await db.updateProjectOnMediaComplete(mediaId, resultBlobId);

    const mediaInfo = await db.getMediaInfo(mediaId);
    if (!mediaInfo) return;

    const userId = mediaInfo.user_id;
    const config = mediaInfo.input_config || {};
    const duration = config.duration || '30-60';
    const topic = config.topic || 'Media';
    const creditCost = (CREDIT_COSTS[duration] ?? CREDIT_COSTS.default) as number;

    if (mediaInfo.email) {
        try {
            const signedUrl = await storage.getSignedUrl(resultBlobId);
            await mailer.sendRenderCompleteEmail(
                mediaInfo.email,
                signedUrl,
                topic,
                mediaInfo.name,
            );
        } catch (emailErr: unknown) {
            const msg = emailErr instanceof Error ? emailErr.message : String(emailErr);
            console.error('[Finalize] Email send failed:', msg);
        }
    }

    if (userId) {
        try {
            await db.deductCredits(
                userId,
                creditCost,
                `Media generation: ${topic}`,
                mediaId,
                { media_id: mediaId, topic, duration, creditCost },
            );
        } catch (creditErr: unknown) {
            const msg = creditErr instanceof Error ? creditErr.message : String(creditErr);
            console.error('[Finalize] Credit deduction failed:', msg);
        }
    }
}

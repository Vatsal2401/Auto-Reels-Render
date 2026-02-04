import { Resend } from 'resend';
import { render } from '@react-email/render';
import * as React from 'react';
import VerificationEmail from './templates/verification.js';
import RenderCompleteEmail from './templates/render-complete.js';
import 'dotenv/config';

export class MailService {
    private resend?: Resend;
    private fromEmail: string;

    constructor() {
        const apiKey = process.env.RESEND_API_KEY;
        this.fromEmail = process.env.SMTP_FROM || 'AI Reels <onboarding@resend.dev>';

        if (!apiKey) {
            console.error('[MailService] ❌ RESEND_API_KEY is not defined');
        } else {
            this.resend = new Resend(apiKey);
            console.log('[MailService] ✅ Resend initialized');
        }
    }

    async sendVerificationEmail(email: string, token: string, name?: string) {
        if (!this.resend) return;

        const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3001';
        const verificationUrl = `${frontendUrl}/verify-email?token=${token}&email=${encodeURIComponent(email)}`;

        try {
            const html = await render(
                React.createElement(VerificationEmail, {
                    userFirstname: name,
                    verificationUrl,
                })
            );

            const { data, error } = await this.resend.emails.send({
                from: this.fromEmail,
                to: email,
                subject: 'Verify your email for AI Reels',
                html,
            });

            if (error) {
                console.error(`[MailService] ❌ Failed to send verification email to ${email}:`, error);
                throw error;
            }

            console.log(`[MailService] 📧 Verification email sent to ${email}. ID: ${data?.id}`);
        } catch (error: any) {
            console.error(`[MailService] ❌ Error in sendVerificationEmail: ${error.message}`);
            throw error;
        }
    }

    async sendRenderCompleteEmail(email: string, videoUrl: string, topic: string, name?: string) {
        if (!this.resend) return;

        try {
            const html = await render(
                React.createElement(RenderCompleteEmail, {
                    userFirstname: name,
                    videoUrl,
                    topic,
                })
            );

            const { data, error } = await this.resend.emails.send({
                from: this.fromEmail,
                to: email,
                subject: 'Your video is ready! - AI Reels',
                html,
            });

            if (error) {
                console.error(`[MailService] ❌ Failed to send render complete email to ${email}:`, error);
                throw error;
            }

            console.log(`[MailService] 📧 Render complete email sent to ${email}. ID: ${data?.id}`);
        } catch (error: any) {
            console.error(`[MailService] ❌ Error in sendRenderCompleteEmail: ${error.message}`);
            throw error;
        }
    }
}

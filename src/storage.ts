import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Upload } from '@aws-sdk/lib-storage';
import { createWriteStream, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import 'dotenv/config';

export class StorageService {
    private s3Client: S3Client;
    private bucketName: string;

    constructor() {
        const isSupabase = process.env.CURRENT_BLOB_STORAGE === 'supabase';

        if (isSupabase) {
            this.s3Client = new S3Client({
                region: process.env.SUPABASE_STORAGE_REGION || 'us-east-1',
                endpoint: process.env.SUPABASE_STORAGE_ENDPOINT,
                credentials: {
                    accessKeyId: process.env.SUPABASE_STORAGE_ACCESS_KEY_ID || '',
                    secretAccessKey: process.env.SUPABASE_STORAGE_SECRET_ACCESS_KEY || '',
                },
                forcePathStyle: true,
            });
            this.bucketName = process.env.SUPABASE_STORAGE_BUCKET_NAME || 'ai-reels-storage';
        } else {
            this.s3Client = new S3Client({
                region: process.env.AWS_REGION || 'us-east-1',
                credentials: {
                    accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
                    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
                },
            });
            this.bucketName = process.env.S3_BUCKET_NAME || 'ai-reels-storage';
        }
    }

    async downloadToFile(objectId: string, targetPath: string): Promise<void> {
        // Decode the object key in case it comes URL encoded
        const decodedKey = decodeURIComponent(objectId);
        const command = new GetObjectCommand({
            Bucket: this.bucketName,
            Key: decodedKey,
        });
        const response = await this.s3Client.send(command);

        const targetDir = dirname(targetPath);
        if (!existsSync(targetDir)) {
            mkdirSync(targetDir, { recursive: true });
        }

        await pipeline(response.Body as Readable, createWriteStream(targetPath));
    }

    async upload(objectId: string, stream: Readable, contentType: string = 'video/mp4'): Promise<void> {
        const upload = new Upload({
            client: this.s3Client,
            params: {
                Bucket: this.bucketName,
                Key: objectId,
                Body: stream,
                ContentType: contentType,
            },
        });
        await upload.done();
    }

    async getSignedUrl(objectId: string, expiresIn: number = 3600): Promise<string> {
        const command = new GetObjectCommand({
            Bucket: this.bucketName,
            Key: objectId,
        });
        return await getSignedUrl(this.s3Client, command, { expiresIn });
    }
}

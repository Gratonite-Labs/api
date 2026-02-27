import { Client } from 'minio';
import { env } from '../env.js';
import { logger } from './logger.js';

/**
 * MinIO S3-compatible object storage client.
 */
export const minioClient = new Client({
  endPoint: env.MINIO_ENDPOINT,
  port: env.MINIO_PORT,
  useSSL: env.MINIO_USE_SSL,
  accessKey: env.MINIO_ACCESS_KEY,
  secretKey: env.MINIO_SECRET_KEY,
});

/** Bucket definitions with size limits */
export const BUCKETS = {
  uploads: { name: 'uploads', maxSize: 25 * 1024 * 1024 }, // 25MB
  emojis: { name: 'emojis', maxSize: 256 * 1024 }, // 256KB
  stickers: { name: 'stickers', maxSize: 500 * 1024 }, // 500KB
  avatars: { name: 'avatars', maxSize: 10 * 1024 * 1024 }, // 10MB
  banners: { name: 'banners', maxSize: 10 * 1024 * 1024 }, // 10MB
  'server-icons': { name: 'server-icons', maxSize: 10 * 1024 * 1024 }, // 10MB
} as const;

export type BucketName = keyof typeof BUCKETS;

/**
 * Ensure all required buckets exist on startup.
 * Creates buckets that don't exist yet with public-read policy for CDN access.
 */
export async function ensureBuckets(): Promise<void> {
  for (const [key, bucket] of Object.entries(BUCKETS)) {
    try {
      const exists = await minioClient.bucketExists(bucket.name);
      if (!exists) {
        await minioClient.makeBucket(bucket.name);

        // Set public read policy for CDN access
        const policy = {
          Version: '2012-10-17',
          Statement: [
            {
              Effect: 'Allow',
              Principal: { AWS: ['*'] },
              Action: ['s3:GetObject'],
              Resource: [`arn:aws:s3:::${bucket.name}/*`],
            },
          ],
        };
        await minioClient.setBucketPolicy(bucket.name, JSON.stringify(policy));

        logger.info({ bucket: bucket.name }, 'Created MinIO bucket');
      }
    } catch (err) {
      logger.error({ err, bucket: bucket.name }, 'Failed to ensure bucket');
      throw err;
    }
  }

  logger.info('All MinIO buckets verified');
}

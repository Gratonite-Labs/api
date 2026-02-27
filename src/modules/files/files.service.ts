import { createHash, randomBytes } from 'crypto';
import sharp from 'sharp';
import type { AppContext } from '../../lib/context.js';
import { BUCKETS, type BucketName } from '../../lib/minio.js';
import { generateId } from '../../lib/snowflake.js';
import { logger } from '../../lib/logger.js';
import type { UploadFileInput } from './files.schemas.js';

/** Map purpose to bucket name */
const PURPOSE_BUCKET: Record<string, BucketName> = {
  upload: 'uploads',
  emoji: 'emojis',
  sticker: 'stickers',
  avatar: 'avatars',
  banner: 'banners',
  'server-icon': 'server-icons',
};

/** Allowed MIME type prefixes per purpose */
const ALLOWED_TYPES: Record<string, string[]> = {
  upload: ['image/', 'video/', 'audio/', 'application/pdf', 'text/'],
  emoji: ['image/png', 'image/gif', 'image/webp'],
  sticker: ['image/png', 'image/apng', 'image/gif', 'image/webp', 'application/json'],
  avatar: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'],
  banner: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'],
  'server-icon': ['image/png', 'image/jpeg', 'image/gif', 'image/webp'],
};

const BLOCKED_MIME_TYPES = new Set(['image/svg+xml']);

export function isMimeAllowedForPurpose(purpose: string, mimeType: string): boolean {
  const allowed = ALLOWED_TYPES[purpose] ?? ALLOWED_TYPES.upload;
  const isAllowed = allowed.some((t) => mimeType.startsWith(t));
  return isAllowed && !BLOCKED_MIME_TYPES.has(mimeType);
}

export function getMaxUploadSizeForPurpose(purpose: string): number {
  const bucketName = PURPOSE_BUCKET[purpose] ?? 'uploads';
  return BUCKETS[bucketName].maxSize;
}

/** Max dimensions per purpose */
const MAX_DIMENSIONS: Record<string, { width: number; height: number }> = {
  emoji: { width: 128, height: 128 },
  sticker: { width: 320, height: 320 },
  avatar: { width: 1024, height: 1024 },
  banner: { width: 1920, height: 1080 },
  'server-icon': { width: 1024, height: 1024 },
};

export interface UploadResult {
  id: string;
  bucket: string;
  key: string;
  url: string;
  filename: string;
  contentType: string;
  size: number;
  width: number | null;
  height: number | null;
  description: string | null;
  spoiler: boolean;
  isVoiceMessage: boolean;
  durationSecs: number | null;
  waveform: string | null;
}

export interface ResolvedAsset {
  bucket: string;
  key: string;
  url: string;
}

function sanitizeContentDispositionFilename(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128) || 'file';
}

export function buildPublicFileHeaders(contentType: string | undefined, filename: string) {
  const safeFilename = sanitizeContentDispositionFilename(filename);
  return {
    'Content-Type': contentType ?? 'application/octet-stream',
    'Cache-Control': 'public, max-age=31536000, immutable',
    'Content-Disposition': `inline; filename="${safeFilename}"`,
    'X-Content-Type-Options': 'nosniff',
  };
}

export function createFilesService(ctx: AppContext) {
  async function findObjectByHash(bucket: string, hash: string): Promise<string | null> {
    return new Promise((resolve, reject) => {
      const stream = ctx.minio.listObjectsV2(bucket, '', true);
      let settled = false;

      stream.on('data', (obj) => {
        const key = obj.name;
        if (!key) return;
        if (key === hash || key.endsWith(`/${hash}`)) {
          settled = true;
          stream.destroy();
          resolve(key);
        }
      });

      stream.on('error', (err) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
      });

      stream.on('end', () => {
        if (!settled) {
          settled = true;
          resolve(null);
        }
      });
    });
  }

  /**
   * Resolve an asset hash (e.g. "abc.webp") to bucket/key for public display.
   * Uses Redis cache to avoid repeated object scans.
   */
  async function resolveAssetByHash(hash: string): Promise<ResolvedAsset | null> {
    if (!hash || hash.length > 128) return null;

    const cacheKey = `asset_lookup:${hash}`;
    const cached = await ctx.redis.get(cacheKey);
    if (cached) {
      try {
        const parsed = JSON.parse(cached) as { bucket: string; key: string };
        return {
          bucket: parsed.bucket,
          key: parsed.key,
          url: getFileUrl(parsed.bucket, parsed.key),
        };
      } catch {
        // Ignore malformed cache entries
      }
    }

    const searchableBuckets = [
      BUCKETS.avatars.name,
      BUCKETS.banners.name,
      BUCKETS['server-icons'].name,
      BUCKETS.emojis.name,
      BUCKETS.stickers.name,
      BUCKETS.uploads.name,
    ];

    for (const bucket of searchableBuckets) {
      const key = await findObjectByHash(bucket, hash);
      if (!key) continue;

      await ctx.redis.set(
        cacheKey,
        JSON.stringify({ bucket, key }),
        'EX',
        60 * 60 * 24, // 24h
      );

      return { bucket, key, url: getFileUrl(bucket, key) };
    }

    return null;
  }
  /**
   * Upload a file to MinIO with optional image processing.
   */
  async function uploadFile(
    file: Express.Multer.File,
    input: UploadFileInput,
    userId: string,
  ): Promise<UploadResult> {
    const bucketName = PURPOSE_BUCKET[input.purpose] ?? 'uploads';
    const bucket = BUCKETS[bucketName];

    // 1. Enforce size limit
    if (file.size > bucket.maxSize) {
      throw Object.assign(new Error('File too large'), {
        code: 'FILE_TOO_LARGE',
        maxSize: getMaxUploadSizeForPurpose(input.purpose),
      });
    }

    // 2. Validate MIME type via magic bytes
    const { fileTypeFromBuffer } = await import('file-type');
    const detected = await fileTypeFromBuffer(file.buffer);
    const mimeType = detected?.mime ?? file.mimetype;

    if (!isMimeAllowedForPurpose(input.purpose, mimeType)) {
      throw Object.assign(new Error(`File type ${mimeType} not allowed for ${input.purpose}`), {
        code: 'INVALID_FILE_TYPE',
      });
    }

    // 3. Process image if applicable
    let buffer = file.buffer;
    let width: number | null = null;
    let height: number | null = null;
    const isImage = mimeType.startsWith('image/') && mimeType !== 'image/gif';
    const isAnimated = mimeType === 'image/gif' || mimeType === 'image/apng';

    if (isImage && !isAnimated) {
      const result = await processImage(buffer, input.purpose);
      buffer = result.buffer;
      width = result.width;
      height = result.height;
    } else if (isAnimated || isImage) {
      // For animated images, just get metadata without processing
      try {
        const meta = await sharp(buffer).metadata();
        width = meta.width ?? null;
        height = meta.height ?? null;
      } catch {
        // Non-image or unreadable — skip
      }
    }

    // 4. Generate storage key
    const hash = createHash('sha256')
      .update(file.originalname + Date.now() + randomBytes(8).toString('hex'))
      .digest('hex')
      .slice(0, 32);
    const ext = detected?.ext ?? file.originalname.split('.').pop() ?? 'bin';
    const contextDir = input.contextId ?? 'general';
    const key = `${contextDir}/${hash}.${ext}`;

    // 5. Upload to MinIO
    await ctx.minio.putObject(bucket.name, key, buffer, buffer.length, {
      'Content-Type': mimeType,
      'x-amz-meta-uploader': userId,
      'x-amz-meta-original-name': file.originalname,
    });

    // 6. Build result
    const fileId = generateId();
    const url = `${ctx.env.CDN_BASE_URL}/${bucket.name}/${key}`;

    const isVoice = Boolean(input.isVoiceMessage) && mimeType.startsWith('audio/');

    const result: UploadResult = {
      id: fileId,
      bucket: bucket.name,
      key,
      url,
      filename: file.originalname,
      contentType: mimeType,
      size: buffer.length,
      width,
      height,
      description: input.description ?? null,
      spoiler: Boolean(input.spoiler),
      isVoiceMessage: isVoice,
      durationSecs: isVoice && input.durationSecs ? input.durationSecs : null,
      waveform: isVoice && input.waveform ? input.waveform : null,
    };

    // 7. Store as pending upload in Redis (15 min TTL) for message attachment linking
    await ctx.redis.set(
      `pending_upload:${fileId}`,
      JSON.stringify(result),
      'EX',
      900,
    );

    logger.info({ fileId, bucket: bucket.name, key, size: buffer.length }, 'File uploaded');

    return result;
  }

  /**
   * Process an image: strip EXIF, resize, convert to WebP.
   */
  async function processImage(
    buffer: Buffer,
    purpose: string,
  ): Promise<{ buffer: Buffer; width: number; height: number }> {
    const maxDims = MAX_DIMENSIONS[purpose];

    let pipeline = sharp(buffer).rotate(); // auto-rotate based on EXIF

    if (maxDims) {
      pipeline = pipeline.resize(maxDims.width, maxDims.height, {
        fit: 'inside',
        withoutEnlargement: true,
      });
    }

    // Convert to WebP for non-animated images (better compression)
    pipeline = pipeline.webp({ quality: 85 });

    const processed = await pipeline.toBuffer({ resolveWithObject: true });

    return {
      buffer: processed.data,
      width: processed.info.width,
      height: processed.info.height,
    };
  }

  /**
   * Get a CDN URL for a file.
   */
  function getFileUrl(bucket: string, key: string): string {
    return `${ctx.env.CDN_BASE_URL}/${bucket}/${key}`;
  }

  /**
   * Delete a file from MinIO.
   */
  async function deleteFile(bucket: string, key: string): Promise<void> {
    await ctx.minio.removeObject(bucket, key);
    logger.info({ bucket, key }, 'File deleted');
  }

  /**
   * Get pending upload metadata from Redis.
   */
  async function getPendingUpload(fileId: string): Promise<UploadResult | null> {
    const data = await ctx.redis.get(`pending_upload:${fileId}`);
    if (!data) return null;
    return JSON.parse(data) as UploadResult;
  }

  /**
   * Remove pending upload from Redis.
   */
  async function clearPendingUpload(fileId: string): Promise<void> {
    await ctx.redis.del(`pending_upload:${fileId}`);
  }

  return {
    uploadFile,
    processImage,
    getFileUrl,
    resolveAssetByHash,
    deleteFile,
    getPendingUpload,
    clearPendingUpload,
  };
}

export type FilesService = ReturnType<typeof createFilesService>;

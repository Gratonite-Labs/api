import { Router } from 'express';
import multer from 'multer';
import type { AppContext } from '../../lib/context.js';
import { requireAuth, optionalAuth } from '../../middleware/auth.js';
import { uploadRateLimiter } from '../../middleware/rate-limiter.js';
import { createFilesService } from './files.service.js';
import { uploadFileSchema } from './files.schemas.js';
import { buildPublicFileHeaders } from './files.service.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB max (per-purpose limits enforced in service)
});

export function filesRouter(ctx: AppContext): Router {
  const router = Router();
  const auth = requireAuth(ctx);
  const optAuth = optionalAuth(ctx);
  const filesService = createFilesService(ctx);

  // ── POST /files/upload — Upload a file ───────────────────────────────

  router.post('/files/upload', auth, uploadRateLimiter, upload.single('file'), async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ code: 'NO_FILE', message: 'No file provided' });
    }

    const parsed = uploadFileSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        code: 'VALIDATION_ERROR',
        message: 'Invalid upload metadata',
        details: parsed.error.flatten().fieldErrors,
      });
    }

    try {
      const result = await filesService.uploadFile(req.file, parsed.data, req.user!.userId);
      res.status(201).json(result);
    } catch (err: any) {
      if (err.code === 'FILE_TOO_LARGE') {
        return res.status(413).json({
          code: 'FILE_TOO_LARGE',
          message: `File exceeds maximum size of ${Math.round(err.maxSize / 1024)}KB for ${parsed.data.purpose}`,
        });
      }
      if (err.code === 'INVALID_FILE_TYPE') {
        return res.status(415).json({ code: 'INVALID_FILE_TYPE', message: err.message });
      }
      throw err;
    }
  });

  // ── GET /files/:fileId — Get pending upload info ─────────────────────

  router.get('/files/:fileId', optAuth, async (req, res) => {
    const fileId = req.params.fileId;

    // Compatibility path used by avatar/banner/icon rendering across the app.
    // If request looks like a file hash (contains extension), resolve and stream object.
    if (fileId.includes('.')) {
      const asset = await filesService.resolveAssetByHash(fileId);
      if (!asset) {
        return res.status(404).json({ code: 'NOT_FOUND', message: 'Asset not found' });
      }

      try {
        const stat = await ctx.minio.statObject(asset.bucket, asset.key);
        const contentType = stat.metaData?.['content-type'];
        const fileName = asset.key.split('/').pop() ?? fileId;
        const headers = buildPublicFileHeaders(contentType, fileName);
        for (const [key, value] of Object.entries(headers)) {
          res.setHeader(key, value);
        }

        const stream = await ctx.minio.getObject(asset.bucket, asset.key);
        stream.on('error', () => {
          if (!res.headersSent) {
            res.status(500).json({ code: 'FILE_STREAM_ERROR', message: 'Failed to read file' });
          } else {
            res.end();
          }
        });
        stream.pipe(res);
        return;
      } catch {
        return res.status(500).json({ code: 'FILE_STREAM_ERROR', message: 'Failed to read file' });
      }
    }

    if (!req.user) {
      return res.status(401).json({ code: 'UNAUTHORIZED', message: 'Authentication required' });
    }

    const upload = await filesService.getPendingUpload(fileId);
    if (!upload) {
      return res.status(404).json({ code: 'NOT_FOUND', message: 'File not found or expired' });
    }
    res.json(upload);
  });

  return router;
}

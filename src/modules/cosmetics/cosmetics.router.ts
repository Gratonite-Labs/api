import { Router } from 'express';
import multer from 'multer';
import { randomUUID } from 'crypto';
import type { AppContext } from '../../lib/context.js';
import { requireAuth } from '../../middleware/auth.js';
import { createCosmeticsService, type CosmeticType } from './cosmetics.service.js';

const VALID_TYPES: CosmeticType[] = ['avatar_decoration', 'effect', 'nameplate', 'soundboard'];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB max
});

export function cosmeticsRouter(ctx: AppContext): Router {
  const router = Router();
  const auth = requireAuth(ctx);
  const service = createCosmeticsService(ctx);

  // ── POST /cosmetics/upload — Upload preview + asset images ───────────────
  router.post(
    '/cosmetics/upload',
    auth,
    upload.fields([
      { name: 'preview_image', maxCount: 1 },
      { name: 'asset_image', maxCount: 1 },
    ]),
    async (req, res) => {
      const files = req.files as Record<string, Express.Multer.File[]> | undefined;
      const result: { preview_image_url?: string; asset_url?: string } = {};

      const baseUrl = `http://${ctx.env.MINIO_ENDPOINT}:${ctx.env.MINIO_PORT}/cosmetics`;

      for (const [field, fileArr] of Object.entries(files ?? {})) {
        const file = fileArr[0];
        if (!file) continue;

        const ext = file.originalname.split('.').pop() ?? 'bin';
        const key = `${randomUUID()}.${ext}`;
        const bucket = 'cosmetics';

        // Ensure bucket exists
        const exists = await ctx.minio.bucketExists(bucket);
        if (!exists) {
          await ctx.minio.makeBucket(bucket);
          const policy = JSON.stringify({
            Version: '2012-10-17',
            Statement: [
              {
                Effect: 'Allow',
                Principal: { AWS: ['*'] },
                Action: ['s3:GetObject'],
                Resource: [`arn:aws:s3:::${bucket}/*`],
              },
            ],
          });
          await ctx.minio.setBucketPolicy(bucket, policy);
        }

        await ctx.minio.putObject(bucket, key, file.buffer, file.size, {
          'Content-Type': file.mimetype,
        });

        const url = `${baseUrl}/${key}`;
        if (field === 'preview_image') result.preview_image_url = url;
        if (field === 'asset_image') result.asset_url = url;
      }

      return res.json(result);
    },
  );

  // ── POST /cosmetics — Create a draft cosmetic ────────────────────────────
  router.post('/cosmetics', auth, async (req, res) => {
    const { name, description, type, previewImageUrl, assetUrl, price } = req.body;

    if (!name || typeof name !== 'string') {
      return res.status(400).json({ code: 'INVALID_NAME' });
    }
    if (!type || !VALID_TYPES.includes(type)) {
      return res.status(400).json({ code: 'INVALID_TYPE' });
    }

    const cosmetic = await service.createCosmetic(req.user!.userId, {
      name: name.trim(),
      description,
      type,
      previewImageUrl,
      assetUrl,
      price: typeof price === 'number' ? price : 0,
    });
    return res.status(201).json(cosmetic);
  });

  // ── GET /cosmetics/marketplace — Browse published cosmetics ──────────────
  router.get('/cosmetics/marketplace', async (req, res) => {
    const type = req.query['type'] as CosmeticType | undefined;
    const limit = Math.min(Number(req.query['limit']) || 20, 100);
    const offset = Number(req.query['offset']) || 0;
    const items = await service.listPublished({ type, limit, offset });
    return res.json(items);
  });

  // ── GET /cosmetics/mine — Authenticated creator's own cosmetics ──────────
  router.get('/cosmetics/mine', auth, async (req, res) => {
    const items = await service.listMine(req.user!.userId);
    return res.json(items);
  });

  // ── GET /cosmetics/creator/:creatorId — Published cosmetics by creator ───
  router.get('/cosmetics/creator/:creatorId', async (req, res) => {
    const limit = Math.min(Number(req.query['limit']) || 20, 100);
    const offset = Number(req.query['offset']) || 0;
    const items = await service.listByCreator(req.params['creatorId'] as string, limit, offset);
    return res.json(items);
  });

  // ── GET /cosmetics/:id — Get cosmetic details ────────────────────────────
  router.get('/cosmetics/:id', async (req, res) => {
    try {
      const cosmetic = await service.getCosmetic(req.params['id'] as string);
      return res.json(cosmetic);
    } catch (err) {
      if (err instanceof Error && err.message === 'NOT_FOUND') {
        return res.status(404).json({ code: 'NOT_FOUND' });
      }
      throw err;
    }
  });

  // ── PATCH /cosmetics/:id — Update cosmetic ───────────────────────────────
  router.patch('/cosmetics/:id', auth, async (req, res) => {
    const { name, description, previewImageUrl, assetUrl, price, isPublished } = req.body;
    try {
      const cosmetic = await service.updateCosmetic(req.params['id'] as string, req.user!.userId, {
        name,
        description,
        previewImageUrl,
        assetUrl,
        price,
        isPublished,
      });
      return res.json(cosmetic);
    } catch (err) {
      if (err instanceof Error) {
        if (err.message === 'NOT_FOUND') return res.status(404).json({ code: 'NOT_FOUND' });
        if (err.message === 'FORBIDDEN') return res.status(403).json({ code: 'FORBIDDEN' });
      }
      throw err;
    }
  });

  // ── DELETE /cosmetics/:id — Delete a draft cosmetic ─────────────────────
  router.delete('/cosmetics/:id', auth, async (req, res) => {
    try {
      await service.deleteCosmetic(req.params['id'] as string, req.user!.userId);
      return res.status(204).end();
    } catch (err) {
      if (err instanceof Error) {
        if (err.message === 'NOT_FOUND') return res.status(404).json({ code: 'NOT_FOUND' });
        if (err.message === 'FORBIDDEN') return res.status(403).json({ code: 'FORBIDDEN' });
        if (err.message === 'CANNOT_DELETE_PUBLISHED')
          return res.status(409).json({ code: 'CANNOT_DELETE_PUBLISHED' });
      }
      throw err;
    }
  });

  // ── POST /cosmetics/:id/purchase — Buy a cosmetic ────────────────────────
  router.post('/cosmetics/:id/purchase', auth, async (req, res) => {
    try {
      const result = await service.purchaseCosmetic(req.user!.userId, req.params['id'] as string);
      return res.status(201).json(result);
    } catch (err) {
      if (err instanceof Error) {
        if (err.message === 'NOT_FOUND') return res.status(404).json({ code: 'NOT_FOUND' });
        if (err.message === 'NOT_AVAILABLE')
          return res.status(403).json({ code: 'NOT_AVAILABLE' });
        if (err.message === 'ALREADY_OWNED')
          return res.status(409).json({ code: 'ALREADY_OWNED' });
        if (err.message === 'INSUFFICIENT_FUNDS')
          return res.status(402).json({ code: 'INSUFFICIENT_FUNDS', message: 'Not enough Gratonites' });
      }
      throw err;
    }
  });

  // ── PATCH /cosmetics/:id/equip — Equip a cosmetic ────────────────────────
  router.patch('/cosmetics/:id/equip', auth, async (req, res) => {
    try {
      const purchase = await service.equipCosmetic(req.user!.userId, req.params['id'] as string);
      return res.json(purchase);
    } catch (err) {
      if (err instanceof Error) {
        if (err.message === 'NOT_FOUND') return res.status(404).json({ code: 'NOT_FOUND' });
        if (err.message === 'NOT_OWNED') return res.status(403).json({ code: 'NOT_OWNED' });
      }
      throw err;
    }
  });

  // ── DELETE /cosmetics/:id/equip — Unequip a cosmetic ─────────────────────
  router.delete('/cosmetics/:id/equip', auth, async (req, res) => {
    try {
      const purchase = await service.unequipCosmetic(req.user!.userId, req.params['id'] as string);
      return res.json(purchase);
    } catch (err) {
      if (err instanceof Error) {
        if (err.message === 'NOT_OWNED') return res.status(403).json({ code: 'NOT_OWNED' });
      }
      throw err;
    }
  });

  // ── GET /users/@me/equipped-cosmetics — Equipped cosmetics for current user
  router.get('/users/@me/equipped-cosmetics', auth, async (req, res) => {
    const equipped = await service.getEquipped(req.user!.userId);
    return res.json(equipped);
  });

  // ── GET /cosmetics/:id/stats — Sales stats for creator ───────────────────
  router.get('/cosmetics/:id/stats', auth, async (req, res) => {
    try {
      const stats = await service.getCosmeticStats(req.params['id'] as string, req.user!.userId);
      return res.json(stats);
    } catch (err) {
      if (err instanceof Error) {
        if (err.message === 'NOT_FOUND') return res.status(404).json({ code: 'NOT_FOUND' });
        if (err.message === 'FORBIDDEN') return res.status(403).json({ code: 'FORBIDDEN' });
      }
      throw err;
    }
  });

  return router;
}

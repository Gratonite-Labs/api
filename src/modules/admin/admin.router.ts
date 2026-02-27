import { Router } from 'express';
import multer from 'multer';
import type { AppContext } from '../../lib/context.js';
import { requireAuth } from '../../middleware/auth.js';
import { createAdminService } from './admin.service.js';

const assetUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
});

export function adminRouter(ctx: AppContext): Router {
  const router = Router();
  const auth = requireAuth(ctx);
  const service = createAdminService(ctx);

  // Admin gate middleware
  function requireAdmin(req: Express.Request, res: any, next: any) {
    if (!req.user || !service.isAdmin(req.user.username)) {
      return res.status(403).json({ code: 'FORBIDDEN', message: 'Admin access required' });
    }
    next();
  }

  // Update a shop item
  router.patch('/admin/shop/items/:id', auth, requireAdmin, async (req, res) => {
    try {
      const updated = await service.updateShopItem(req.params.id, req.body);
      return res.json(updated);
    } catch (err) {
      if (err instanceof Error && err.message === 'ITEM_NOT_FOUND') {
        return res.status(404).json({ code: 'ITEM_NOT_FOUND' });
      }
      throw err;
    }
  });

  // Upload asset for a shop item
  router.post('/admin/shop/items/:id/asset', auth, requireAdmin, assetUpload.single('file'), async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ code: 'NO_FILE', message: 'File required' });
    }

    try {
      const assetHash = await service.uploadShopAsset(req.params.id, req.file.buffer, req.file.mimetype);
      return res.json({ assetHash });
    } catch (err) {
      if (err instanceof Error && err.message === 'ITEM_NOT_FOUND') {
        return res.status(404).json({ code: 'ITEM_NOT_FOUND' });
      }
      throw err;
    }
  });

  // Create a new shop item
  router.post('/admin/shop/items', auth, requireAdmin, async (req, res) => {
    const { name, description, type, category, price } = req.body;

    if (!name || !type || !category || typeof price !== 'number') {
      return res.status(400).json({ code: 'INVALID_INPUT', message: 'name, type, category, and price required' });
    }

    const created = await service.createShopItem({ name, description, type, category, price });
    return res.status(201).json(created);
  });

  // Soft delete a shop item
  router.delete('/admin/shop/items/:id', auth, requireAdmin, async (req, res) => {
    try {
      await service.deleteShopItem(req.params.id);
      return res.json({ success: true });
    } catch (err) {
      if (err instanceof Error && err.message === 'ITEM_NOT_FOUND') {
        return res.status(404).json({ code: 'ITEM_NOT_FOUND' });
      }
      throw err;
    }
  });

  return router;
}

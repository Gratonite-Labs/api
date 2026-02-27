import { Router } from 'express';
import type { AppContext } from '../../lib/context.js';
import { requireAuth } from '../../middleware/auth.js';
import { createShopService } from './shop.service.js';

export function shopRouter(ctx: AppContext): Router {
  const router = Router();
  const auth = requireAuth(ctx);
  const service = createShopService(ctx);

  // Get all shop items (optionally filtered by category)
  router.get('/shop/items', async (req, res) => {
    const category = req.query.category as string | undefined;
    const items = await service.getItems(category);
    return res.json(items);
  });

  // Get featured items
  router.get('/shop/featured', async (req, res) => {
    const items = await service.getFeaturedItems();
    return res.json(items);
  });

  // Get user's inventory
  router.get('/shop/inventory', auth, async (req, res) => {
    const inventory = await service.getInventory(req.user!.userId);
    return res.json(inventory);
  });

  // Purchase an item
  router.post('/shop/purchase', auth, async (req, res) => {
    const { itemId } = req.body;
    
    if (!itemId || typeof itemId !== 'string') {
      return res.status(400).json({ code: 'INVALID_ITEM_ID' });
    }

    try {
      const result = await service.purchaseItem(req.user!.userId, itemId);
      return res.status(201).json(result);
    } catch (err) {
      if (err instanceof Error) {
        if (err.message === 'ITEM_NOT_FOUND') {
          return res.status(404).json({ code: 'ITEM_NOT_FOUND' });
        }
        if (err.message === 'ALREADY_OWNED') {
          return res.status(409).json({ code: 'ALREADY_OWNED' });
        }
        if (err.message === 'INSUFFICIENT_FUNDS') {
          return res.status(402).json({ 
            code: 'INSUFFICIENT_FUNDS',
            message: 'Not enough Gratonites'
          });
        }
      }
      throw err;
    }
  });

  // Equip/unequip an item
  router.post('/shop/equip', auth, async (req, res) => {
    const { itemId, equipped, metadata } = req.body;

    if (!itemId || typeof itemId !== 'string') {
      return res.status(400).json({ code: 'INVALID_ITEM_ID' });
    }

    if (typeof equipped !== 'boolean') {
      return res.status(400).json({ code: 'INVALID_EQUIPPED_STATE' });
    }

    try {
      const result = await service.setEquipped(req.user!.userId, itemId, equipped, metadata);
      return res.json(result);
    } catch (err) {
      if (err instanceof Error && err.message === 'ITEM_NOT_OWNED') {
        return res.status(404).json({ code: 'ITEM_NOT_OWNED' });
      }
      throw err;
    }
  });

  // Get purchase history
  router.get('/shop/purchases', auth, async (req, res) => {
    const limit = parseInt(req.query.limit as string) || 20;
    const history = await service.getPurchaseHistory(req.user!.userId, limit);
    return res.json(history);
  });

  return router;
}

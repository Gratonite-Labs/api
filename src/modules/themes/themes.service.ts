import { and, eq, desc, asc, sql, inArray } from 'drizzle-orm';
import { themePresets, themeInstalls } from '@gratonite/db';
import type { AppContext } from '../../lib/context.js';
import { generateId } from '../../lib/snowflake.js';
import { logger } from '../../lib/logger.js';
import type { CreateThemeInput, UpdateThemeInput } from './themes.schemas.js';

// ============================================================================
// Built-in theme definitions
// ============================================================================

const BUILT_IN_THEMES: Array<{
  slug: string;
  name: string;
  description: string;
  previewColors: string[];
  tags: string[];
  tokens: Record<string, string>;
}> = [
  {
    slug: 'obsidian',
    name: 'Obsidian',
    description: 'Deep, layered, luminous. The signature Gratonite look.',
    previewColors: ['#0B0E17', '#7C6AFF', '#FF8B5A'],
    tags: ['dark', 'default'],
    tokens: {
      'bg-deep': '#0B0E17',
      'bg-base': '#12162B',
      'bg-elevated': '#1A1F3A',
      'bg-overlay': 'rgba(26, 31, 58, 0.85)',
      'bg-input': '#161B32',
      'accent-primary': '#7C6AFF',
      'accent-secondary': '#FF8B5A',
      'accent-tertiary': '#5ADBFF',
      'accent-success': '#43B581',
      'accent-warning': '#FAA61A',
      'accent-danger': '#F04747',
      'text-primary': '#F0EDF6',
      'text-secondary': '#9B95B0',
      'text-tertiary': '#5E5878',
      'text-link': '#7C6AFF',
      'text-on-accent': '#FFFFFF',
      'border-subtle': 'rgba(124, 106, 255, 0.12)',
      'border-default': 'rgba(124, 106, 255, 0.2)',
      'border-strong': 'rgba(124, 106, 255, 0.35)',
      'glow-accent': 'rgba(124, 106, 255, 0.25)',
      'gradient-surface': 'linear-gradient(135deg, #12162B 0%, #1A1040 100%)',
      'gradient-header': 'linear-gradient(135deg, #7C6AFF 0%, #FF8B5A 100%)',
      'noise-opacity': '0.03',
      'glass-opacity': '0.85',
    },
  },
  {
    slug: 'moonstone',
    name: 'Moonstone',
    description: 'Soft, approachable light mode with lavender and sage.',
    previewColors: ['#F5F3F0', '#7B68EE', '#8FBC8F'],
    tags: ['light'],
    tokens: {
      'bg-deep': '#F5F3F0',
      'bg-base': '#FAFAF8',
      'bg-elevated': '#FFFFFF',
      'bg-overlay': 'rgba(255, 255, 255, 0.9)',
      'bg-input': '#F0EEEB',
      'accent-primary': '#7B68EE',
      'accent-secondary': '#8FBC8F',
      'accent-tertiary': '#DDA0DD',
      'accent-success': '#3CB371',
      'accent-warning': '#DAA520',
      'accent-danger': '#CD5C5C',
      'text-primary': '#2D2B3A',
      'text-secondary': '#6B6880',
      'text-tertiary': '#9B98AB',
      'text-link': '#7B68EE',
      'text-on-accent': '#FFFFFF',
      'border-subtle': 'rgba(123, 104, 238, 0.1)',
      'border-default': 'rgba(123, 104, 238, 0.18)',
      'border-strong': 'rgba(123, 104, 238, 0.3)',
      'glow-accent': 'rgba(123, 104, 238, 0.2)',
      'gradient-surface': 'linear-gradient(135deg, #FAFAF8 0%, #F0EEEB 100%)',
      'gradient-header': 'linear-gradient(135deg, #7B68EE 0%, #8FBC8F 100%)',
      'noise-opacity': '0.02',
      'glass-opacity': '0.92',
    },
  },
  {
    slug: 'ember',
    name: 'Ember',
    description: 'Warm, cozy dark theme with rust and golden amber.',
    previewColors: ['#1A1210', '#D4683A', '#E8A838'],
    tags: ['dark', 'warm'],
    tokens: {
      'bg-deep': '#1A1210',
      'bg-base': '#231B17',
      'bg-elevated': '#2E2420',
      'bg-overlay': 'rgba(46, 36, 32, 0.88)',
      'bg-input': '#1F1815',
      'accent-primary': '#D4683A',
      'accent-secondary': '#E8A838',
      'accent-tertiary': '#C49A6C',
      'accent-success': '#6B8E23',
      'accent-warning': '#E8A838',
      'accent-danger': '#CD5C5C',
      'text-primary': '#F5E6D3',
      'text-secondary': '#B8A08C',
      'text-tertiary': '#7A6B5D',
      'text-link': '#D4683A',
      'text-on-accent': '#FFFFFF',
      'border-subtle': 'rgba(212, 104, 58, 0.12)',
      'border-default': 'rgba(212, 104, 58, 0.2)',
      'border-strong': 'rgba(212, 104, 58, 0.35)',
      'glow-accent': 'rgba(212, 104, 58, 0.25)',
      'gradient-surface': 'linear-gradient(135deg, #231B17 0%, #2E1F18 100%)',
      'gradient-header': 'linear-gradient(135deg, #D4683A 0%, #E8A838 100%)',
      'noise-opacity': '0.04',
      'glass-opacity': '0.88',
    },
  },
  {
    slug: 'arctic',
    name: 'Arctic',
    description: 'Cool, clean, focused. Navy and ice blue.',
    previewColors: ['#0A1628', '#5ADBFF', '#FFFFFF'],
    tags: ['dark', 'cool'],
    tokens: {
      'bg-deep': '#0A1628',
      'bg-base': '#0F1E35',
      'bg-elevated': '#152845',
      'bg-overlay': 'rgba(21, 40, 69, 0.88)',
      'bg-input': '#0D1A2F',
      'accent-primary': '#5ADBFF',
      'accent-secondary': '#FFFFFF',
      'accent-tertiary': '#88C8FF',
      'accent-success': '#4ECDC4',
      'accent-warning': '#FFE066',
      'accent-danger': '#FF6B6B',
      'text-primary': '#E8F0FE',
      'text-secondary': '#8BA4C4',
      'text-tertiary': '#506882',
      'text-link': '#5ADBFF',
      'text-on-accent': '#0A1628',
      'border-subtle': 'rgba(90, 219, 255, 0.1)',
      'border-default': 'rgba(90, 219, 255, 0.18)',
      'border-strong': 'rgba(90, 219, 255, 0.3)',
      'glow-accent': 'rgba(90, 219, 255, 0.2)',
      'gradient-surface': 'linear-gradient(135deg, #0F1E35 0%, #0A2240 100%)',
      'gradient-header': 'linear-gradient(135deg, #5ADBFF 0%, #88C8FF 100%)',
      'noise-opacity': '0.02',
      'glass-opacity': '0.85',
    },
  },
  {
    slug: 'void',
    name: 'Void',
    description: 'Ultra-dark OLED-friendly with neon accents.',
    previewColors: ['#000000', '#9B59FF', '#00FFD5'],
    tags: ['dark', 'oled', 'neon'],
    tokens: {
      'bg-deep': '#000000',
      'bg-base': '#080808',
      'bg-elevated': '#121212',
      'bg-overlay': 'rgba(18, 18, 18, 0.92)',
      'bg-input': '#0A0A0A',
      'accent-primary': '#9B59FF',
      'accent-secondary': '#00FFD5',
      'accent-tertiary': '#FF59B4',
      'accent-success': '#00FF88',
      'accent-warning': '#FFD500',
      'accent-danger': '#FF3D3D',
      'text-primary': '#EEEEEE',
      'text-secondary': '#888888',
      'text-tertiary': '#555555',
      'text-link': '#9B59FF',
      'text-on-accent': '#000000',
      'border-subtle': 'rgba(155, 89, 255, 0.12)',
      'border-default': 'rgba(155, 89, 255, 0.22)',
      'border-strong': 'rgba(155, 89, 255, 0.4)',
      'glow-accent': 'rgba(155, 89, 255, 0.3)',
      'gradient-surface': 'linear-gradient(135deg, #080808 0%, #0D0020 100%)',
      'gradient-header': 'linear-gradient(135deg, #9B59FF 0%, #00FFD5 100%)',
      'noise-opacity': '0.01',
      'glass-opacity': '0.9',
    },
  },
  {
    slug: 'terracotta',
    name: 'Terracotta',
    description: 'Earthy, grounded tones of warm brown and burnt orange.',
    previewColors: ['#1C1510', '#C4753B', '#E8C88A'],
    tags: ['dark', 'warm', 'earthy'],
    tokens: {
      'bg-deep': '#1C1510',
      'bg-base': '#251D16',
      'bg-elevated': '#312720',
      'bg-overlay': 'rgba(49, 39, 32, 0.88)',
      'bg-input': '#211A14',
      'accent-primary': '#C4753B',
      'accent-secondary': '#E8C88A',
      'accent-tertiary': '#A0845C',
      'accent-success': '#7A9A4E',
      'accent-warning': '#E8C88A',
      'accent-danger': '#C4533B',
      'text-primary': '#F0E4D4',
      'text-secondary': '#B5A48E',
      'text-tertiary': '#7A6E5F',
      'text-link': '#C4753B',
      'text-on-accent': '#FFFFFF',
      'border-subtle': 'rgba(196, 117, 59, 0.12)',
      'border-default': 'rgba(196, 117, 59, 0.2)',
      'border-strong': 'rgba(196, 117, 59, 0.35)',
      'glow-accent': 'rgba(196, 117, 59, 0.25)',
      'gradient-surface': 'linear-gradient(135deg, #251D16 0%, #2E2018 100%)',
      'gradient-header': 'linear-gradient(135deg, #C4753B 0%, #E8C88A 100%)',
      'noise-opacity': '0.04',
      'glass-opacity': '0.87',
    },
  },
  {
    slug: 'sakura',
    name: 'Sakura',
    description: 'Delicate, elegant. Soft pink, ivory, and gold.',
    previewColors: ['#FFF5F5', '#FF8FA3', '#FFD700'],
    tags: ['light', 'pink', 'elegant'],
    tokens: {
      'bg-deep': '#FFF5F5',
      'bg-base': '#FFFAFA',
      'bg-elevated': '#FFFFFF',
      'bg-overlay': 'rgba(255, 255, 255, 0.92)',
      'bg-input': '#FFF0F0',
      'accent-primary': '#FF8FA3',
      'accent-secondary': '#FFD700',
      'accent-tertiary': '#FFB6C1',
      'accent-success': '#90EE90',
      'accent-warning': '#FFD700',
      'accent-danger': '#FF6B6B',
      'text-primary': '#3D2B2B',
      'text-secondary': '#8B6B6B',
      'text-tertiary': '#BBA0A0',
      'text-link': '#FF8FA3',
      'text-on-accent': '#FFFFFF',
      'border-subtle': 'rgba(255, 143, 163, 0.12)',
      'border-default': 'rgba(255, 143, 163, 0.2)',
      'border-strong': 'rgba(255, 143, 163, 0.35)',
      'glow-accent': 'rgba(255, 143, 163, 0.2)',
      'gradient-surface': 'linear-gradient(135deg, #FFFAFA 0%, #FFF0F5 100%)',
      'gradient-header': 'linear-gradient(135deg, #FF8FA3 0%, #FFD700 100%)',
      'noise-opacity': '0.02',
      'glass-opacity': '0.93',
    },
  },
  {
    slug: 'neon',
    name: 'Neon',
    description: 'Cyberpunk energy. Black with hot pink and electric green.',
    previewColors: ['#0A0A0A', '#FF1493', '#00FF41'],
    tags: ['dark', 'neon', 'cyberpunk'],
    tokens: {
      'bg-deep': '#0A0A0A',
      'bg-base': '#111111',
      'bg-elevated': '#1A1A1A',
      'bg-overlay': 'rgba(26, 26, 26, 0.9)',
      'bg-input': '#0E0E0E',
      'accent-primary': '#FF1493',
      'accent-secondary': '#00FF41',
      'accent-tertiary': '#00BFFF',
      'accent-success': '#00FF41',
      'accent-warning': '#FFD700',
      'accent-danger': '#FF1744',
      'text-primary': '#F0F0F0',
      'text-secondary': '#999999',
      'text-tertiary': '#555555',
      'text-link': '#FF1493',
      'text-on-accent': '#000000',
      'border-subtle': 'rgba(255, 20, 147, 0.12)',
      'border-default': 'rgba(255, 20, 147, 0.25)',
      'border-strong': 'rgba(255, 20, 147, 0.4)',
      'glow-accent': 'rgba(255, 20, 147, 0.3)',
      'gradient-surface': 'linear-gradient(135deg, #111111 0%, #150015 100%)',
      'gradient-header': 'linear-gradient(135deg, #FF1493 0%, #00FF41 100%)',
      'noise-opacity': '0.02',
      'glass-opacity': '0.88',
    },
  },
];

// ============================================================================
// Service
// ============================================================================

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64);
}

export function createThemesService(ctx: AppContext) {
  async function seedBuiltInThemes() {
    for (const theme of BUILT_IN_THEMES) {
      const existing = await ctx.db
        .select({ id: themePresets.id })
        .from(themePresets)
        .where(eq(themePresets.slug, theme.slug))
        .limit(1);

      if (existing.length === 0) {
        await ctx.db.insert(themePresets).values({
          id: generateId(),
          name: theme.name,
          slug: theme.slug,
          description: theme.description,
          authorId: null,
          tokens: theme.tokens,
          builtIn: true,
          visibility: 'public',
          tags: theme.tags,
          previewColors: theme.previewColors,
        });
        logger.info({ slug: theme.slug }, 'Seeded built-in theme');
      }
    }
  }

  async function getBuiltInThemes() {
    return ctx.db
      .select()
      .from(themePresets)
      .where(eq(themePresets.builtIn, true))
      .orderBy(asc(themePresets.name));
  }

  async function getTheme(themeId: string) {
    const rows = await ctx.db
      .select()
      .from(themePresets)
      .where(eq(themePresets.id, themeId))
      .limit(1);
    return rows[0] || null;
  }

  async function createTheme(authorId: string, input: CreateThemeInput) {
    const id = generateId();
    const slug = slugify(input.name) + '-' + id.slice(-6);

    const [theme] = await ctx.db
      .insert(themePresets)
      .values({
        id,
        name: input.name,
        slug,
        description: input.description || null,
        authorId,
        tokens: input.tokens,
        builtIn: false,
        visibility: input.visibility,
        tags: input.tags,
        previewColors: input.previewColors,
      })
      .returning();

    return theme;
  }

  async function updateTheme(themeId: string, authorId: string, input: UpdateThemeInput) {
    const existing = await getTheme(themeId);
    if (!existing || existing.authorId !== authorId || existing.builtIn) return null;

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (input.name !== undefined) updates.name = input.name;
    if (input.description !== undefined) updates.description = input.description;
    if (input.tokens !== undefined) updates.tokens = input.tokens;
    if (input.tags !== undefined) updates.tags = input.tags;
    if (input.previewColors !== undefined) updates.previewColors = input.previewColors;
    if (input.visibility !== undefined) updates.visibility = input.visibility;

    const [updated] = await ctx.db
      .update(themePresets)
      .set(updates)
      .where(eq(themePresets.id, themeId))
      .returning();

    return updated;
  }

  async function deleteTheme(themeId: string, authorId: string) {
    const existing = await getTheme(themeId);
    if (!existing || existing.authorId !== authorId || existing.builtIn) return false;

    await ctx.db.delete(themePresets).where(eq(themePresets.id, themeId));
    return true;
  }

  async function publishTheme(themeId: string, authorId: string) {
    const existing = await getTheme(themeId);
    if (!existing || existing.authorId !== authorId || existing.builtIn) return null;

    const [updated] = await ctx.db
      .update(themePresets)
      .set({ visibility: 'public', updatedAt: new Date() })
      .where(eq(themePresets.id, themeId))
      .returning();

    return updated;
  }

  async function browseThemes(options: {
    tag?: string;
    sort: string;
    limit: number;
    offset: number;
    builtIn?: boolean;
  }) {
    const conditions = [eq(themePresets.visibility, 'public')];
    if (options.builtIn !== undefined) {
      conditions.push(eq(themePresets.builtIn, options.builtIn));
    }

    let query = ctx.db
      .select()
      .from(themePresets)
      .where(and(...conditions))
      .limit(options.limit)
      .offset(options.offset);

    if (options.sort === 'popular') {
      query = query.orderBy(desc(themePresets.installCount));
    } else if (options.sort === 'newest') {
      query = query.orderBy(desc(themePresets.createdAt));
    } else if (options.sort === 'top_rated') {
      query = query.orderBy(desc(themePresets.ratingSum));
    }

    const themes = await query;

    // Filter by tag in application layer (JSONB array contains)
    if (options.tag) {
      return themes.filter((t: any) =>
        Array.isArray(t.tags) && t.tags.includes(options.tag),
      );
    }

    return themes;
  }

  async function installTheme(
    userId: string,
    themeId: string,
    scope: string,
    scopeId?: string,
  ) {
    const theme = await getTheme(themeId);
    if (!theme) return null;

    // Check if already installed
    const existing = await ctx.db
      .select()
      .from(themeInstalls)
      .where(and(eq(themeInstalls.userId, userId), eq(themeInstalls.themeId, themeId)))
      .limit(1);

    if (existing.length > 0) return existing[0];

    const [install] = await ctx.db
      .insert(themeInstalls)
      .values({
        userId,
        themeId,
        scope,
        scopeId: scopeId || null,
      })
      .returning();

    // Increment install count
    await ctx.db
      .update(themePresets)
      .set({ installCount: sql`${themePresets.installCount} + 1` })
      .where(eq(themePresets.id, themeId));

    return install;
  }

  async function uninstallTheme(userId: string, themeId: string) {
    const existing = await ctx.db
      .select()
      .from(themeInstalls)
      .where(and(eq(themeInstalls.userId, userId), eq(themeInstalls.themeId, themeId)))
      .limit(1);

    if (existing.length === 0) return false;

    await ctx.db
      .delete(themeInstalls)
      .where(and(eq(themeInstalls.userId, userId), eq(themeInstalls.themeId, themeId)));

    // Decrement install count
    await ctx.db
      .update(themePresets)
      .set({ installCount: sql`GREATEST(${themePresets.installCount} - 1, 0)` })
      .where(eq(themePresets.id, themeId));

    return true;
  }

  async function rateTheme(userId: string, themeId: string, rating: number) {
    // Use Redis to prevent double-rating
    const rateKey = `theme_rated:${themeId}:${userId}`;
    const previousRating = await ctx.redis.get(rateKey);

    if (previousRating) {
      // Update: subtract old, add new
      const oldRating = parseInt(previousRating, 10);
      const diff = rating - oldRating;
      await ctx.db
        .update(themePresets)
        .set({ ratingSum: sql`${themePresets.ratingSum} + ${diff}` })
        .where(eq(themePresets.id, themeId));
    } else {
      // First rating
      await ctx.db
        .update(themePresets)
        .set({
          ratingSum: sql`${themePresets.ratingSum} + ${rating}`,
          ratingCount: sql`${themePresets.ratingCount} + 1`,
        })
        .where(eq(themePresets.id, themeId));
    }

    // Store rating in Redis (no TTL — permanent)
    await ctx.redis.set(rateKey, rating.toString());

    return { rated: true, rating };
  }

  async function getUserThemes(userId: string) {
    const created = await ctx.db
      .select()
      .from(themePresets)
      .where(eq(themePresets.authorId, userId))
      .orderBy(desc(themePresets.updatedAt));

    const installRows = await ctx.db
      .select()
      .from(themeInstalls)
      .where(eq(themeInstalls.userId, userId));

    let installed: any[] = [];
    if (installRows.length > 0) {
      const themeIds = installRows.map((r) => r.themeId);
      installed = await ctx.db
        .select()
        .from(themePresets)
        .where(inArray(themePresets.id, themeIds));
    }

    return { created, installed };
  }

  return {
    seedBuiltInThemes,
    getBuiltInThemes,
    getTheme,
    createTheme,
    updateTheme,
    deleteTheme,
    publishTheme,
    browseThemes,
    installTheme,
    uninstallTheme,
    rateTheme,
    getUserThemes,
  };
}

export type ThemesService = ReturnType<typeof createThemesService>;

import { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../../lib/context.js';
import { requireAuth } from '../../middleware/auth.js';
import { betaBugReports, userProfiles } from '@gratonite/db';
import { generateId } from '../../lib/snowflake.js';
import { and, desc, eq, inArray } from 'drizzle-orm';

const createBugReportSchema = z.object({
  title: z.string().trim().min(3).max(120),
  summary: z.string().trim().min(3).max(5000),
  steps: z.string().trim().max(10000).optional().or(z.literal('')),
  expected: z.string().trim().max(3000).optional().or(z.literal('')),
  actual: z.string().trim().max(3000).optional().or(z.literal('')),
  route: z.string().trim().max(255).optional(),
  pageUrl: z.string().trim().max(2000).optional(),
  channelLabel: z.string().trim().max(120).optional(),
  viewport: z.string().trim().max(64).optional(),
  userAgent: z.string().trim().max(2000).optional(),
  clientTimestamp: z.string().datetime().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const listBugReportsSchema = z.object({
  status: z.enum(['open', 'triaged', 'resolved', 'dismissed']).optional(),
  mine: z
    .union([z.literal('true'), z.literal('false')])
    .transform((value) => value === 'true')
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const updateBugReportSchema = z.object({
  status: z.enum(['open', 'triaged', 'resolved', 'dismissed']),
});

function parseCsvSet(value: string | undefined): Set<string> {
  return new Set(
    (value ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

export function bugReportsRouter(ctx: AppContext): Router {
  const router = Router();
  const auth = requireAuth(ctx);
  const adminUserIds = parseCsvSet(ctx.env.BUG_REPORT_ADMIN_USER_IDS);
  const adminUsernames = parseCsvSet(ctx.env.BUG_REPORT_ADMIN_USERNAMES);

  function isBugInboxAdmin(user: { userId: string; username: string }) {
    return adminUserIds.has(user.userId) || adminUsernames.has(user.username);
  }

  router.post('/bug-reports', auth, async (req, res) => {
    const parsed = createBugReportSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        code: 'VALIDATION_ERROR',
        message: 'Invalid bug report payload',
        details: parsed.error.flatten().fieldErrors,
      });
    }

    const input = parsed.data;
    const [record] = await ctx.db
      .insert(betaBugReports)
      .values({
        id: generateId(),
        reporterId: req.user!.userId,
        title: input.title,
        summary: input.summary,
        steps: input.steps?.trim() || null,
        expected: input.expected?.trim() || null,
        actual: input.actual?.trim() || null,
        route: input.route?.trim() || null,
        pageUrl: input.pageUrl?.trim() || null,
        channelLabel: input.channelLabel?.trim() || null,
        viewport: input.viewport?.trim() || null,
        userAgent: input.userAgent?.trim() || null,
        clientTimestamp: input.clientTimestamp ? new Date(input.clientTimestamp) : null,
        metadata: input.metadata ?? {},
      })
      .returning();

    return res.status(201).json(record);
  });

  router.get('/bug-reports', auth, async (req, res) => {
    const parsed = listBugReportsSchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({
        code: 'VALIDATION_ERROR',
        message: 'Invalid bug report query',
        details: parsed.error.flatten().fieldErrors,
      });
    }

    const isAdmin = isBugInboxAdmin(req.user!);
    const clauses = [];
    if (parsed.data.status) clauses.push(eq(betaBugReports.status, parsed.data.status));
    if (!isAdmin || parsed.data.mine) clauses.push(eq(betaBugReports.reporterId, req.user!.userId));

    const rows = await ctx.db
      .select()
      .from(betaBugReports)
      .where(clauses.length > 0 ? and(...clauses) : undefined)
      .orderBy(desc(betaBugReports.createdAt))
      .limit(parsed.data.limit);

    const reporterIds = Array.from(new Set(rows.map((row) => row.reporterId)));
    const reporterProfiles = reporterIds.length
      ? await ctx.db
          .select({
            userId: userProfiles.userId,
            displayName: userProfiles.displayName,
            avatarHash: userProfiles.avatarHash,
          })
          .from(userProfiles)
          .where(inArray(userProfiles.userId, reporterIds))
      : [];

    const profileByUserId = new Map(reporterProfiles.map((profile) => [profile.userId, profile]));

    return res.json({
      items: rows.map((row) => ({
        ...row,
        reporterProfile: profileByUserId.get(row.reporterId) ?? null,
      })),
      adminView: isAdmin,
    });
  });

  router.patch('/bug-reports/:reportId', auth, async (req, res) => {
    if (!isBugInboxAdmin(req.user!)) {
      return res.status(403).json({ code: 'FORBIDDEN', message: 'Bug inbox admin access required' });
    }

    const parsed = updateBugReportSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        code: 'VALIDATION_ERROR',
        message: 'Invalid bug report update payload',
        details: parsed.error.flatten().fieldErrors,
      });
    }

    const [updated] = await ctx.db
      .update(betaBugReports)
      .set({
        status: parsed.data.status,
        updatedAt: new Date(),
      })
      .where(eq(betaBugReports.id, req.params.reportId))
      .returning();

    if (!updated) {
      return res.status(404).json({ code: 'BUG_REPORT_NOT_FOUND' });
    }

    return res.json(updated);
  });

  return router;
}

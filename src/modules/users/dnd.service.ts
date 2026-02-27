import { eq } from 'drizzle-orm';
import type { AppContext } from '../../lib/context.js';
import { userDndSchedule } from '@gratonite/db';

export function createDndService(ctx: AppContext) {
  async function getSchedule(userId: string | bigint) {
    const id = typeof userId === 'bigint' ? userId.toString() : userId;
    const [row] = await ctx.db
      .select()
      .from(userDndSchedule)
      .where(eq(userDndSchedule.userId, id))
      .limit(1);
    return row ?? null;
  }

  async function updateSchedule(userId: string | bigint, data: {
    enabled?: boolean;
    startTime?: string;
    endTime?: string;
    timezone?: string;
    daysOfWeek?: number;
    allowExceptions?: string[];
  }) {
    const id = typeof userId === 'bigint' ? userId.toString() : userId;
    const existing = await getSchedule(id);
    if (existing) {
      await ctx.db
        .update(userDndSchedule)
        .set(data)
        .where(eq(userDndSchedule.userId, id));
    } else {
      await ctx.db.insert(userDndSchedule).values({
        userId: id,
        ...data,
      });
    }
    return getSchedule(id);
  }

  function isDndActive(schedule: typeof userDndSchedule.$inferSelect | null): boolean {
    if (!schedule || !schedule.enabled) return false;

    const now = new Date();
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: schedule.timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      weekday: 'short',
    });
    const parts = formatter.formatToParts(now);
    const hour = parts.find((p) => p.type === 'hour')?.value ?? '00';
    const minute = parts.find((p) => p.type === 'minute')?.value ?? '00';
    const currentTime = `${hour}:${minute}`;

    const dayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    const weekday = parts.find((p) => p.type === 'weekday')?.value ?? 'Sun';
    const dayBit = 1 << (dayMap[weekday] ?? 0);
    if (!(schedule.daysOfWeek & dayBit)) return false;

    const start = schedule.startTime;
    const end = schedule.endTime;
    if (start <= end) {
      return currentTime >= start && currentTime < end;
    } else {
      // Overnight range (e.g., 22:00 - 08:00)
      return currentTime >= start || currentTime < end;
    }
  }

  return { getSchedule, updateSchedule, isDndActive };
}

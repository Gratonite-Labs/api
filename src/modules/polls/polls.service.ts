import { eq, and, inArray, sql } from 'drizzle-orm';
import { polls, pollAnswers, pollVotes } from '@gratonite/db';
import type { AppContext } from '../../lib/context.js';
import { generateId } from '../../lib/snowflake.js';
import type { CreatePollInput, VoteInput } from './polls.schemas.js';

export function createPollsService(ctx: AppContext) {
  async function createPoll(channelId: string, guildId: string | null, authorId: string, input: CreatePollInput) {
    const pollId = generateId();

    const expiry = input.duration
      ? new Date(Date.now() + input.duration * 60 * 60 * 1000)
      : null;

    const [poll] = await ctx.db
      .insert(polls)
      .values({
        id: pollId,
        channelId,
        guildId,
        authorId,
        questionText: input.question,
        allowMultiselect: input.allowMultiselect,
        duration: input.duration ?? null,
        expiry,
      })
      .returning();

    const answerRows = input.answers.map((answer, idx) => ({
      id: generateId(),
      pollId,
      position: idx + 1,
      text: answer.text,
      emojiId: answer.emoji?.id ?? null,
      emojiName: answer.emoji?.name ?? null,
    }));

    const answers = await ctx.db.insert(pollAnswers).values(answerRows).returning();

    ctx.io.to(`channel:${channelId}`).emit('POLL_CREATE', { poll, answers });

    return { poll, answers };
  }

  async function getPoll(pollId: string) {
    const [poll] = await ctx.db.select().from(polls).where(eq(polls.id, pollId));
    if (!poll) return null;

    const answers = await ctx.db
      .select()
      .from(pollAnswers)
      .where(eq(pollAnswers.pollId, pollId))
      .orderBy(pollAnswers.position);

    return { poll, answers };
  }

  async function listChannelPolls(channelId: string, limit = 50) {
    return ctx.db
      .select()
      .from(polls)
      .where(eq(polls.channelId, channelId))
      .orderBy(sql`${polls.createdAt} desc`)
      .limit(limit);
  }

  async function vote(pollId: string, userId: string, input: VoteInput) {
    const pollData = await getPoll(pollId);
    if (!pollData) return { error: 'NOT_FOUND' as const };

    const { poll, answers } = pollData;
    if (poll.finalized) return { error: 'POLL_ENDED' as const };
    if (poll.expiry && new Date() > poll.expiry) return { error: 'POLL_ENDED' as const };

    const answerIds = input.optionIds;

    if (!poll.allowMultiselect && answerIds.length > 1) {
      return { error: 'MULTISELECT_NOT_ALLOWED' as const };
    }

    const validIds = new Set(answers.map((a) => a.id));
    for (const id of answerIds) {
      if (!validIds.has(id)) return { error: 'INVALID_OPTION' as const };
    }

    const existingVotes = await ctx.db
      .select()
      .from(pollVotes)
      .where(and(eq(pollVotes.pollId, pollId), eq(pollVotes.userId, userId)));

    if (existingVotes.length > 0) return { error: 'ALREADY_VOTED' as const };

    const voteRows = answerIds.map((answerId) => ({
      id: generateId(),
      pollId,
      answerId,
      userId,
    }));

    await ctx.db.insert(pollVotes).values(voteRows);

    await ctx.db
      .update(pollAnswers)
      .set({ voteCount: sql`${pollAnswers.voteCount} + 1` })
      .where(inArray(pollAnswers.id, answerIds));

    await ctx.db
      .update(polls)
      .set({ totalVoters: sql`${polls.totalVoters} + 1` })
      .where(eq(polls.id, pollId));

    ctx.io.to(`channel:${poll.channelId}`).emit('POLL_VOTE', { pollId, userId, answerIds });

    return { success: true };
  }

  async function endPoll(pollId: string, requesterId: string) {
    const pollData = await getPoll(pollId);
    if (!pollData) return { error: 'NOT_FOUND' as const };

    const { poll } = pollData;
    if (poll.authorId !== requesterId) return { error: 'FORBIDDEN' as const };
    if (poll.finalized) return { error: 'ALREADY_ENDED' as const };

    const [updated] = await ctx.db
      .update(polls)
      .set({ finalized: true })
      .where(eq(polls.id, pollId))
      .returning();

    ctx.io.to(`channel:${poll.channelId}`).emit('POLL_END', { pollId });

    return { poll: updated };
  }

  async function getVoters(pollId: string, answerId: string, limit = 100) {
    return ctx.db
      .select()
      .from(pollVotes)
      .where(and(eq(pollVotes.pollId, pollId), eq(pollVotes.answerId, answerId)))
      .limit(limit);
  }

  return { createPoll, getPoll, listChannelPolls, vote, endPoll, getVoters };
}

export type PollsService = ReturnType<typeof createPollsService>;

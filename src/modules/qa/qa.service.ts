import { eq, and, desc, lt, sql } from 'drizzle-orm';
import { qaQuestions, qaVotes, qaAnswerMeta, channels, threads, messages } from '@gratonite/db';
import type { AppContext } from '../../lib/context.js';
import { generateId } from '../../lib/snowflake.js';
import { createThreadsService } from '../threads/threads.service.js';
import type { CreateQuestionInput, VoteInput } from './qa.schemas.js';
import { GatewayIntents, emitRoomWithIntent } from '../../lib/gateway-intents.js';

export function createQaService(ctx: AppContext) {
  const threadsService = createThreadsService(ctx);

  async function createQuestion(
    channelId: string,
    guildId: string,
    authorId: string,
    input: CreateQuestionInput,
  ) {
    // Validate channel is GUILD_QA
    const [channel] = await ctx.db
      .select({ type: channels.type })
      .from(channels)
      .where(eq(channels.id, channelId));

    if (!channel || channel.type !== 'GUILD_QA') {
      return { error: 'INVALID_CHANNEL_TYPE' as const };
    }

    // Create thread via threads service (Q&A question = thread)
    const threadResult = await threadsService.createThread(channelId, guildId, authorId, {
      name: input.title,
      message: input.body,
      appliedTags: input.tags,
    });

    if ('error' in threadResult) {
      return threadResult;
    }

    // createThread returns the thread object directly
    const thread = threadResult;

    // Create qaQuestions metadata
    const [question] = await ctx.db
      .insert(qaQuestions)
      .values({
        threadId: thread.id,
        guildId,
        channelId,
        authorId,
      })
      .returning();

    await emitRoomWithIntent(
      ctx.io,
      `guild:${guildId}`,
      GatewayIntents.GUILD_MESSAGES,
      'QA_QUESTION_UPDATE',
      {
        guildId,
        threadId: question.threadId,
        question,
      },
    );

    return { thread, question };
  }

  async function getQuestion(threadId: string) {
    const [question] = await ctx.db
      .select()
      .from(qaQuestions)
      .where(eq(qaQuestions.threadId, threadId));
    return question ?? null;
  }

  async function getQuestions(
    channelId: string,
    options: { sort: string; resolved?: boolean; limit: number; before?: string },
  ) {
    const conditions = [eq(qaQuestions.channelId, channelId)];
    if (options.resolved !== undefined) {
      conditions.push(eq(qaQuestions.resolved, options.resolved));
    }
    if (options.before) {
      conditions.push(lt(qaQuestions.threadId, options.before));
    }

    let orderBy;
    switch (options.sort) {
      case 'votes':
        orderBy = desc(qaQuestions.voteCount);
        break;
      case 'newest':
        orderBy = desc(qaQuestions.createdAt);
        break;
      case 'activity':
      default:
        orderBy = desc(qaQuestions.threadId); // Snowflake-ordered = most recent activity
        break;
    }

    return ctx.db
      .select()
      .from(qaQuestions)
      .where(and(...conditions))
      .orderBy(orderBy)
      .limit(options.limit);
  }

  async function voteQuestion(threadId: string, userId: string, value: number) {
    // Check existing vote
    const [existing] = await ctx.db
      .select()
      .from(qaVotes)
      .where(
        and(
          eq(qaVotes.targetId, threadId),
          eq(qaVotes.targetType, 'question'),
          eq(qaVotes.userId, userId),
        ),
      );

    const question = await getQuestion(threadId);
    if (!question) return { error: 'NOT_FOUND' as const };

    if (existing) {
      if (existing.value === value) {
        // Same vote — no change
        return question;
      }
      // Change vote direction: delete old, insert new
      await ctx.db
        .delete(qaVotes)
        .where(
          and(
            eq(qaVotes.targetId, threadId),
            eq(qaVotes.targetType, 'question'),
            eq(qaVotes.userId, userId),
          ),
        );

      // Adjust count by 2 (remove old vote + add new)
      const delta = value - existing.value;
      await ctx.db
        .update(qaQuestions)
        .set({ voteCount: sql`${qaQuestions.voteCount} + ${delta}` })
        .where(eq(qaQuestions.threadId, threadId));
    } else {
      await ctx.db
        .update(qaQuestions)
        .set({ voteCount: sql`${qaQuestions.voteCount} + ${value}` })
        .where(eq(qaQuestions.threadId, threadId));
    }

    await ctx.db.insert(qaVotes).values({
      targetId: threadId,
      targetType: 'question',
      userId,
      value,
    });

    const [updated] = await ctx.db
      .select()
      .from(qaQuestions)
      .where(eq(qaQuestions.threadId, threadId));

    await emitRoomWithIntent(
      ctx.io,
      `guild:${question.guildId}`,
      GatewayIntents.GUILD_MESSAGES,
      'QA_VOTE_UPDATE',
      {
        guildId: question.guildId,
        targetId: threadId,
        targetType: 'question',
        voteCount: updated.voteCount,
      },
    );

    return updated;
  }

  async function removeQuestionVote(threadId: string, userId: string) {
    const [existing] = await ctx.db
      .select()
      .from(qaVotes)
      .where(
        and(
          eq(qaVotes.targetId, threadId),
          eq(qaVotes.targetType, 'question'),
          eq(qaVotes.userId, userId),
        ),
      );

    if (!existing) return { error: 'NO_VOTE' as const };

    await ctx.db
      .delete(qaVotes)
      .where(
        and(
          eq(qaVotes.targetId, threadId),
          eq(qaVotes.targetType, 'question'),
          eq(qaVotes.userId, userId),
        ),
      );

    await ctx.db
      .update(qaQuestions)
      .set({ voteCount: sql`${qaQuestions.voteCount} - ${existing.value}` })
      .where(eq(qaQuestions.threadId, threadId));

    const [updated] = await ctx.db
      .select()
      .from(qaQuestions)
      .where(eq(qaQuestions.threadId, threadId));

    return updated;
  }

  async function voteAnswer(
    messageId: string,
    threadId: string,
    userId: string,
    value: number,
  ) {
    // Ensure qaAnswerMeta exists (lazy creation)
    const [existingMeta] = await ctx.db
      .select()
      .from(qaAnswerMeta)
      .where(eq(qaAnswerMeta.messageId, messageId));

    if (!existingMeta) {
      await ctx.db.insert(qaAnswerMeta).values({
        messageId,
        threadId,
        voteCount: 0,
      });
    }

    // Check existing vote
    const [existing] = await ctx.db
      .select()
      .from(qaVotes)
      .where(
        and(
          eq(qaVotes.targetId, messageId),
          eq(qaVotes.targetType, 'answer'),
          eq(qaVotes.userId, userId),
        ),
      );

    if (existing) {
      if (existing.value === value) return existingMeta ?? { messageId, threadId, voteCount: 0, isAccepted: false };

      await ctx.db
        .delete(qaVotes)
        .where(
          and(
            eq(qaVotes.targetId, messageId),
            eq(qaVotes.targetType, 'answer'),
            eq(qaVotes.userId, userId),
          ),
        );

      const delta = value - existing.value;
      await ctx.db
        .update(qaAnswerMeta)
        .set({ voteCount: sql`${qaAnswerMeta.voteCount} + ${delta}` })
        .where(eq(qaAnswerMeta.messageId, messageId));
    } else {
      await ctx.db
        .update(qaAnswerMeta)
        .set({ voteCount: sql`${qaAnswerMeta.voteCount} + ${value}` })
        .where(eq(qaAnswerMeta.messageId, messageId));
    }

    await ctx.db.insert(qaVotes).values({
      targetId: messageId,
      targetType: 'answer',
      userId,
      value,
    });

    const [updated] = await ctx.db
      .select()
      .from(qaAnswerMeta)
      .where(eq(qaAnswerMeta.messageId, messageId));

    const question = await getQuestion(threadId);
    if (question) {
      await emitRoomWithIntent(
        ctx.io,
        `guild:${question.guildId}`,
        GatewayIntents.GUILD_MESSAGES,
        'QA_VOTE_UPDATE',
        {
          guildId: question.guildId,
          targetId: messageId,
          targetType: 'answer',
          voteCount: updated.voteCount,
        },
      );
    }

    return updated;
  }

  async function acceptAnswer(threadId: string, messageId: string, userId: string) {
    const question = await getQuestion(threadId);
    if (!question) return { error: 'NOT_FOUND' as const };

    // Only question author or guild owner can accept
    if (question.authorId !== userId) {
      // Check if guild owner
      const { guilds } = await import('@gratonite/db');
      const [guild] = await ctx.db
        .select({ ownerId: guilds.ownerId })
        .from(guilds)
        .where(eq(guilds.id, question.guildId));
      if (!guild || guild.ownerId !== userId) {
        return { error: 'FORBIDDEN' as const };
      }
    }

    // Unmark previous accepted answer if any
    if (question.acceptedAnswerId) {
      await ctx.db
        .update(qaAnswerMeta)
        .set({ isAccepted: false })
        .where(eq(qaAnswerMeta.messageId, question.acceptedAnswerId));
    }

    // Ensure qaAnswerMeta exists
    const [existingMeta] = await ctx.db
      .select()
      .from(qaAnswerMeta)
      .where(eq(qaAnswerMeta.messageId, messageId));

    if (!existingMeta) {
      await ctx.db.insert(qaAnswerMeta).values({
        messageId,
        threadId,
        isAccepted: true,
      });
    } else {
      await ctx.db
        .update(qaAnswerMeta)
        .set({ isAccepted: true })
        .where(eq(qaAnswerMeta.messageId, messageId));
    }

    // Update question
    const [updated] = await ctx.db
      .update(qaQuestions)
      .set({ acceptedAnswerId: messageId, resolved: true })
      .where(eq(qaQuestions.threadId, threadId))
      .returning();

    await emitRoomWithIntent(
      ctx.io,
      `guild:${question.guildId}`,
      GatewayIntents.GUILD_MESSAGES,
      'QA_ANSWER_ACCEPTED',
      {
        guildId: question.guildId,
        threadId,
        messageId,
      },
    );

    return updated;
  }

  async function unacceptAnswer(threadId: string, userId: string) {
    const question = await getQuestion(threadId);
    if (!question) return { error: 'NOT_FOUND' as const };

    if (question.authorId !== userId) {
      const { guilds } = await import('@gratonite/db');
      const [guild] = await ctx.db
        .select({ ownerId: guilds.ownerId })
        .from(guilds)
        .where(eq(guilds.id, question.guildId));
      if (!guild || guild.ownerId !== userId) {
        return { error: 'FORBIDDEN' as const };
      }
    }

    if (question.acceptedAnswerId) {
      await ctx.db
        .update(qaAnswerMeta)
        .set({ isAccepted: false })
        .where(eq(qaAnswerMeta.messageId, question.acceptedAnswerId));
    }

    const [updated] = await ctx.db
      .update(qaQuestions)
      .set({ acceptedAnswerId: null, resolved: false })
      .where(eq(qaQuestions.threadId, threadId))
      .returning();

    return updated;
  }

  return {
    createQuestion,
    getQuestion,
    getQuestions,
    voteQuestion,
    removeQuestionVote,
    voteAnswer,
    acceptAnswer,
    unacceptAnswer,
  };
}

export type QaService = ReturnType<typeof createQaService>;

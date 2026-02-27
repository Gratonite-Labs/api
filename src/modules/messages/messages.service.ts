import { eq, and, sql, lt, gt, desc, inArray, isNull, lte } from 'drizzle-orm';
import {
  messages,
  messageAttachments,
  messageReactions,
  messageReactionUsers,
  messageEditHistory,
  channelPins,
  channels,
  polls,
  pollAnswers,
  pollVotes,
  threads,
  scheduledMessages,
  users,
  userProfiles,
  userRoles,
  guildRoles,
} from '@gratonite/db';
import type { AppContext } from '../../lib/context.js';
import { generateId } from '../../lib/snowflake.js';
import type {
  CreateMessageInput,
  UpdateMessageInput,
  CreateScheduledMessageInput,
} from './messages.schemas.js';
import { createFilesService } from '../files/files.service.js';
import { createGratonitesService } from '../gratonites/gratonites.service.js';
import { GatewayIntents, emitRoomWithIntent } from '../../lib/gateway-intents.js';

const MESSAGE_TYPE_POLL = 22;

export function createMessagesService(ctx: AppContext) {
  const filesService = createFilesService(ctx);
  type DbLike = typeof ctx.db;

  async function createMessage(
    channelId: string,
    authorId: string,
    guildId: string | null,
    input: CreateMessageInput,
  ) {
    const messageId = generateId();
    const content = input.content ?? '';
    const uploadedIds: string[] = [];

    let pendingUploads: Array<Awaited<ReturnType<typeof filesService.getPendingUpload>> | null> = [];
    if (input.attachmentIds && input.attachmentIds.length > 0) {
      pendingUploads = await Promise.all(
        input.attachmentIds.map((id) => filesService.getPendingUpload(id)),
      );

      if (pendingUploads.some((u) => !u)) {
        return { error: 'ATTACHMENT_NOT_FOUND' as const };
      }
    }

    // Parse mentions from content
    const mentionMatches = content.match(/<@!?(\d+)>/g) ?? [];
    let mentionIds = mentionMatches.map((m) => m.replace(/<@!?/, '').replace(/>/, ''));
    const mentionEveryone = content.includes('@everyone') || content.includes('@here');
    const roleMentionMatches = content.match(/<@&(\d+)>/g) ?? [];
    const roleMentionIds = roleMentionMatches.map((m) => m.replace(/<@&/, '').replace(/>/, ''));
    if (guildId && roleMentionIds.length > 0) {
      const validRoles = await ctx.db
        .select({ id: guildRoles.id })
        .from(guildRoles)
        .where(
          and(
            eq(guildRoles.guildId, guildId),
            inArray(guildRoles.id, roleMentionIds),
            eq(guildRoles.mentionable, true),
          ),
        );
      const validRoleIds = validRoles.map((row) => String(row.id));
      if (validRoleIds.length > 0) {
        const roleMembers = await ctx.db
          .select({ userId: userRoles.userId })
          .from(userRoles)
          .where(
            and(
              eq(userRoles.guildId, guildId),
              inArray(userRoles.roleId, validRoleIds),
            ),
          );
        const merged = new Set(mentionIds);
        for (const row of roleMembers) {
          const id = String(row.userId);
          if (id !== authorId) merged.add(id);
        }
        mentionIds = Array.from(merged);
      }
    }

    // Build message reference snapshot if replying
    let referencedMessage = null;
    if (input.messageReference) {
      const [ref] = await ctx.db
        .select({ 
          id: messages.id, 
          content: messages.content, 
          authorId: messages.authorId,
        })
        .from(messages)
        .where(eq(messages.id, input.messageReference.messageId))
        .limit(1);

      if (ref) {
        referencedMessage = {
          id: ref.id,
          content: ref.content.substring(0, 200),
          authorId: ref.authorId,
        };
      }
    }

    // Check if any upload is a voice message
    const hasVoiceMessage = pendingUploads.some((u) => u?.isVoiceMessage);
    const messageFlags = hasVoiceMessage ? (1 << 13) : 0; // IS_VOICE_MESSAGE

    const message = await ctx.db.transaction(async (tx) => {
      let pollId: string | null = null;
      if (input.poll) {
        pollId = await createPollWithDb(tx, input.poll);
      }

      const [created] = await tx
        .insert(messages)
        .values({
          id: messageId,
          channelId,
          guildId,
          authorId,
          content,
          type: input.poll ? MESSAGE_TYPE_POLL : input.messageReference ? 19 : 0, // 19 = REPLY, 0 = DEFAULT
          flags: messageFlags,
          nonce: input.nonce ?? null,
          tts: input.tts ?? false,
          mentions: mentionIds,
          mentionRoles: roleMentionIds,
          mentionEveryone,
          stickerIds: input.stickerIds ?? [],
          pollId,
          messageReference: input.messageReference
            ? { messageId: input.messageReference.messageId, channelId: String(channelId) }
            : null,
          referencedMessage,
        })
        .returning();

      // Update channel's last message ID
      await tx.update(channels).set({ lastMessageId: messageId }).where(eq(channels.id, channelId));

      // If this is a thread, increment message count
      const [thread] = await tx
        .select({ id: threads.id })
        .from(threads)
        .where(eq(threads.id, channelId))
        .limit(1);
      if (thread) {
        await tx
          .update(threads)
          .set({ messageCount: sql`${threads.messageCount} + 1` })
          .where(eq(threads.id, channelId));
      }

      // Attach pending uploads
      if (pendingUploads.length > 0) {
        for (const upload of pendingUploads) {
          if (!upload) continue;
          // Compute flags: bit 0 = spoiler, bit 1 = voice message
          let flags = 0;
          if (upload.spoiler) flags |= 1;
          if (upload.isVoiceMessage) flags |= 2;

          await tx.insert(messageAttachments).values({
            id: upload.id,
            messageId,
            filename: upload.filename,
            description: upload.description ?? null,
            contentType: upload.contentType,
            size: upload.size,
            url: upload.url,
            proxyUrl: upload.url,
            height: upload.height,
            width: upload.width,
            durationSecs: upload.durationSecs ?? null,
            waveform: upload.waveform ?? null,
            flags,
          });
          uploadedIds.push(upload.id);
        }
      }

      return created;
    });

    // Increment user's message count and check for milestones (non-blocking)
    if (!authorId.startsWith('bot_')) { // Skip bots
      const gratonitesService = createGratonitesService(ctx);
      
      // Update message count
      const [updatedProfile] = await ctx.db
        .update(userProfiles)
        .set({ messageCount: sql`${userProfiles.messageCount} + 1` })
        .where(eq(userProfiles.userId, authorId))
        .returning({ messageCount: userProfiles.messageCount });

      // Check for milestones
      if (updatedProfile) {
        gratonitesService.checkMessageMilestone(authorId, updatedProfile.messageCount)
          .catch(() => {}); // Best effort, don't block
      }
    }

    if (uploadedIds.length > 0) {
      await Promise.all(uploadedIds.map((id) => filesService.clearPendingUpload(id)));
    }

    return hydrateMessage(message);
  }

  async function getMessage(messageId: string) {
    const [message] = await ctx.db
      .select()
      .from(messages)
      .where(and(eq(messages.id, messageId), sql`${messages.deletedAt} IS NULL`))
      .limit(1);
    if (!message) return null;
    return hydrateMessage(message);
  }

  async function getMessages(
    channelId: string,
    options: { limit: number; before?: string; after?: string; around?: string },
  ) {
    const { limit } = options;

    if (options.around) {
      const aroundId = options.around;
      const halfLimit = Math.floor(limit / 2);

      const beforeMessages = await ctx.db
        .select()
        .from(messages)
        .where(
          and(
            eq(messages.channelId, channelId),
            lt(messages.id, aroundId),
            sql`${messages.deletedAt} IS NULL`,
          ),
        )
        .orderBy(desc(messages.id))
        .limit(halfLimit);

      const afterMessages = await ctx.db
        .select()
        .from(messages)
        .where(
          and(
            eq(messages.channelId, channelId),
            gt(messages.id, aroundId),
            sql`${messages.deletedAt} IS NULL`,
          ),
        )
        .orderBy(messages.id)
        .limit(halfLimit);

      const [center] = await ctx.db
        .select()
        .from(messages)
        .where(and(eq(messages.id, aroundId), sql`${messages.deletedAt} IS NULL`))
        .limit(1);

      const result = [...beforeMessages.reverse(), ...(center ? [center] : []), ...afterMessages];
      return hydrateMessages(result);
    }

    if (options.before) {
      const result = await ctx.db
        .select()
        .from(messages)
        .where(
          and(
            eq(messages.channelId, channelId),
            lt(messages.id, options.before),
            sql`${messages.deletedAt} IS NULL`,
          ),
        )
        .orderBy(desc(messages.id))
        .limit(limit);
      return hydrateMessages(result);
    }

    if (options.after) {
      const results = await ctx.db
        .select()
        .from(messages)
        .where(
          and(
            eq(messages.channelId, channelId),
            gt(messages.id, options.after),
            sql`${messages.deletedAt} IS NULL`,
          ),
        )
        .orderBy(messages.id)
        .limit(limit);
      return hydrateMessages(results);
    }

    // Default: most recent messages
    const results = await ctx.db
      .select()
      .from(messages)
      .where(
        and(eq(messages.channelId, channelId), sql`${messages.deletedAt} IS NULL`),
      )
      .orderBy(desc(messages.id))
      .limit(limit);
    return hydrateMessages(results);
  }

  async function updateMessage(messageId: string, authorId: string, input: UpdateMessageInput) {
    const [existing] = await ctx.db
      .select()
      .from(messages)
      .where(and(eq(messages.id, messageId), sql`${messages.deletedAt} IS NULL`))
      .limit(1);

    if (!existing) return null;
    if (existing.authorId !== authorId) return { error: 'FORBIDDEN' as const };

    // Save edit history
    await ctx.db.insert(messageEditHistory).values({
      id: generateId(),
      messageId,
      content: existing.content,
    });

    const [updated] = await ctx.db
      .update(messages)
      .set({
        content: input.content,
        editedTimestamp: new Date(),
      })
      .where(eq(messages.id, messageId))
      .returning();

    return updated;
  }

  async function deleteMessage(messageId: string, userId: string, isAdmin = false) {
    const [existing] = await ctx.db
      .select()
      .from(messages)
      .where(and(eq(messages.id, messageId), sql`${messages.deletedAt} IS NULL`))
      .limit(1);

    if (!existing) return null;
    if (existing.authorId !== userId && !isAdmin) return { error: 'FORBIDDEN' as const };

    // Soft delete
    await ctx.db
      .update(messages)
      .set({ deletedAt: new Date() })
      .where(eq(messages.id, messageId));

    return existing;
  }

  // ── Reactions ────────────────────────────────────────────────────────────

  async function addReaction(messageId: string, userId: string, emojiName: string, emojiId?: string) {
    // Check if user already reacted with this emoji
    const [existing] = await ctx.db
      .select()
      .from(messageReactionUsers)
      .where(
        and(
          eq(messageReactionUsers.messageId, messageId),
          eq(messageReactionUsers.userId, userId),
          eq(messageReactionUsers.emojiName, emojiName),
        ),
      )
      .limit(1);

    if (existing) return false; // Already reacted

    // Add user reaction
    await ctx.db.insert(messageReactionUsers).values({
      messageId,
      userId,
      emojiName,
      emojiId: emojiId ?? null,
    });

    // Upsert aggregate count
    const [existingReaction] = await ctx.db
      .select()
      .from(messageReactions)
      .where(
        and(
          eq(messageReactions.messageId, messageId),
          eq(messageReactions.emojiName, emojiName),
        ),
      )
      .limit(1);

    if (existingReaction) {
      await ctx.db
        .update(messageReactions)
        .set({ count: sql`${messageReactions.count} + 1` })
        .where(
          and(
            eq(messageReactions.messageId, messageId),
            eq(messageReactions.emojiName, emojiName),
          ),
        );
    } else {
      await ctx.db.insert(messageReactions).values({
        messageId,
        emojiName,
        emojiId: emojiId ?? null,
        count: 1,
      });
    }

    return true;
  }

  async function removeReaction(messageId: string, userId: string, emojiName: string) {
    const [existing] = await ctx.db
      .select()
      .from(messageReactionUsers)
      .where(
        and(
          eq(messageReactionUsers.messageId, messageId),
          eq(messageReactionUsers.userId, userId),
          eq(messageReactionUsers.emojiName, emojiName),
        ),
      )
      .limit(1);
    if (!existing) return false;

    await ctx.db
      .delete(messageReactionUsers)
      .where(
        and(
          eq(messageReactionUsers.messageId, messageId),
          eq(messageReactionUsers.userId, userId),
          eq(messageReactionUsers.emojiName, emojiName),
        ),
      );

    // Decrement aggregate count
    await ctx.db
      .update(messageReactions)
      .set({ count: sql`GREATEST(${messageReactions.count} - 1, 0)` })
      .where(
        and(
          eq(messageReactions.messageId, messageId),
          eq(messageReactions.emojiName, emojiName),
        ),
      );

    // Clean up zero-count reactions
    await ctx.db
      .delete(messageReactions)
      .where(
        and(
          eq(messageReactions.messageId, messageId),
          eq(messageReactions.emojiName, emojiName),
          eq(messageReactions.count, 0),
        ),
      );
    return true;
  }

  async function getReactions(messageId: string) {
    return ctx.db
      .select()
      .from(messageReactions)
      .where(eq(messageReactions.messageId, messageId));
  }

  // ── Pins ─────────────────────────────────────────────────────────────────

  async function pinMessage(channelId: string, messageId: string, userId: string) {
    // Check pin limit (50 per channel)
    const [count] = await ctx.db
      .select({ count: sql<number>`count(*)::int` })
      .from(channelPins)
      .where(eq(channelPins.channelId, channelId));

    if ((count?.count ?? 0) >= 50) {
      return { error: 'PIN_LIMIT_REACHED' as const };
    }

    await ctx.db.insert(channelPins).values({ channelId, messageId, pinnedBy: userId });

    await ctx.db
      .update(messages)
      .set({ pinned: true })
      .where(eq(messages.id, messageId));

    return true;
  }

  async function unpinMessage(channelId: string, messageId: string) {
    await ctx.db
      .delete(channelPins)
      .where(and(eq(channelPins.channelId, channelId), eq(channelPins.messageId, messageId)));

    await ctx.db
      .update(messages)
      .set({ pinned: false })
      .where(eq(messages.id, messageId));
  }

  async function getPins(channelId: string) {
    const pins = await ctx.db
      .select({ messageId: channelPins.messageId })
      .from(channelPins)
      .where(eq(channelPins.channelId, channelId))
      .orderBy(desc(channelPins.pinnedAt));

    if (pins.length === 0) return [];

    const messageIds = pins.map((p) => p.messageId);
    const results = await ctx.db
      .select()
      .from(messages)
      .where(and(inArray(messages.id, messageIds), isNull(messages.deletedAt)));
    return hydrateMessages(results);
  }

  // ── Polls ───────────────────────────────────────────────────────────────

  async function createPollWithDb(db: DbLike, input: NonNullable<CreateMessageInput['poll']>) {
    const pollId = generateId();
    await db.insert(polls).values({
      id: pollId,
      questionText: input.questionText,
      allowMultiselect: input.allowMultiselect ?? false,
      expiry: input.expiry ? new Date(input.expiry) : null,
    });

    for (const answer of input.answers) {
      await db.insert(pollAnswers).values({
        id: generateId(),
        pollId,
        text: answer.text,
        emojiId: answer.emojiId ?? null,
        emojiName: answer.emojiName ?? null,
      });
    }

    return pollId;
  }

  async function getPoll(pollId: string) {
    const [poll] = await ctx.db.select().from(polls).where(eq(polls.id, pollId)).limit(1);
    if (!poll) return null;
    const answers = await ctx.db
      .select()
      .from(pollAnswers)
      .where(eq(pollAnswers.pollId, pollId));
    return { ...poll, answers };
  }

  async function addPollVote(pollId: string, answerId: string, userId: string) {
    const [poll] = await ctx.db.select().from(polls).where(eq(polls.id, pollId)).limit(1);
    if (!poll) return { error: 'POLL_NOT_FOUND' as const };
    if (poll.finalized) return { error: 'POLL_FINALIZED' as const };
    if (poll.expiry && poll.expiry.getTime() < Date.now()) return { error: 'POLL_EXPIRED' as const };

    const [answer] = await ctx.db
      .select()
      .from(pollAnswers)
      .where(and(eq(pollAnswers.id, answerId), eq(pollAnswers.pollId, pollId)))
      .limit(1);
    if (!answer) return { error: 'ANSWER_NOT_FOUND' as const };

    const existing = await ctx.db
      .select()
      .from(pollVotes)
      .where(and(eq(pollVotes.pollId, pollId), eq(pollVotes.userId, userId)));

    if (!poll.allowMultiselect && existing.length > 0) {
      return { error: 'ALREADY_VOTED' as const };
    }

    const alreadyVotedThis = existing.some((v) => v.answerId === answerId);
    if (alreadyVotedThis) return { error: 'ALREADY_VOTED' as const };

    await ctx.db.insert(pollVotes).values({ pollId, answerId, userId });
    await ctx.db
      .update(pollAnswers)
      .set({ voteCount: sql`${pollAnswers.voteCount} + 1` })
      .where(eq(pollAnswers.id, answerId));

    return { pollId, answerId };
  }

  async function removePollVote(pollId: string, answerId: string, userId: string) {
    await ctx.db
      .delete(pollVotes)
      .where(and(eq(pollVotes.pollId, pollId), eq(pollVotes.answerId, answerId), eq(pollVotes.userId, userId)));
    await ctx.db
      .update(pollAnswers)
      .set({ voteCount: sql`GREATEST(${pollAnswers.voteCount} - 1, 0)` })
      .where(eq(pollAnswers.id, answerId));
  }

  async function getPollVotes(pollId: string) {
    return ctx.db.select().from(pollVotes).where(eq(pollVotes.pollId, pollId));
  }

  async function finalizePoll(pollId: string) {
    const [updated] = await ctx.db
      .update(polls)
      .set({ finalized: true })
      .where(eq(polls.id, pollId))
      .returning();
    return updated ?? null;
  }

  // ── Scheduled messages ─────────────────────────────────────────────────-

  async function createScheduledMessage(
    channelId: string,
    authorId: string,
    input: CreateScheduledMessageInput,
  ) {
    const scheduledFor = new Date(input.scheduledFor);
    if (Number.isNaN(scheduledFor.getTime())) {
      return { error: 'INVALID_SCHEDULE_TIME' as const };
    }
    if (scheduledFor.getTime() <= Date.now()) {
      return { error: 'SCHEDULE_IN_PAST' as const };
    }

    const attachments = await buildScheduledAttachments(input.attachmentIds ?? []);
    if (attachments && 'error' in attachments) return attachments;

    const [scheduled] = await ctx.db
      .insert(scheduledMessages)
      .values({
        id: generateId(),
        channelId,
        authorId,
        content: input.content ?? '',
        embeds: input.embeds ?? [],
        attachments: attachments ?? [],
        scheduledFor,
        status: 'pending',
      })
      .returning();

    if (attachments && Array.isArray(attachments)) {
      await Promise.all(attachments.map((attachment) => filesService.clearPendingUpload(attachment.id)));
    }

    return scheduled;
  }

  async function getScheduledMessages(channelId: string, authorId: string, isAdmin: boolean) {
    const query = ctx.db
      .select()
      .from(scheduledMessages)
      .where(eq(scheduledMessages.channelId, channelId));

    if (isAdmin) {
      return query.orderBy(sql`${scheduledMessages.scheduledFor} ASC`);
    }

    return ctx.db
      .select()
      .from(scheduledMessages)
      .where(and(eq(scheduledMessages.channelId, channelId), eq(scheduledMessages.authorId, authorId)))
      .orderBy(sql`${scheduledMessages.scheduledFor} ASC`);
  }

  async function cancelScheduledMessage(messageId: string, authorId: string, isAdmin: boolean) {
    if (isAdmin) {
      const [updated] = await ctx.db
        .update(scheduledMessages)
        .set({ status: 'cancelled' })
        .where(eq(scheduledMessages.id, messageId))
        .returning();
      return updated ?? null;
    }

    const [updated] = await ctx.db
      .update(scheduledMessages)
      .set({ status: 'cancelled' })
      .where(and(eq(scheduledMessages.id, messageId), eq(scheduledMessages.authorId, authorId)))
      .returning();
    return updated ?? null;
  }

  async function processScheduledMessages() {
    const due = await ctx.db
      .select({ id: scheduledMessages.id })
      .from(scheduledMessages)
      .where(and(eq(scheduledMessages.status, 'pending'), lte(scheduledMessages.scheduledFor, new Date())))
      .limit(50);

    for (const item of due) {
      const [claimed] = await ctx.db
        .update(scheduledMessages)
        .set({ status: 'sending' })
        .where(and(eq(scheduledMessages.id, item.id), eq(scheduledMessages.status, 'pending')))
        .returning();
      if (!claimed) continue;

      try {
        const result = await sendScheduledMessage(claimed);
        await ctx.db
          .update(scheduledMessages)
          .set({ status: 'sent' })
          .where(eq(scheduledMessages.id, claimed.id));

        if (result?.guildId) {
          await emitRoomWithIntent(
            ctx.io,
            `guild:${result.guildId}`,
            GatewayIntents.GUILD_MESSAGES,
            'MESSAGE_CREATE',
            result.message as any,
          );
        } else {
          await emitRoomWithIntent(
            ctx.io,
            `channel:${claimed.channelId}`,
            GatewayIntents.DIRECT_MESSAGES,
            'MESSAGE_CREATE',
            result?.message as any,
          );
        }

        await ctx.redis.publish(
          `channel:${claimed.channelId}:messages`,
          JSON.stringify({ type: 'MESSAGE_CREATE', data: result?.message }),
        );
      } catch (err) {
        await ctx.db
          .update(scheduledMessages)
          .set({ status: 'failed' })
          .where(eq(scheduledMessages.id, claimed.id));
      }
    }
  }

  async function buildScheduledAttachments(attachmentIds: string[]) {
    if (attachmentIds.length === 0) return [];
    const pending = await Promise.all(attachmentIds.map((id) => filesService.getPendingUpload(id)));
    if (pending.some((item) => !item)) {
      return { error: 'ATTACHMENT_NOT_FOUND' as const };
    }

    return pending.filter(Boolean).map((upload) => ({
      id: upload!.id,
      filename: upload!.filename,
      description: upload!.description ?? null,
      contentType: upload!.contentType,
      size: upload!.size,
      url: upload!.url,
      proxyUrl: upload!.url,
      height: upload!.height,
      width: upload!.width,
      flags: upload!.spoiler ? 1 : 0,
    }));
  }

  async function sendScheduledMessage(entry: typeof scheduledMessages.$inferSelect) {
    return ctx.db.transaction(async (tx) => {
      const channel = await getChannelContext(tx, entry.channelId);
      const messageId = generateId();
      const [created] = await tx
        .insert(messages)
        .values({
          id: messageId,
          channelId: entry.channelId,
          guildId: channel?.guildId ?? null,
          authorId: entry.authorId,
          content: entry.content ?? '',
          type: 0,
          embeds: entry.embeds ?? [],
          mentions: [],
          mentionRoles: [],
          mentionEveryone: false,
          stickerIds: [],
        })
        .returning();

      await tx
        .update(channels)
        .set({ lastMessageId: messageId })
        .where(eq(channels.id, entry.channelId));

      const [thread] = await tx
        .select({ id: threads.id })
        .from(threads)
        .where(eq(threads.id, entry.channelId))
        .limit(1);
      if (thread) {
        await tx
          .update(threads)
          .set({ messageCount: sql`${threads.messageCount} + 1` })
          .where(eq(threads.id, entry.channelId));
      }

      const attachments = Array.isArray(entry.attachments) ? entry.attachments : [];
      for (const attachment of attachments) {
        const attachmentId = attachment.id ?? generateId();
        await tx.insert(messageAttachments).values({
          id: attachmentId,
          messageId,
          filename: attachment.filename,
          description: attachment.description ?? null,
          contentType: attachment.contentType,
          size: attachment.size,
          url: attachment.url,
          proxyUrl: attachment.proxyUrl ?? attachment.url,
          height: attachment.height ?? null,
          width: attachment.width ?? null,
          durationSecs: attachment.durationSecs ?? null,
          waveform: attachment.waveform ?? null,
          flags: attachment.flags ?? 0,
        });
      }

      return { message: await hydrateMessage(created), guildId: channel?.guildId ?? null };
    });
  }

  async function getChannelContext(db: DbLike, channelId: string) {
    const [channel] = await db
      .select({ guildId: channels.guildId })
      .from(channels)
      .where(eq(channels.id, channelId))
      .limit(1);
    if (channel) return channel;

    const [thread] = await db
      .select({ guildId: threads.guildId })
      .from(threads)
      .where(eq(threads.id, channelId))
      .limit(1);
    return thread ?? null;
  }

  // ── Hydration helpers ───────────────────────────────────────────────────

  async function hydrateMessage(message: typeof messages.$inferSelect) {
    const attachments = await ctx.db
      .select()
      .from(messageAttachments)
      .where(eq(messageAttachments.messageId, message.id));

    const reactionsList = await ctx.db
      .select({
        messageId: messageReactions.messageId,
        emoji: messageReactions.emojiName,
        count: messageReactions.count,
      })
      .from(messageReactions)
      .where(eq(messageReactions.messageId, message.id));

    const reactionUsers = await ctx.db
      .select({
        messageId: messageReactionUsers.messageId,
        emoji: messageReactionUsers.emojiName,
        userId: messageReactionUsers.userId,
      })
      .from(messageReactionUsers)
      .where(eq(messageReactionUsers.messageId, message.id));

    const reactionsByEmoji = new Map<string, { emoji: string; count: number; userIds: string[] }>();
    for (const r of reactionsList) {
      reactionsByEmoji.set(r.emoji, { emoji: r.emoji, count: r.count, userIds: [] });
    }
    for (const ru of reactionUsers) {
      const existing = reactionsByEmoji.get(ru.emoji)
        ?? { emoji: ru.emoji, count: 0, userIds: [] };
      existing.userIds.push(ru.userId.toString());
      reactionsByEmoji.set(ru.emoji, existing);
    }

    const poll = message.pollId ? await getPoll(message.pollId) : null;

    // Fetch author info
    const [authorRow] = await ctx.db
      .select({
        id: users.id,
        username: users.username,
        displayName: userProfiles.displayName,
        avatarHash: userProfiles.avatarHash,
      })
      .from(users)
      .innerJoin(userProfiles, eq(users.id, userProfiles.userId))
      .where(eq(users.id, message.authorId))
      .limit(1);

    return {
      ...message,
      attachments,
      reactions: Array.from(reactionsByEmoji.values()),
      poll,
      author: authorRow ?? { id: message.authorId, username: 'Deleted User', displayName: 'Deleted User', avatarHash: null },
    };
  }

  async function hydrateMessages(list: Array<typeof messages.$inferSelect>) {
    if (list.length === 0) return [];

    const messageIds = list.map((m) => m.id);
    const pollIds = list.map((m) => m.pollId).filter((id): id is string => Boolean(id));

    // Fetch attachments
    const attachments = await ctx.db
      .select()
      .from(messageAttachments)
      .where(inArray(messageAttachments.messageId, messageIds));

    const attachmentsByMessage = new Map<string, typeof attachments>();
    for (const attachment of attachments) {
      const existing = attachmentsByMessage.get(attachment.messageId) ?? [];
      existing.push(attachment);
      attachmentsByMessage.set(attachment.messageId, existing);
    }

    // Fetch authors
    const authorIds = [...new Set(list.map((m) => m.authorId))];
    const authorRows = authorIds.length > 0
      ? await ctx.db
          .select({
            id: users.id,
            username: users.username,
            displayName: userProfiles.displayName,
            avatarHash: userProfiles.avatarHash,
            primaryColor: userProfiles.primaryColor,
            accentColor: userProfiles.accentColor,
          })
          .from(users)
          .innerJoin(userProfiles, eq(users.id, userProfiles.userId))
          .where(inArray(users.id, authorIds))
      : [];
    const authorsById = new Map(authorRows.map((a) => [a.id, a]));
    const deletedAuthor = { id: '0', username: 'Deleted User', displayName: 'Deleted User', avatarHash: null, primaryColor: null, accentColor: null };

    // Fetch polls
    let pollsById = new Map<string, any>();
    if (pollIds.length > 0) {
      const pollsList = await ctx.db.select().from(polls).where(inArray(polls.id, pollIds));
      const answers = await ctx.db
        .select()
        .from(pollAnswers)
        .where(inArray(pollAnswers.pollId, pollIds));
      const answersByPoll = new Map<string, typeof answers>();
      for (const answer of answers) {
        const existing = answersByPoll.get(answer.pollId) ?? [];
        existing.push(answer);
        answersByPoll.set(answer.pollId, existing);
      }
      pollsById = new Map(
        pollsList.map((poll) => [poll.id, { ...poll, answers: answersByPoll.get(poll.id) ?? [] }]),
      );
    }

    // Fetch reactions
    const reactions = await ctx.db
      .select({
        messageId: messageReactions.messageId,
        emoji: messageReactions.emojiName,
        count: messageReactions.count,
      })
      .from(messageReactions)
      .where(inArray(messageReactions.messageId, messageIds));

    const reactionUsers = await ctx.db
      .select({
        messageId: messageReactionUsers.messageId,
        emoji: messageReactionUsers.emojiName,
        userId: messageReactionUsers.userId,
      })
      .from(messageReactionUsers)
      .where(inArray(messageReactionUsers.messageId, messageIds));

    const reactionsByMessage = new Map<string, Map<string, { emoji: string; count: number; userIds: string[] }>>();
    for (const r of reactions) {
      const byEmoji = reactionsByMessage.get(r.messageId) ?? new Map();
      byEmoji.set(r.emoji, { emoji: r.emoji, count: r.count, userIds: [] });
      reactionsByMessage.set(r.messageId, byEmoji);
    }
    for (const ru of reactionUsers) {
      const byEmoji = reactionsByMessage.get(ru.messageId) ?? new Map();
      const existing = byEmoji.get(ru.emoji) ?? { emoji: ru.emoji, count: 0, userIds: [] };
      existing.userIds.push(ru.userId.toString());
      byEmoji.set(ru.emoji, existing);
      reactionsByMessage.set(ru.messageId, byEmoji);
    }

    return list.map((message) => ({
      ...message,
      attachments: attachmentsByMessage.get(message.id) ?? [],
      reactions: Array.from(reactionsByMessage.get(message.id)?.values() ?? []),
      poll: message.pollId ? pollsById.get(message.pollId) ?? null : null,
      author: authorsById.get(message.authorId) ?? { ...deletedAuthor, id: message.authorId },
    }));
  }

  return {
    createMessage,
    getMessage,
    getMessages,
    updateMessage,
    deleteMessage,
    addReaction,
    removeReaction,
    getReactions,
    pinMessage,
    unpinMessage,
    getPins,
    getPoll,
    addPollVote,
    removePollVote,
    getPollVotes,
    finalizePoll,
    createScheduledMessage,
    getScheduledMessages,
    cancelScheduledMessage,
    processScheduledMessages,
  };
}

export type MessagesService = ReturnType<typeof createMessagesService>;

import ogs from 'open-graph-scraper';
import { eq } from 'drizzle-orm';
import { messages } from '@gratonite/db';
import type { AppContext } from '../../lib/context.js';
import { logger } from '../../lib/logger.js';
import { GatewayIntents, emitRoomWithIntent } from '../../lib/gateway-intents.js';

const URL_REGEX = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/gi;
const CACHE_TTL = 60 * 60 * 24; // 24 hours
const FETCH_TIMEOUT_MS = 8000;
const MAX_URLS_PER_MESSAGE = 5;

export interface LinkEmbed {
  type: 'link' | 'article' | 'video' | 'image';
  title: string | null;
  description: string | null;
  url: string;
  color: number | null;
  timestamp: string | null;
  footer: { text: string } | null;
  image: { url: string; width?: number; height?: number } | null;
  thumbnail: { url: string; width?: number; height?: number } | null;
  video: { url: string; width?: number; height?: number } | null;
  author: { name: string; url?: string } | null;
  fields: never[];
}

export function createLinkPreviewService(ctx: AppContext) {
  /**
   * Extract URLs from message content.
   */
  function extractUrls(content: string): string[] {
    const matches = content.match(URL_REGEX);
    if (!matches) return [];
    // Deduplicate and limit
    return [...new Set(matches)].slice(0, MAX_URLS_PER_MESSAGE);
  }

  /**
   * Fetch OpenGraph metadata for a single URL with Redis caching.
   */
  async function fetchPreview(url: string): Promise<LinkEmbed | null> {
    // Check Redis cache first
    const cacheKey = `link_preview:${url}`;
    const cached = await ctx.redis.get(cacheKey);
    if (cached) {
      if (cached === 'null') return null; // Negative cache
      return JSON.parse(cached) as LinkEmbed;
    }

    try {
      const { result } = await ogs({
        url,
        timeout: FETCH_TIMEOUT_MS,
        fetchOptions: {
          headers: {
            'User-Agent': 'Gratonite/1.0 (Link Preview Bot)',
          },
        },
      });

      if (!result.ogTitle && !result.ogDescription && !result.ogImage) {
        // Nothing useful — cache negative result
        await ctx.redis.set(cacheKey, 'null', 'EX', CACHE_TTL);
        return null;
      }

      // Determine embed type
      let type: LinkEmbed['type'] = 'link';
      if (result.ogType === 'article' || result.ogType === 'blog') type = 'article';
      else if (result.ogType === 'video' || result.ogType?.startsWith('video')) type = 'video';
      else if (result.ogType === 'image' || result.ogType?.startsWith('image')) type = 'image';

      const ogImage = Array.isArray(result.ogImage) ? result.ogImage[0] : undefined;
      const ogVideo = Array.isArray(result.ogVideo) ? result.ogVideo[0] : undefined;

      const embed: LinkEmbed = {
        type,
        title: result.ogTitle ?? null,
        description: result.ogDescription?.substring(0, 4096) ?? null,
        url: result.ogUrl ?? url,
        color: null,
        timestamp: null,
        footer: result.ogSiteName ? { text: result.ogSiteName } : null,
        image: ogImage?.url
          ? {
              url: ogImage.url,
              width: ogImage.width ? Number(ogImage.width) : undefined,
              height: ogImage.height ? Number(ogImage.height) : undefined,
            }
          : null,
        thumbnail: null,
        video: ogVideo?.url
          ? {
              url: ogVideo.url,
              width: ogVideo.width ? Number(ogVideo.width) : undefined,
              height: ogVideo.height ? Number(ogVideo.height) : undefined,
            }
          : null,
        author: result.author ? { name: result.author } : null,
        fields: [],
      };

      // Cache the result
      await ctx.redis.set(cacheKey, JSON.stringify(embed), 'EX', CACHE_TTL);

      return embed;
    } catch (err) {
      logger.debug({ err, url }, 'Failed to fetch link preview');
      // Cache negative result to avoid repeated failed fetches
      await ctx.redis.set(cacheKey, 'null', 'EX', 60 * 5); // 5 min for errors
      return null;
    }
  }

  /**
   * Process a message for link previews. Runs asynchronously after message creation.
   * Fetches OG data for each URL and updates the message's embeds column.
   */
  async function processMessageLinks(messageId: string, content: string): Promise<void> {
    const urls = extractUrls(content);
    if (urls.length === 0) return;

    const embeds: LinkEmbed[] = [];

    // Fetch all previews in parallel
    const results = await Promise.allSettled(urls.map((url) => fetchPreview(url)));

    for (const result of results) {
      if (result.status === 'fulfilled' && result.value) {
        embeds.push(result.value);
      }
    }

    if (embeds.length === 0) return;

    // Update the message's embeds column
    await ctx.db
      .update(messages)
      .set({ embeds })
      .where(eq(messages.id, messageId));

    // Emit MESSAGE_UPDATE so clients get the embeds
    const [updated] = await ctx.db
      .select({ channelId: messages.channelId, guildId: messages.guildId })
      .from(messages)
      .where(eq(messages.id, messageId))
      .limit(1);

    if (updated) {
      const updatePayload = {
        id: messageId,
        channelId: updated.channelId,
        embeds,
      };

      if (updated.guildId) {
        await emitRoomWithIntent(
          ctx.io,
          `guild:${updated.guildId}`,
          GatewayIntents.GUILD_MESSAGES,
          'MESSAGE_UPDATE',
          updatePayload as any,
        );
      } else {
        await emitRoomWithIntent(
          ctx.io,
          `channel:${updated.channelId}`,
          GatewayIntents.DIRECT_MESSAGES,
          'MESSAGE_UPDATE',
          updatePayload as any,
        );
      }
    }

    logger.debug({ messageId, embedCount: embeds.length }, 'Link previews processed');
  }

  return {
    extractUrls,
    fetchPreview,
    processMessageLinks,
  };
}

export type LinkPreviewService = ReturnType<typeof createLinkPreviewService>;

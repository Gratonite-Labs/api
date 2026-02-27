import type { Server as SocketIOServer, Socket } from 'socket.io';

export const GatewayIntents = {
  GUILDS: 1 << 0,
  GUILD_MEMBERS: 1 << 1,
  GUILD_MESSAGES: 1 << 2,
  GUILD_MESSAGE_TYPING: 1 << 3,
  GUILD_PRESENCES: 1 << 4,
  GUILD_VOICE_STATES: 1 << 5,
  DIRECT_MESSAGES: 1 << 6,
  DIRECT_MESSAGE_TYPING: 1 << 7,
} as const;

export const DEFAULT_INTENTS = 0xffffffff;

const GUILD_EVENT_INTENT_MAP: Record<string, number> = {
  // Guild/member lifecycle
  GUILD_UPDATE: GatewayIntents.GUILDS,
  GUILD_DELETE: GatewayIntents.GUILDS,
  GUILD_MEMBER_ADD: GatewayIntents.GUILD_MEMBERS,
  GUILD_MEMBER_REMOVE: GatewayIntents.GUILD_MEMBERS,
  GUILD_BAN_ADD: GatewayIntents.GUILD_MEMBERS,
  GUILD_BAN_REMOVE: GatewayIntents.GUILD_MEMBERS,

  // Channels/roles
  CHANNEL_CREATE: GatewayIntents.GUILDS,
  CHANNEL_UPDATE: GatewayIntents.GUILDS,
  CHANNEL_DELETE: GatewayIntents.GUILDS,
  GUILD_ROLE_CREATE: GatewayIntents.GUILDS,
  GUILD_ROLE_UPDATE: GatewayIntents.GUILDS,
  GUILD_ROLE_DELETE: GatewayIntents.GUILDS,

  // Messages
  MESSAGE_CREATE: GatewayIntents.GUILD_MESSAGES,
  MESSAGE_UPDATE: GatewayIntents.GUILD_MESSAGES,
  MESSAGE_DELETE: GatewayIntents.GUILD_MESSAGES,
  MESSAGE_REACTION_ADD: GatewayIntents.GUILD_MESSAGES,
  MESSAGE_REACTION_REMOVE: GatewayIntents.GUILD_MESSAGES,
  CHANNEL_PINS_UPDATE: GatewayIntents.GUILD_MESSAGES,
  THREAD_CREATE: GatewayIntents.GUILD_MESSAGES,
  THREAD_UPDATE: GatewayIntents.GUILD_MESSAGES,
  THREAD_DELETE: GatewayIntents.GUILD_MESSAGES,
  THREAD_MEMBER_ADD: GatewayIntents.GUILD_MESSAGES,
  THREAD_MEMBER_REMOVE: GatewayIntents.GUILD_MESSAGES,
  POLL_VOTE_ADD: GatewayIntents.GUILD_MESSAGES,
  POLL_VOTE_REMOVE: GatewayIntents.GUILD_MESSAGES,
  POLL_FINALIZE: GatewayIntents.GUILD_MESSAGES,
  QA_QUESTION_UPDATE: GatewayIntents.GUILD_MESSAGES,
  QA_VOTE_UPDATE: GatewayIntents.GUILD_MESSAGES,
  QA_ANSWER_ACCEPTED: GatewayIntents.GUILD_MESSAGES,
  WIKI_PAGE_CREATE: GatewayIntents.GUILD_MESSAGES,
  WIKI_PAGE_UPDATE: GatewayIntents.GUILD_MESSAGES,
  WIKI_PAGE_DELETE: GatewayIntents.GUILD_MESSAGES,

  // Presence/voice
  PRESENCE_UPDATE: GatewayIntents.GUILD_PRESENCES,
  VOICE_STATE_UPDATE: GatewayIntents.GUILD_VOICE_STATES,
  SCREEN_SHARE_START: GatewayIntents.GUILD_VOICE_STATES,
  SCREEN_SHARE_STOP: GatewayIntents.GUILD_VOICE_STATES,
  STAGE_INSTANCE_CREATE: GatewayIntents.GUILD_VOICE_STATES,
  STAGE_INSTANCE_UPDATE: GatewayIntents.GUILD_VOICE_STATES,
  STAGE_INSTANCE_DELETE: GatewayIntents.GUILD_VOICE_STATES,
  SOUNDBOARD_PLAY: GatewayIntents.GUILD_VOICE_STATES,

  // Moderation/events/branding
  AUTO_MODERATION_RULE_CREATE: GatewayIntents.GUILDS,
  AUTO_MODERATION_RULE_UPDATE: GatewayIntents.GUILDS,
  AUTO_MODERATION_RULE_DELETE: GatewayIntents.GUILDS,
  AUTO_MODERATION_ACTION_EXECUTION: GatewayIntents.GUILDS,
  RAID_DETECTED: GatewayIntents.GUILDS,
  RAID_RESOLVED: GatewayIntents.GUILDS,
  REPORT_CREATE: GatewayIntents.GUILDS,
  REPORT_UPDATE: GatewayIntents.GUILDS,
  GUILD_SCHEDULED_EVENT_CREATE: GatewayIntents.GUILDS,
  GUILD_SCHEDULED_EVENT_UPDATE: GatewayIntents.GUILDS,
  GUILD_SCHEDULED_EVENT_DELETE: GatewayIntents.GUILDS,
  GUILD_SCHEDULED_EVENT_USER_ADD: GatewayIntents.GUILDS,
  GUILD_SCHEDULED_EVENT_USER_REMOVE: GatewayIntents.GUILDS,
  GUILD_BRAND_UPDATE: GatewayIntents.GUILDS,
  GUILD_CSS_UPDATE: GatewayIntents.GUILDS,
  MEMBER_PROFILE_UPDATE: GatewayIntents.GUILD_MEMBERS,
};

export function intentForGuildEvent(event: string) {
  return GUILD_EVENT_INTENT_MAP[event] ?? GatewayIntents.GUILDS;
}

export async function emitRoomWithIntent(
  io: SocketIOServer,
  room: string,
  intent: number,
  event: string,
  payload: unknown,
) {
  const sockets = await io.in(room).fetchSockets();
  for (const rawSocket of sockets) {
    const socket = rawSocket as Socket & { intents?: number };
    if (socket.intents === undefined || (socket.intents & intent) !== 0) {
      socket.emit(event, payload as any);
    }
  }
}

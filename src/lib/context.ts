import type { Server as SocketIOServer } from 'socket.io';
import type { Database } from '@gratonite/db';
import type Redis from 'ioredis';
import type { RoomServiceClient } from 'livekit-server-sdk';
import type { Client as MinioClient } from 'minio';
import type { Env } from '../env.js';

/**
 * Shared context passed to all route handlers and modules.
 * Contains database, Redis, Socket.IO, LiveKit, MinIO, and environment config.
 */
export interface AppContext {
  db: Database;
  redis: Redis;
  io: SocketIOServer;
  env: Env;
  livekit: RoomServiceClient;
  minio: MinioClient;
}

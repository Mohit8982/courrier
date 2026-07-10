import IORedis, { Redis } from 'ioredis';
import { env } from './env';
import { logger } from './logger';

let connection: Redis | null = null;

export function getRedisConnection(): Redis {
  if (connection) return connection;

  connection = new IORedis({
    host: env.REDIS_HOST,
    port: env.REDIS_PORT,
    password: env.REDIS_PASSWORD || undefined,
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    lazyConnect: false,
  });

  connection.on('error', (err) => {
    logger.error('Redis connection error', { error: err.message });
  });

  connection.on('connect', () => {
    logger.info('Redis connected', { host: env.REDIS_HOST, port: env.REDIS_PORT });
  });

  return connection;
}

export async function closeRedisConnection(): Promise<void> {
  if (connection) {
    await connection.quit();
    connection = null;
  }
}

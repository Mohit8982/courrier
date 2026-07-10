import { createApp } from './app';
import { env } from './config/env';
import { logger } from './config/logger';
import { startBulkWorker, stopBulkWorker } from './queue/bulkWorker';
import { closeBulkQueue } from './queue/bulkQueue';
import { closeRedisConnection } from './config/redis';
import { disconnectPrisma } from './repositories/prismaClient';

async function bootstrap() {
  const app = createApp();

  // Start the BullMQ worker in-process (concurrency = env.BULK_CONCURRENCY)
  try {
    startBulkWorker();
  } catch (err) {
    logger.error('Failed to start bulk worker', { error: (err as Error).message });
  }

  const server = app.listen(env.PORT, '0.0.0.0', () => {
    logger.info('Multi-Courier Platform ready', {
      port: env.PORT,
      env: env.NODE_ENV,
    });
  });

  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down...`);
    server.close();
    await stopBulkWorker().catch(() => {});
    await closeBulkQueue().catch(() => {});
    await closeRedisConnection().catch(() => {});
    await disconnectPrisma().catch(() => {});
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fatal bootstrap error:', err);
  process.exit(1);
});

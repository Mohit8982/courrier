import { PrismaClient } from '@prisma/client';
import { logger } from '../config/logger';

/**
 * Prisma client singleton. Reused across the process to avoid
 * connection-pool churn.
 */
class PrismaSingleton {
  private static _client: PrismaClient | null = null;

  static get client(): PrismaClient {
    if (!this._client) {
      this._client = new PrismaClient({
        log: [
          { level: 'error', emit: 'event' },
          { level: 'warn', emit: 'event' },
        ],
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this._client as any).$on('error', (e: unknown) => logger.error('Prisma error', { e }));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this._client as any).$on('warn', (e: unknown) => logger.warn('Prisma warn', { e }));
    }
    return this._client;
  }

  static async disconnect(): Promise<void> {
    if (this._client) {
      await this._client.$disconnect();
      this._client = null;
    }
  }
}

export const prisma = PrismaSingleton.client;
export const disconnectPrisma = () => PrismaSingleton.disconnect();

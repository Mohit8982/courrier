import { Queue, JobsOptions, ConnectionOptions } from 'bullmq';
import { env } from '../config/env';
import { CreateOrderRequest } from '../validators/order.validator';

export interface BulkJobData {
  batchId: string;
  index: number;
  order: CreateOrderRequest;
}

export const BULK_QUEUE_NAME = 'bulk-shipments';
// Per-env prefix isolates tests from dev/prod workers on the same Redis.
export const BULK_QUEUE_PREFIX = `mc-${env.NODE_ENV}`;

export function getBulkConnectionOptions(): ConnectionOptions {
  return {
    host: env.REDIS_HOST,
    port: env.REDIS_PORT,
    password: env.REDIS_PASSWORD || undefined,
    maxRetriesPerRequest: null,
  };
}

let queue: Queue | null = null;

export function getBulkQueue(): Queue {
  if (queue) return queue;
  queue = new Queue(BULK_QUEUE_NAME, {
    connection: getBulkConnectionOptions(),
    prefix: BULK_QUEUE_PREFIX,
    defaultJobOptions: {
      removeOnComplete: { count: 500 },
      removeOnFail: { count: 500 },
      attempts: 1, // adapter-level retry handles transient errors
    } as JobsOptions,
  });
  return queue;
}

export async function closeBulkQueue(): Promise<void> {
  if (queue) {
    await queue.close();
    queue = null;
  }
}

import { Worker, Job } from 'bullmq';
import { BulkJobData, BULK_QUEUE_NAME, BULK_QUEUE_PREFIX, getBulkConnectionOptions } from './bulkQueue';
import { OrderService } from '../services/OrderService';
import { prisma } from '../repositories/prismaClient';
import { env } from '../config/env';
import { logger } from '../config/logger';
import { AppError } from '../errors/AppError';
import { BatchStatus } from '@prisma/client';

export interface BulkResult {
  orderId: string;
  status: 'success' | 'failed';
  courierOrderId?: string;
  trackingNumber?: string;
  errorCode?: string;
  errorMessage?: string;
}

let worker: Worker<BulkJobData> | null = null;

export function startBulkWorker(): Worker<BulkJobData> {
  if (worker) return worker;

  const orderService = new OrderService();

  worker = new Worker<BulkJobData>(
    BULK_QUEUE_NAME,
    async (job: Job<BulkJobData>) => {
      const { batchId, index, order } = job.data;
      let outcome: BulkResult;
      try {
        const { order: created } = await orderService.create(order, { batchId });
        outcome = {
          orderId: order.orderId,
          status: 'success',
          courierOrderId: created.courierOrderId ?? undefined,
          trackingNumber: created.trackingNumber ?? undefined,
        };
      } catch (err) {
        const appErr = err as AppError;
        outcome = {
          orderId: order.orderId,
          status: 'failed',
          errorCode: appErr.code ?? 'INTERNAL_ERROR',
          errorMessage: appErr.message ?? String(err),
        };
        logger.warn('Bulk order failed', {
          batchId,
          index,
          orderId: order.orderId,
          errorCode: outcome.errorCode,
          errorMessage: outcome.errorMessage,
        });
      }

      await appendBulkResultAtomic(batchId, outcome);
      return outcome;
    },
    {
      connection: getBulkConnectionOptions(),
      prefix: BULK_QUEUE_PREFIX,
      concurrency: env.BULK_CONCURRENCY,
    },
  );

  worker.on('failed', (job, err) => {
    logger.error('Bulk worker job failed unexpectedly', {
      jobId: job?.id,
      batchId: job?.data?.batchId,
      error: err.message,
    });
  });

  worker.on('ready', () => logger.info('Bulk worker ready'));

  return worker;
}

export async function stopBulkWorker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
}

/**
 * Atomically append `outcome` to `batch_jobs.results` (JSONB array),
 * increment success/failed counters, and set the final status when done.
 *
 * Uses a single UPDATE ... RETURNING statement so concurrent workers
 * (concurrency = env.BULK_CONCURRENCY) cannot lose writes to the JSON array.
 */
async function appendBulkResultAtomic(batchId: string, outcome: BulkResult): Promise<void> {
  const isSuccess = outcome.status === 'success' ? 1 : 0;
  const isFailure = outcome.status === 'failed' ? 1 : 0;

  const rows = await prisma.$queryRaw<
    { total_orders: number; success_count: number; failed_count: number }[]
  >`
    UPDATE batch_jobs
    SET results = results || ${JSON.stringify([outcome])}::jsonb,
        "successCount" = "successCount" + ${isSuccess},
        "failedCount" = "failedCount" + ${isFailure},
        "updatedAt" = NOW()
    WHERE "batchId" = ${batchId}
    RETURNING "totalOrders" AS total_orders,
              "successCount" AS success_count,
              "failedCount"  AS failed_count
  `;

  if (rows.length === 0) {
    logger.error('Batch not found while appending result', { batchId });
    return;
  }

  const { total_orders, success_count, failed_count } = rows[0];
  const done = success_count + failed_count >= total_orders;
  if (!done) return;

  const nextStatus: BatchStatus =
    failed_count === 0
      ? BatchStatus.COMPLETED
      : success_count === 0
        ? BatchStatus.FAILED
        : BatchStatus.PARTIAL;

  await prisma.batchJob.update({
    where: { batchId },
    data: { status: nextStatus },
  });
}

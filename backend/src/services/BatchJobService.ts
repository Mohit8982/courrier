import { randomUUID } from 'crypto';
import { BatchStatus } from '@prisma/client';
import { BatchRepository } from '../repositories/BatchRepository';
import { getBulkQueue } from '../queue/bulkQueue';
import { CreateOrderRequest } from '../validators/order.validator';
import { NotFoundError, ValidationError } from '../errors/AppError';
import { env } from '../config/env';
import { logger } from '../config/logger';

export class BatchJobService {
  constructor(
    private readonly batchRepo: BatchRepository = new BatchRepository(),
    private readonly queueFactory: () => ReturnType<typeof getBulkQueue> = getBulkQueue,
  ) {}

  async enqueueBulk(orders: CreateOrderRequest[], ctx: { requestId?: string } = {}) {
    if (orders.length === 0) {
      throw new ValidationError('orders must be non-empty');
    }
    if (orders.length > env.BULK_MAX_ORDERS) {
      throw new ValidationError(
        `Too many orders (${orders.length}); max allowed is ${env.BULK_MAX_ORDERS}`,
      );
    }

    // Enforce orderId uniqueness within the batch itself
    const ids = new Set<string>();
    for (const o of orders) {
      if (ids.has(o.orderId)) {
        throw new ValidationError(`Duplicate orderId '${o.orderId}' within batch`);
      }
      ids.add(o.orderId);
    }

    const batchId = `batch_${randomUUID()}`;
    const batch = await this.batchRepo.create({
      batchId,
      totalOrders: orders.length,
      status: BatchStatus.PENDING,
      results: [],
    });

    const queue = this.queueFactory();
    for (let i = 0; i < orders.length; i++) {
      await queue.add(
        'create-shipment',
        { batchId, index: i, order: orders[i] },
        { jobId: `${batchId}-${i}` },
      );
    }

    // Optimistically mark as PROCESSING (worker will move to COMPLETED/PARTIAL/FAILED)
    await this.batchRepo.updateStatus(batchId, BatchStatus.PROCESSING);

    logger.info('Bulk batch enqueued', {
      requestId: ctx.requestId,
      batchId,
      totalOrders: orders.length,
    });

    return { batch, batchId };
  }

  async getBatch(batchId: string) {
    const batch = await this.batchRepo.findByBatchId(batchId);
    if (!batch) throw new NotFoundError('Batch', batchId);
    return batch;
  }
}

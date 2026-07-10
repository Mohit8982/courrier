import { Request, Response, NextFunction } from 'express';
import { OrderService } from '../services/OrderService';
import { TrackingService } from '../services/TrackingService';
import { CancellationService } from '../services/CancellationService';
import { BatchJobService } from '../services/BatchJobService';
import {
  bulkCreateSchema,
  cancelOrderSchema,
  createOrderSchema,
} from '../validators/order.validator';

/**
 * Controllers hold NO business logic — they:
 *   1. validate request body via Zod
 *   2. delegate to service
 *   3. shape the HTTP response
 */
export class OrderController {
  constructor(
    private readonly orderService = new OrderService(),
    private readonly trackingService = new TrackingService(),
    private readonly cancellationService = new CancellationService(),
    private readonly batchService = new BatchJobService(),
  ) {}

  create = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = createOrderSchema.parse(req.body);
      const { order, wasExisting } = await this.orderService.create(parsed, {
        requestId: req.requestId,
      });
      res.status(wasExisting ? 200 : 201).json({
        data: order,
        idempotent: wasExisting,
      });
    } catch (err) {
      next(err);
    }
  };

  getById = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const order = await this.orderService.getByOrderId(req.params.id);
      res.status(200).json({ data: order });
    } catch (err) {
      next(err);
    }
  };

  track = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await this.trackingService.track(req.params.id, {
        requestId: req.requestId,
      });
      res.status(200).json({
        data: {
          orderId: result.order.orderId,
          currentStatus: result.currentStatus ?? result.order.status,
          trackingNumber: result.order.trackingNumber,
          events: result.events,
        },
      });
    } catch (err) {
      next(err);
    }
  };

  cancel = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = cancelOrderSchema.parse(req.body ?? {});
      const { order, alreadyCancelled } = await this.cancellationService.cancel(
        req.params.id,
        parsed.reason,
        { requestId: req.requestId },
      );
      res.status(200).json({ data: order, alreadyCancelled });
    } catch (err) {
      next(err);
    }
  };

  bulkCreate = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = bulkCreateSchema.parse(req.body);
      const { batch } = await this.batchService.enqueueBulk(parsed.orders, {
        requestId: req.requestId,
      });
      res.status(202).json({
        data: {
          batchId: batch.batchId,
          totalOrders: batch.totalOrders,
          status: batch.status,
        },
      });
    } catch (err) {
      next(err);
    }
  };
}

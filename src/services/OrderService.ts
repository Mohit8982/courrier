import { Order } from '@prisma/client';
import { OrderRepository } from '../repositories/OrderRepository';
import { TrackingRepository } from '../repositories/TrackingRepository';
import { CourierRepository } from '../repositories/CourierRepository';
import { CourierFactory } from '../couriers/factory/CourierFactory';
import { CreateShipmentInput } from '../couriers/interfaces/ICourierAdapter';
import { NotFoundError, UnsupportedCourierError } from '../errors/AppError';
import { logger } from '../config/logger';
import { CreateOrderRequest } from '../validators/order.validator';

export interface CreateOrderResult {
  order: Order;
  wasExisting: boolean;
}

export class OrderService {
  constructor(
    private readonly orderRepo: OrderRepository = new OrderRepository(),
    private readonly trackingRepo: TrackingRepository = new TrackingRepository(),
    private readonly courierRepo: CourierRepository = new CourierRepository(),
    private readonly factory: typeof CourierFactory = CourierFactory,
  ) {}

  /**
   * Idempotent create. If an Order with the same orderId already exists,
   * return it as-is (wasExisting = true).
   */
  async create(
    req: CreateOrderRequest,
    ctx: { requestId?: string; batchId?: string } = {},
  ): Promise<CreateOrderResult> {
    const existing = await this.orderRepo.findByOrderId(req.orderId);
    if (existing) {
      logger.info('Idempotent create: returning existing order', {
        requestId: ctx.requestId,
        orderId: req.orderId,
      });
      return { order: existing, wasExisting: true };
    }

    const courier = await this.courierRepo.findByName(req.courierName);
    if (!courier || !courier.isActive) {
      throw new UnsupportedCourierError(req.courierName);
    }

    const adapter = this.factory.create(req.courierName);
    const adapterInput: CreateShipmentInput = {
      orderId: req.orderId,
      pickup: req.pickup,
      delivery: req.delivery,
      package: req.package,
      payment: req.payment,
      productType: req.productType,
      metadata: req.metadata,
    };

    const started = Date.now();
    const result = await adapter.createShipment(adapterInput);
    logger.info('Courier createShipment succeeded', {
      requestId: ctx.requestId,
      orderId: req.orderId,
      courierPartner: adapter.courierName,
      durationMs: Date.now() - started,
    });

    const order = await this.orderRepo.create({
      orderId: req.orderId,
      courier: { connect: { id: courier.id } },
      courierOrderId: result.courierOrderId,
      trackingNumber: result.trackingNumber,
      status: result.status,
      requestPayload: req as unknown as object,
      responsePayload: result.rawResponse as object,
      batchId: ctx.batchId,
    });

    await this.trackingRepo.append({
      order: { connect: { id: order.id } },
      status: result.status,
      description: 'Shipment created',
      location: null,
      eventTime: new Date(),
      metadata: { source: 'create' },
    });

    return { order, wasExisting: false };
  }

  async getByOrderId(orderId: string) {
    const order = await this.orderRepo.findByOrderIdWithCourier(orderId);
    if (!order) throw new NotFoundError('Order', orderId);
    return order;
  }
}

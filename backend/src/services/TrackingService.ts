import { Order } from '@prisma/client';
import { OrderRepository } from '../repositories/OrderRepository';
import { TrackingRepository } from '../repositories/TrackingRepository';
import { prisma } from '../repositories/prismaClient';
import { CourierFactory } from '../couriers/factory/CourierFactory';
import { NotFoundError } from '../errors/AppError';
import { logger } from '../config/logger';

export class TrackingService {
  constructor(
    private readonly orderRepo: OrderRepository = new OrderRepository(),
    private readonly trackingRepo: TrackingRepository = new TrackingRepository(),
    private readonly factory: typeof CourierFactory = CourierFactory,
  ) {}

  async track(orderId: string, ctx: { requestId?: string } = {}) {
    const order = await this.orderRepo.findByOrderId(orderId);
    if (!order) throw new NotFoundError('Order', orderId);

    const courier = await prisma.courier.findUnique({ where: { id: order.courierId } });
    if (!courier) throw new NotFoundError('Courier', order.courierId);

    if (!order.trackingNumber) {
      const history = await this.trackingRepo.findByOrderId(order.id);
      return { order, events: history, currentStatus: order.status };
    }

    const adapter = this.factory.create(courier.name);
    const started = Date.now();
    const result = await adapter.trackShipment(
      order.trackingNumber,
      order.courierOrderId ?? undefined,
    );
    logger.info('Courier trackShipment succeeded', {
      requestId: ctx.requestId,
      orderId: order.orderId,
      courierPartner: adapter.courierName,
      durationMs: Date.now() - started,
      eventCount: result.events.length,
    });

    const existing = await this.trackingRepo.findByOrderId(order.id);
    const seen = new Set(existing.map((e) => `${e.status}|${e.eventTime.toISOString()}`));

    for (const evt of result.events) {
      const key = `${evt.status}|${evt.eventTime.toISOString()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      await this.trackingRepo.append({
        order: { connect: { id: order.id } },
        status: evt.status,
        description: evt.description,
        location: evt.location,
        eventTime: evt.eventTime,
        metadata: (evt.metadata ?? {}) as object,
      });
    }

    let updated: Order = order;
    if (order.status !== result.currentStatus) {
      updated = await this.orderRepo.updateStatus(order.id, result.currentStatus);
    }

    const history = await this.trackingRepo.findByOrderId(order.id);
    return { order: updated, events: history, currentStatus: result.currentStatus };
  }
}

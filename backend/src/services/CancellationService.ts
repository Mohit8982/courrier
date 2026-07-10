import { ShipmentStatus } from '@prisma/client';
import { OrderRepository } from '../repositories/OrderRepository';
import { TrackingRepository } from '../repositories/TrackingRepository';
import { prisma } from '../repositories/prismaClient';
import { CourierFactory } from '../couriers/factory/CourierFactory';
import { InvalidStateError, NotFoundError } from '../errors/AppError';
import { canCancel } from '../utils/statusEnum';
import { logger } from '../config/logger';

export class CancellationService {
  constructor(
    private readonly orderRepo: OrderRepository = new OrderRepository(),
    private readonly trackingRepo: TrackingRepository = new TrackingRepository(),
    private readonly factory: typeof CourierFactory = CourierFactory,
  ) {}

  async cancel(orderId: string, reason?: string, ctx: { requestId?: string } = {}) {
    const order = await this.orderRepo.findByOrderId(orderId);
    if (!order) throw new NotFoundError('Order', orderId);

    if (order.status === ShipmentStatus.CANCELLED) {
      return { order, alreadyCancelled: true };
    }

    if (!canCancel(order.status)) {
      throw new InvalidStateError(
        `Cannot cancel order in status ${order.status}`,
        { orderId, status: order.status },
      );
    }

    const courier = await prisma.courier.findUnique({ where: { id: order.courierId } });
    if (!courier) throw new NotFoundError('Courier', order.courierId);

    const adapter = this.factory.create(courier.name);
    if (!order.courierOrderId) {
      throw new InvalidStateError(
        'Order has no courierOrderId; cannot cancel with courier',
        { orderId },
      );
    }

    const started = Date.now();
    const result = await adapter.cancelShipment({
      courierOrderId: order.courierOrderId,
      trackingNumber: order.trackingNumber,
      reason,
    });
    logger.info('Courier cancelShipment succeeded', {
      requestId: ctx.requestId,
      orderId: order.orderId,
      courierPartner: adapter.courierName,
      durationMs: Date.now() - started,
    });

    const updated = await this.orderRepo.updateStatus(order.id, ShipmentStatus.CANCELLED);
    await this.trackingRepo.append({
      order: { connect: { id: order.id } },
      status: ShipmentStatus.CANCELLED,
      description: reason ?? 'Cancelled by user',
      location: null,
      eventTime: result.cancelledAt,
      metadata: { source: 'cancel', rawResponse: result.rawResponse as object },
    });

    return { order: updated, alreadyCancelled: false };
  }
}

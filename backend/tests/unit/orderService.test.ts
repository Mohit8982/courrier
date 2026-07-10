import { OrderService } from '../../src/services/OrderService';
import { OrderRepository } from '../../src/repositories/OrderRepository';
import { CourierRepository } from '../../src/repositories/CourierRepository';
import { TrackingRepository } from '../../src/repositories/TrackingRepository';
import { CourierFactory } from '../../src/couriers/factory/CourierFactory';
import { makeOrderRequest } from '../helpers/fixtures';
import { UnsupportedCourierError } from '../../src/errors/AppError';
import { ShipmentStatus } from '@prisma/client';

/**
 * Pure-unit tests for OrderService: all deps are mocked so this test
 * does not touch the DB.
 */
describe('OrderService (with mocked deps)', () => {
  function build() {
    const orderRepo = {
      findByOrderId: jest.fn(),
      create: jest.fn(),
      findByOrderIdWithCourier: jest.fn(),
    } as unknown as OrderRepository;
    const trackingRepo = {
      append: jest.fn().mockResolvedValue(undefined),
    } as unknown as TrackingRepository;
    const courierRepo = {
      findByName: jest.fn(),
    } as unknown as CourierRepository;
    const adapter = {
      courierName: 'MockCourier',
      createShipment: jest.fn(),
    };
    const factory = { create: jest.fn().mockReturnValue(adapter) } as unknown as typeof CourierFactory;
    const svc = new OrderService(orderRepo, trackingRepo, courierRepo, factory);
    return { svc, orderRepo, trackingRepo, courierRepo, factory, adapter };
  }

  it('returns existing order when duplicate (idempotency)', async () => {
    const { svc, orderRepo } = build();
    const existing = { id: 1, orderId: 'X', status: 'CREATED' } as any;
    (orderRepo.findByOrderId as jest.Mock).mockResolvedValue(existing);

    const { order, wasExisting } = await svc.create(makeOrderRequest({ orderId: 'X' }));
    expect(wasExisting).toBe(true);
    expect(order).toBe(existing);
  });

  it('throws UnsupportedCourierError if courier not found', async () => {
    const { svc, orderRepo, courierRepo } = build();
    (orderRepo.findByOrderId as jest.Mock).mockResolvedValue(null);
    (courierRepo.findByName as jest.Mock).mockResolvedValue(null);
    await expect(svc.create(makeOrderRequest())).rejects.toBeInstanceOf(UnsupportedCourierError);
  });

  it('happy path: creates via adapter, persists order + tracking event', async () => {
    const { svc, orderRepo, trackingRepo, courierRepo, adapter, factory } = build();
    (orderRepo.findByOrderId as jest.Mock).mockResolvedValue(null);
    (courierRepo.findByName as jest.Mock).mockResolvedValue({ id: 42, name: 'MockCourier', isActive: true });
    (adapter.createShipment as jest.Mock).mockResolvedValue({
      courierOrderId: 'CO-1',
      trackingNumber: 'TN-1',
      status: ShipmentStatus.CREATED,
      rawResponse: { r: 1 },
    });
    (orderRepo.create as jest.Mock).mockResolvedValue({
      id: 7,
      orderId: 'Y',
      status: ShipmentStatus.CREATED,
      trackingNumber: 'TN-1',
    });

    const { order, wasExisting } = await svc.create(makeOrderRequest({ orderId: 'Y' }));
    expect(wasExisting).toBe(false);
    expect(order.id).toBe(7);
    expect(factory.create).toHaveBeenCalledWith('MockCourier');
    expect(trackingRepo.append).toHaveBeenCalled();
  });

  it('rejects inactive courier as unsupported', async () => {
    const { svc, orderRepo, courierRepo } = build();
    (orderRepo.findByOrderId as jest.Mock).mockResolvedValue(null);
    (courierRepo.findByName as jest.Mock).mockResolvedValue({ id: 1, name: 'X', isActive: false });
    await expect(svc.create(makeOrderRequest())).rejects.toBeInstanceOf(UnsupportedCourierError);
  });
});

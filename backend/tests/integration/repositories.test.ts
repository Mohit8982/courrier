import { OrderRepository } from '../../src/repositories/OrderRepository';
import { TrackingRepository } from '../../src/repositories/TrackingRepository';
import { BatchRepository } from '../../src/repositories/BatchRepository';
import { CourierRepository } from '../../src/repositories/CourierRepository';
import { resetDatabase, disconnectAll } from '../helpers/db';
import { BatchStatus, ShipmentStatus } from '@prisma/client';

beforeAll(async () => {
  await resetDatabase();
});
afterAll(async () => {
  await disconnectAll();
});

describe('Repositories', () => {
  it('CourierRepository finds seeded couriers', async () => {
    const repo = new CourierRepository();
    const mock = await repo.findByName('MockCourier');
    expect(mock).not.toBeNull();
    expect(mock!.isActive).toBe(true);
    const list = await repo.listActive();
    expect(list.map((c) => c.name).sort()).toEqual(['MockCourier', 'Urbanebolt']);
  });

  it('OrderRepository create + findByOrderId + updateStatus', async () => {
    const courierRepo = new CourierRepository();
    const c = await courierRepo.findByName('MockCourier');
    const orderRepo = new OrderRepository();
    const created = await orderRepo.create({
      orderId: 'RT-1',
      courier: { connect: { id: c!.id } },
      status: ShipmentStatus.CREATED,
      requestPayload: { any: true },
    });
    const found = await orderRepo.findByOrderId('RT-1');
    expect(found?.id).toBe(created.id);

    const updated = await orderRepo.updateStatus(created.id, ShipmentStatus.PICKED_UP);
    expect(updated.status).toBe(ShipmentStatus.PICKED_UP);
  });

  it('TrackingRepository append + list', async () => {
    const courierRepo = new CourierRepository();
    const c = await courierRepo.findByName('MockCourier');
    const orderRepo = new OrderRepository();
    const trackRepo = new TrackingRepository();

    const o = await orderRepo.create({
      orderId: 'RT-2',
      courier: { connect: { id: c!.id } },
      status: ShipmentStatus.CREATED,
      requestPayload: {},
    });

    await trackRepo.append({
      order: { connect: { id: o.id } },
      status: ShipmentStatus.CREATED,
      description: 'first',
      eventTime: new Date('2026-01-01T00:00:00Z'),
      location: null,
    });
    await trackRepo.append({
      order: { connect: { id: o.id } },
      status: ShipmentStatus.IN_TRANSIT,
      description: 'second',
      eventTime: new Date('2026-01-01T02:00:00Z'),
      location: 'HubB',
    });

    const events = await trackRepo.findByOrderId(o.id);
    expect(events).toHaveLength(2);
    const latest = await trackRepo.latestForOrder(o.id);
    expect(latest?.status).toBe(ShipmentStatus.IN_TRANSIT);
  });

  it('BatchRepository create + increment + status update', async () => {
    const repo = new BatchRepository();
    const b = await repo.create({
      batchId: 'batch_test_1',
      totalOrders: 3,
      status: BatchStatus.PENDING,
      results: [],
    });
    await repo.incrementCounts('batch_test_1', 2, 1);
    const updated = await repo.updateStatus('batch_test_1', BatchStatus.PARTIAL);
    expect(updated.status).toBe(BatchStatus.PARTIAL);
    expect(updated.successCount).toBe(2);
    expect(updated.failedCount).toBe(1);

    const fetched = await repo.findByBatchId('batch_test_1');
    expect(fetched?.id).toBe(b.id);
  });
});

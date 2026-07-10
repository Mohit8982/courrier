import { MockCourierAdapter } from '../../src/couriers/adapters/MockCourierAdapter';
import { makeOrderRequest } from '../helpers/fixtures';
import { ShipmentStatus } from '@prisma/client';
import nock from 'nock';

beforeAll(() => nock.disableNetConnect());
afterAll(() => nock.enableNetConnect());
afterEach(() => nock.cleanAll());

const BASE = process.env.MOCK_COURIER_BASE_URL!;

describe('MockCourierAdapter', () => {
  it('createShipment falls back to deterministic result when network fails', async () => {
    // No nock scope for /shipments => request will hit the http client which
    // fails due to nock.disableNetConnect(). Adapter should fallback.
    const a = new MockCourierAdapter();
    const req = makeOrderRequest({ orderId: 'ORD-M-1' });
    const res = await a.createShipment(req);
    expect(res.courierOrderId).toMatch(/^MOCK-[A-F0-9]{10}$/);
    expect(res.trackingNumber).toMatch(/^MCT[A-F0-9]{10}$/);
    expect(res.status).toBe(ShipmentStatus.CREATED);
  });

  it('createShipment uses HTTP response when available', async () => {
    nock(BASE)
      .post('/shipments')
      .reply(200, {
        awb: 'HTTP-AWB',
        courier_order_id: 'HTTP-CO',
        status: 'CREATED',
      });

    const a = new MockCourierAdapter();
    const res = await a.createShipment(makeOrderRequest());
    expect(res.trackingNumber).toBe('HTTP-AWB');
    expect(res.courierOrderId).toBe('HTTP-CO');
  });

  it('createShipment surfaces 4xx as CourierAPIError (no fallback)', async () => {
    nock(BASE).post('/shipments').reply(400, { error: 'bad' });
    const a = new MockCourierAdapter();
    await expect(a.createShipment(makeOrderRequest())).rejects.toThrow(/createShipment failed/);
  });

  it('trackShipment falls back to deterministic events on network failure', async () => {
    const a = new MockCourierAdapter();
    const r = await a.trackShipment('MCT1234');
    expect(r.events.length).toBeGreaterThan(0);
    expect(r.currentStatus).toBe(ShipmentStatus.IN_TRANSIT);
  });

  it('cancelShipment falls back on network failure', async () => {
    const a = new MockCourierAdapter();
    const r = await a.cancelShipment({ courierOrderId: 'MOCK-1', trackingNumber: 'MCT1' });
    expect(r.cancelled).toBe(true);
  });

  it('same orderId produces same tracking number (deterministic)', async () => {
    const a = new MockCourierAdapter();
    const a1 = await a.createShipment(makeOrderRequest({ orderId: 'DET-1' }));
    const a2 = await a.createShipment(makeOrderRequest({ orderId: 'DET-1' }));
    expect(a1.trackingNumber).toBe(a2.trackingNumber);
  });
});

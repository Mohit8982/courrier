import nock from 'nock';
import request from 'supertest';
import { createApp } from '../../src/app';
import { resetDatabase, disconnectAll } from '../helpers/db';
import { makeOrderRequest } from '../helpers/fixtures';
import { CourierFactory } from '../../src/couriers/factory/CourierFactory';

const BASE = process.env.URBANEBOLT_BASE_URL!;

beforeAll(() => {
  nock.disableNetConnect();
  nock.enableNetConnect('127.0.0.1');
});
afterAll(async () => {
  nock.enableNetConnect();
  await disconnectAll();
});
beforeEach(async () => {
  nock.cleanAll();
  await resetDatabase();
  CourierFactory.resetInstances();
});

const app = createApp();

describe('GET /api/orders/:id/track', () => {
  it('mock courier: returns deterministic events and updates current status', async () => {
    const req = makeOrderRequest({ orderId: 'ORD-TR-1' });
    await request(app).post('/api/orders').send(req).expect(201);

    const res = await request(app).get('/api/orders/ORD-TR-1/track');
    expect(res.status).toBe(200);
    expect(res.body.data.currentStatus).toBe('IN_TRANSIT');
    expect(res.body.data.events.length).toBeGreaterThanOrEqual(3);
  });

  it('urbanebolt: appends new events and updates order.status', async () => {
    // Create
    nock(BASE).post('/api/v1/auth/getToken/').reply(200, { token: 't' });
    nock(BASE)
      .post('/api/v1/services/manifest/')
      .reply(200, { data: { awb: 'TR-AWB', courier_order_id: 'TR-CO', status: 'MANIFESTED' } });

    // Track
    nock(BASE)
      .get('/api/v1/services/tracking/?awbs=TR-AWB')
      .reply(200, {
        data: {
          current_status: 'DELIVERED',
          events: [
            { status: 'MANIFESTED', event_time: '2026-01-01T00:00:00Z' },
            { status: 'PICKED_UP', event_time: '2026-01-01T01:00:00Z' },
            { status: 'DELIVERED', event_time: '2026-01-01T05:00:00Z' },
          ],
        },
      });

    const req = makeOrderRequest({ orderId: 'ORD-UB-TR', courierName: 'Urbanebolt' });
    await request(app).post('/api/orders').send(req).expect(201);

    const res = await request(app).get('/api/orders/ORD-UB-TR/track');
    expect(res.status).toBe(200);
    expect(res.body.data.currentStatus).toBe('DELIVERED');

    // GET reflects updated status
    const get = await request(app).get('/api/orders/ORD-UB-TR');
    expect(get.body.data.status).toBe('DELIVERED');
    // Tracking history includes original CREATED + 3 new events
    expect(get.body.data.tracking.length).toBeGreaterThanOrEqual(3);
  });

  it('404 for unknown orderId', async () => {
    const res = await request(app).get('/api/orders/nope/track');
    expect(res.status).toBe(404);
  });
});

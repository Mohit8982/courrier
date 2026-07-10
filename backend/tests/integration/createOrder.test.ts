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

describe('POST /api/orders — create + idempotency', () => {
  it('creates order with MockCourier (deterministic fallback)', async () => {
    const req = makeOrderRequest({ orderId: 'ORD-INT-1' });
    const res = await request(app).post('/api/orders').send(req);
    expect(res.status).toBe(201);
    expect(res.body.data.orderId).toBe('ORD-INT-1');
    expect(res.body.data.trackingNumber).toMatch(/^MCT[A-F0-9]{10}$/);
    expect(res.body.idempotent).toBe(false);
  });

  it('is idempotent — second call with same orderId returns existing (idempotent=true)', async () => {
    const req = makeOrderRequest({ orderId: 'ORD-IDEM-1' });
    const r1 = await request(app).post('/api/orders').send(req);
    const r2 = await request(app).post('/api/orders').send(req);

    expect(r1.status).toBe(201);
    expect(r2.status).toBe(200);
    expect(r2.body.idempotent).toBe(true);
    expect(r2.body.data.trackingNumber).toBe(r1.body.data.trackingNumber);
  });

  it('returns 400 VALIDATION_ERROR on bad payload', async () => {
    const res = await request(app).post('/api/orders').send({ orderId: '' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 UNSUPPORTED_COURIER for unknown courier', async () => {
    const req = makeOrderRequest({ courierName: 'NoSuchCo' });
    const res = await request(app).post('/api/orders').send(req);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('UNSUPPORTED_COURIER');
  });

  it('creates with Urbanebolt when upstream responds', async () => {
    nock(BASE).post('/api/v1/auth/getToken/').reply(200, { token: 'tok' });
    nock(BASE)
      .post('/api/v1/services/manifest/')
      .reply(200, { data: { awb: 'INT-AWB', courier_order_id: 'INT-CO', status: 'MANIFESTED' } });

    const req = makeOrderRequest({ orderId: 'ORD-UB-INT', courierName: 'Urbanebolt' });
    const res = await request(app).post('/api/orders').send(req);
    expect(res.status).toBe(201);
    expect(res.body.data.trackingNumber).toBe('INT-AWB');
    expect(res.body.data.courierOrderId).toBe('INT-CO');
    expect(res.body.data.status).toBe('CREATED');
  });
});

describe('GET /api/orders/:id', () => {
  it('returns order with tracking history', async () => {
    const req = makeOrderRequest({ orderId: 'ORD-GET-1' });
    await request(app).post('/api/orders').send(req).expect(201);

    const res = await request(app).get('/api/orders/ORD-GET-1');
    expect(res.status).toBe(200);
    expect(res.body.data.orderId).toBe('ORD-GET-1');
    expect(res.body.data.tracking).toHaveLength(1); // CREATED event
  });

  it('404 for missing order', async () => {
    const res = await request(app).get('/api/orders/DOES-NOT-EXIST');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});

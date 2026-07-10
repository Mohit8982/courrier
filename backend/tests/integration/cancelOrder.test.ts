import nock from 'nock';
import request from 'supertest';
import { createApp } from '../../src/app';
import { resetDatabase, disconnectAll } from '../helpers/db';
import { makeOrderRequest } from '../helpers/fixtures';
import { CourierFactory } from '../../src/couriers/factory/CourierFactory';

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

describe('POST /api/orders/:id/cancel', () => {
  it('cancels a fresh order (mock courier)', async () => {
    const req = makeOrderRequest({ orderId: 'ORD-C-1' });
    await request(app).post('/api/orders').send(req).expect(201);

    const res = await request(app)
      .post('/api/orders/ORD-C-1/cancel')
      .send({ reason: 'customer_request' });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('CANCELLED');
    expect(res.body.alreadyCancelled).toBe(false);
  });

  it('returns alreadyCancelled=true on second cancel', async () => {
    const req = makeOrderRequest({ orderId: 'ORD-C-2' });
    await request(app).post('/api/orders').send(req).expect(201);
    await request(app).post('/api/orders/ORD-C-2/cancel').send({}).expect(200);

    const res = await request(app).post('/api/orders/ORD-C-2/cancel').send({});
    expect(res.status).toBe(200);
    expect(res.body.alreadyCancelled).toBe(true);
  });

  it('refuses to cancel IN_TRANSIT (409 INVALID_STATE)', async () => {
    const req = makeOrderRequest({ orderId: 'ORD-C-3' });
    await request(app).post('/api/orders').send(req).expect(201);
    // Track moves it to IN_TRANSIT
    await request(app).get('/api/orders/ORD-C-3/track').expect(200);

    const res = await request(app).post('/api/orders/ORD-C-3/cancel').send({});
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INVALID_STATE');
  });

  it('404 for unknown order', async () => {
    const res = await request(app).post('/api/orders/none/cancel').send({});
    expect(res.status).toBe(404);
  });
});

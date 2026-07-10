import request from 'supertest';
import nock from 'nock';
import { createApp } from '../../src/app';
import { resetDatabase, disconnectAll } from '../helpers/db';
import { makeOrderRequest } from '../helpers/fixtures';
import { startBulkWorker, stopBulkWorker } from '../../src/queue/bulkWorker';
import { closeBulkQueue, getBulkQueue } from '../../src/queue/bulkQueue';
import { CourierFactory } from '../../src/couriers/factory/CourierFactory';

const app = createApp();

beforeAll(async () => {
  nock.disableNetConnect();
  nock.enableNetConnect('127.0.0.1');
  await resetDatabase();
  // Purge any lingering jobs from prior test runs
  const q = getBulkQueue();
  await q.drain(true);
  startBulkWorker();
});

afterAll(async () => {
  nock.enableNetConnect();
  await stopBulkWorker();
  await closeBulkQueue();
  await disconnectAll();
});

beforeEach(async () => {
  await resetDatabase();
  CourierFactory.resetInstances();
});

async function waitForBatch(batchId: string, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await request(app).get(`/api/batches/${batchId}`);
    const status = res.body?.data?.status;
    if (status === 'COMPLETED' || status === 'PARTIAL' || status === 'FAILED') {
      return res.body.data;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Batch ${batchId} did not complete in ${timeoutMs}ms`);
}

describe('POST /api/orders/bulk', () => {
  it('processes 3 orders successfully — status COMPLETED', async () => {
    const orders = [
      makeOrderRequest({ orderId: 'B-A-1' }),
      makeOrderRequest({ orderId: 'B-A-2' }),
      makeOrderRequest({ orderId: 'B-A-3' }),
    ];
    const res = await request(app).post('/api/orders/bulk').send({ orders });
    expect(res.status).toBe(202);
    expect(res.body.data.totalOrders).toBe(3);

    const final = await waitForBatch(res.body.data.batchId);
    expect(final.status).toBe('COMPLETED');
    expect(final.successCount).toBe(3);
    expect(final.failedCount).toBe(0);
    expect(final.results).toHaveLength(3);
  });

  it('partial success — mix of valid + invalid courier => PARTIAL', async () => {
    const orders = [
      makeOrderRequest({ orderId: 'B-B-1' }),
      makeOrderRequest({ orderId: 'B-B-2', courierName: 'NoSuchCo' }),
      makeOrderRequest({ orderId: 'B-B-3' }),
    ];
    const res = await request(app).post('/api/orders/bulk').send({ orders }).expect(202);
    const final = await waitForBatch(res.body.data.batchId);
    expect(final.status).toBe('PARTIAL');
    expect(final.successCount).toBe(2);
    expect(final.failedCount).toBe(1);
    const failed = (final.results as Array<{ orderId: string; status: string; errorCode: string }>)
      .find((r) => r.status === 'failed');
    expect(failed?.orderId).toBe('B-B-2');
    expect(failed?.errorCode).toBe('UNSUPPORTED_COURIER');
  });

  it('rejects payload with duplicate orderIds inside the batch', async () => {
    const orders = [
      makeOrderRequest({ orderId: 'DUP-1' }),
      makeOrderRequest({ orderId: 'DUP-1' }),
    ];
    const res = await request(app).post('/api/orders/bulk').send({ orders });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects > 100 orders', async () => {
    const orders = Array.from({ length: 101 }, (_, i) => makeOrderRequest({ orderId: `X-${i}` }));
    const res = await request(app).post('/api/orders/bulk').send({ orders });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('GET /api/batches/:id returns 404 for unknown batch', async () => {
    const res = await request(app).get('/api/batches/batch_nope');
    expect(res.status).toBe(404);
  });
});

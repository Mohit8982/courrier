import nock from 'nock';
import { UrbaneboltAdapter } from '../../src/couriers/adapters/UrbaneboltAdapter';
import {
  AuthenticationError,
  CourierAPIError,
} from '../../src/errors/AppError';
import { ShipmentStatus } from '@prisma/client';
import { makeOrderRequest } from '../helpers/fixtures';

const BASE_URL = process.env.URBANEBOLT_BASE_URL!;

beforeAll(() => {
  nock.disableNetConnect();
});
afterAll(() => {
  nock.enableNetConnect();
});
afterEach(() => {
  nock.cleanAll();
});

function newAdapter() {
  const a = new UrbaneboltAdapter();
  // ensure no cached token from prior test
  (a as any)._clearAuthCache();
  return a;
}

describe('UrbaneboltAdapter', () => {
  describe('authenticate + createShipment', () => {
    it('fetches token, creates shipment and normalizes status', async () => {
      nock(BASE_URL)
        .post('/api/v1/auth/getToken/')
        .reply(200, { token: 'abc-token' });
      nock(BASE_URL)
        .post('/api/v1/services/manifest/')
        .matchHeader('authorization', 'Bearer abc-token')
        .reply(200, {
          data: {
            awb: 'AWB123',
            courier_order_id: 'UB-CO-1',
            status: 'MANIFESTED',
          },
        });

      const a = newAdapter();
      const req = makeOrderRequest({ orderId: 'ORD-UB-1', courierName: 'Urbanebolt' });
      const res = await a.createShipment(req);
      expect(res.courierOrderId).toBe('UB-CO-1');
      expect(res.trackingNumber).toBe('AWB123');
      expect(res.status).toBe(ShipmentStatus.CREATED); // MANIFESTED -> CREATED
    });

    it('caches the token across calls (only one /auth call for two ops)', async () => {
      const authScope = nock(BASE_URL)
        .post('/api/v1/auth/getToken/')
        .reply(200, { token: 'cached-token' });

      nock(BASE_URL)
        .post('/api/v1/services/manifest/')
        .reply(200, { data: { awb: 'A1', courier_order_id: 'X1', status: 'PICKED_UP' } });
      nock(BASE_URL)
        .get('/api/v1/services/tracking/?awbs=A1')
        .reply(200, {
          data: {
            current_status: 'IN_TRANSIT',
            events: [],
          },
        });

      const a = newAdapter();
      const created = await a.createShipment(makeOrderRequest({ courierName: 'Urbanebolt' }));
      await a.trackShipment(created.trackingNumber);

      expect(authScope.isDone()).toBe(true);
    });

    it('handles 401 -> refresh token -> retry once', async () => {
      // First auth
      nock(BASE_URL).post('/api/v1/auth/getToken/').reply(200, { token: 't-old' });
      // First manifest → 401 with the old token
      nock(BASE_URL)
        .post('/api/v1/services/manifest/')
        .matchHeader('authorization', 'Bearer t-old')
        .reply(401, { error: 'expired' });
      // Second auth (refresh)
      nock(BASE_URL).post('/api/v1/auth/getToken/').reply(200, { token: 't-new' });
      // Retry manifest with new token → 200
      nock(BASE_URL)
        .post('/api/v1/services/manifest/')
        .matchHeader('authorization', 'Bearer t-new')
        .reply(200, { data: { awb: 'A9', courier_order_id: 'C9', status: 'MANIFESTED' } });

      const a = newAdapter();
      const res = await a.createShipment(makeOrderRequest({ courierName: 'Urbanebolt' }));
      expect(res.trackingNumber).toBe('A9');
    });

    it('throws AuthenticationError if 401 persists after refresh', async () => {
      nock(BASE_URL).post('/api/v1/auth/getToken/').reply(200, { token: 't1' });
      nock(BASE_URL).post('/api/v1/services/manifest/').reply(401, {});
      nock(BASE_URL).post('/api/v1/auth/getToken/').reply(200, { token: 't2' });
      nock(BASE_URL).post('/api/v1/services/manifest/').reply(401, {});

      const a = newAdapter();
      await expect(
        a.createShipment(makeOrderRequest({ courierName: 'Urbanebolt' })),
      ).rejects.toBeInstanceOf(AuthenticationError);
    });

    it('retries 5xx and eventually succeeds (adapter-level retry)', async () => {
      nock(BASE_URL).post('/api/v1/auth/getToken/').reply(200, { token: 'tok' });
      nock(BASE_URL).post('/api/v1/services/manifest/').reply(503, {});
      nock(BASE_URL).post('/api/v1/services/manifest/').reply(503, {});
      nock(BASE_URL)
        .post('/api/v1/services/manifest/')
        .reply(200, { data: { awb: 'AA', courier_order_id: 'BB', status: 'MANIFESTED' } });

      const a = newAdapter();
      const res = await a.createShipment(makeOrderRequest({ courierName: 'Urbanebolt' }));
      expect(res.trackingNumber).toBe('AA');
    });

    it('surfaces CourierAPIError on 4xx (non-401)', async () => {
      nock(BASE_URL).post('/api/v1/auth/getToken/').reply(200, { token: 'tok' });
      nock(BASE_URL)
        .post('/api/v1/services/manifest/')
        .reply(400, { error: 'bad payload' });

      const a = newAdapter();
      await expect(
        a.createShipment(makeOrderRequest({ courierName: 'Urbanebolt' })),
      ).rejects.toBeInstanceOf(CourierAPIError);
    });
  });

  describe('trackShipment', () => {
    it('normalizes events to canonical statuses', async () => {
      nock(BASE_URL).post('/api/v1/auth/getToken/').reply(200, { token: 't' });
      nock(BASE_URL)
        .get('/api/v1/services/tracking/?awbs=T1')
        .reply(200, {
          data: {
            current_status: 'OUT_FOR_DELIVERY',
            events: [
              { status: 'MANIFESTED', description: 'created', event_time: '2026-01-01T00:00:00Z' },
              { status: 'PICKED_UP', event_time: '2026-01-01T01:00:00Z', location: 'HubA' },
              { status: 'OUT_FOR_DELIVERY', event_time: '2026-01-01T02:00:00Z' },
            ],
          },
        });

      const a = newAdapter();
      const r = await a.trackShipment('T1');
      expect(r.currentStatus).toBe(ShipmentStatus.IN_TRANSIT); // OFD -> IN_TRANSIT
      expect(r.events).toHaveLength(3);
      expect(r.events[0].status).toBe(ShipmentStatus.CREATED);
      expect(r.events[1].status).toBe(ShipmentStatus.PICKED_UP);
    });
  });

  describe('cancelShipment', () => {
    it('returns cancelled=true when API succeeds', async () => {
      nock(BASE_URL).post('/api/v1/auth/getToken/').reply(200, { token: 't' });
      nock(BASE_URL)
        .post('/api/v1/services/cancellation/')
        .reply(200, { status: 'SUCCESS' });

      const a = newAdapter();
      const r = await a.cancelShipment({ courierOrderId: 'ORD-1', trackingNumber: 'A1' });
      expect(r.cancelled).toBe(true);
    });
  });
});

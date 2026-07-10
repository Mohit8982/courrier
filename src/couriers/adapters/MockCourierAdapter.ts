import { randomUUID, createHash } from 'crypto';
import { ShipmentStatus } from '@prisma/client';
import { HttpClient } from '../../utils/httpClient';
import { BaseCourierAdapter } from './BaseCourierAdapter';
import {
  CancelShipmentInput,
  CancelShipmentResult,
  CreateShipmentInput,
  CreateShipmentResult,
  TrackingEvent,
  TrackingResult,
} from '../interfaces/ICourierAdapter';
import { mapMockStatus } from '../statusMaps/mockStatusMap';
import { env } from '../../config/env';
import { CourierAPIError } from '../../errors/AppError';

/**
 * MockCourierAdapter — deterministic, network-free adapter used for
 * local development and as a fallback. Behavior is fully derived from
 * the input orderId so tests can predict outputs.
 *
 * Also *supports* HTTP calls when a `MOCK_COURIER_BASE_URL` is
 * reachable — this is what integration tests use with `nock`.
 * If HTTP calls fail (e.g. no network), we fall back to deterministic
 * local generation so local dev works out-of-the-box.
 */
export class MockCourierAdapter extends BaseCourierAdapter {
  public readonly courierName = 'MockCourier';

  constructor(http?: HttpClient) {
    super(
      http ??
        new HttpClient({
          baseURL: env.MOCK_COURIER_BASE_URL,
          defaultHeaders: { 'X-Api-Key': env.MOCK_COURIER_API_KEY },
        }),
    );
  }

  protected async authenticate(): Promise<string> {
    // API-key based; no exchange required.
    return env.MOCK_COURIER_API_KEY;
  }

  async createShipment(input: CreateShipmentInput): Promise<CreateShipmentResult> {
    try {
      const res = await this.executeAuthed<{
        awb: string;
        courier_order_id: string;
        status: string;
      }>('createShipment', (token) =>
        this.http.post('/shipments', { order: input }, { headers: { 'X-Api-Key': token } }),
      );

      if (res.status >= 200 && res.status < 300 && res.data) {
        return {
          courierOrderId: res.data.courier_order_id,
          trackingNumber: res.data.awb,
          status: mapMockStatus(res.data.status),
          rawResponse: res.data,
        };
      }
      if (res.status >= 400 && res.status !== 401) {
        throw new CourierAPIError(
          this.courierName,
          `createShipment failed (${res.status})`,
          res.status,
          res.data,
        );
      }
      // network stub failure -> deterministic fallback below
    } catch (err) {
      // Only surface true upstream HTTP errors; fall back for network failures.
      if (err instanceof CourierAPIError && err.upstreamStatus !== undefined) throw err;
    }

    // Deterministic fallback for offline/local dev
    return this.deterministicCreate(input);
  }

  async trackShipment(trackingNumber: string, _courierOrderId?: string): Promise<TrackingResult> {
    try {
      const res = await this.executeAuthed<{
        current_status: string;
        events: Array<{ status: string; description?: string; location?: string; event_time: string }>;
      }>('trackShipment', (token) =>
        this.http.get(`/shipments/${trackingNumber}/track`, {
          headers: { 'X-Api-Key': token },
        }),
      );

      if (res.status >= 200 && res.status < 300 && res.data) {
        const events: TrackingEvent[] = (res.data.events ?? []).map((e) => ({
          status: mapMockStatus(e.status),
          description: e.description ?? null,
          location: e.location ?? null,
          eventTime: new Date(e.event_time),
        }));
        return {
          currentStatus: mapMockStatus(res.data.current_status),
          events,
          rawResponse: res.data,
        };
      }
      if (res.status >= 400 && res.status !== 401) {
        throw new CourierAPIError(
          this.courierName,
          `trackShipment failed (${res.status})`,
          res.status,
          res.data,
        );
      }
    } catch (err) {
      if (err instanceof CourierAPIError && err.upstreamStatus !== undefined) throw err;
    }

    return this.deterministicTrack(trackingNumber);
  }

  async cancelShipment(input: CancelShipmentInput): Promise<CancelShipmentResult> {
    try {
      const res = await this.executeAuthed<{ cancelled: boolean }>('cancelShipment', (token) =>
        this.http.post(
          `/shipments/${input.courierOrderId}/cancel`,
          { reason: input.reason ?? 'user_requested' },
          { headers: { 'X-Api-Key': token } },
        ),
      );

      if (res.status >= 200 && res.status < 300 && res.data) {
        return {
          cancelled: !!res.data.cancelled,
          cancelledAt: new Date(),
          rawResponse: res.data,
        };
      }
      if (res.status >= 400 && res.status !== 401) {
        throw new CourierAPIError(
          this.courierName,
          `cancelShipment failed (${res.status})`,
          res.status,
          res.data,
        );
      }
    } catch (err) {
      if (err instanceof CourierAPIError && err.upstreamStatus !== undefined) throw err;
    }

    return {
      cancelled: true,
      cancelledAt: new Date(),
      rawResponse: { mocked: true, courierOrderId: input.courierOrderId },
    };
  }

  // ---- deterministic helpers ----

  private deterministicCreate(input: CreateShipmentInput): CreateShipmentResult {
    const hash = createHash('sha1').update(input.orderId).digest('hex').slice(0, 10).toUpperCase();
    return {
      courierOrderId: `MOCK-${hash}`,
      trackingNumber: `MCT${hash}`,
      status: ShipmentStatus.CREATED,
      rawResponse: { mocked: true, orderId: input.orderId, generatedAt: new Date().toISOString() },
    };
  }

  private deterministicTrack(trackingNumber: string): TrackingResult {
    const now = Date.now();
    const events: TrackingEvent[] = [
      {
        status: ShipmentStatus.CREATED,
        description: 'Shipment created (mock)',
        location: 'Origin Hub',
        eventTime: new Date(now - 3 * 3600_000),
      },
      {
        status: ShipmentStatus.PICKED_UP,
        description: 'Picked up by rider (mock)',
        location: 'Origin Hub',
        eventTime: new Date(now - 2 * 3600_000),
      },
      {
        status: ShipmentStatus.IN_TRANSIT,
        description: 'In transit (mock)',
        location: 'Sorting Facility',
        eventTime: new Date(now - 3600_000),
      },
    ];
    return {
      currentStatus: ShipmentStatus.IN_TRANSIT,
      events,
      rawResponse: { mocked: true, trackingNumber, requestId: randomUUID() },
    };
  }
}

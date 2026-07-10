import { ShipmentStatus } from '@prisma/client';
import { HttpClient } from '../../utils/httpClient';
import { BaseCourierAdapter } from './BaseCourierAdapter';
import { env } from '../../config/env';
import { AuthenticationError, CourierAPIError } from '../../errors/AppError';
import { mapUrbaneboltStatus } from '../statusMaps/urbaneboltStatusMap';
import {
  CancelShipmentInput,
  CancelShipmentResult,
  CreateShipmentInput,
  CreateShipmentResult,
  TrackingEvent,
  TrackingResult,
} from '../interfaces/ICourierAdapter';

interface UrbaneboltTokenResponse {
  token?: string;
  access_token?: string;
  data?: { token?: string; access_token?: string };
}

interface UrbaneboltManifestResponse {
  status?: string;
  awb?: string;
  awb_number?: string;
  courier_order_id?: string;
  order_id?: string;
  message?: string;
  data?: {
    awb?: string;
    awb_number?: string;
    order_id?: string;
    courier_order_id?: string;
    status?: string;
  };
}

interface UrbaneboltTrackEvent {
  status?: string;
  status_description?: string;
  description?: string;
  location?: string;
  event_time?: string;
  timestamp?: string;
}

interface UrbaneboltTrackResponse {
  awb?: string;
  current_status?: string;
  status?: string;
  events?: UrbaneboltTrackEvent[];
  data?: {
    current_status?: string;
    status?: string;
    events?: UrbaneboltTrackEvent[];
  };
}

interface UrbaneboltCancelResponse {
  status?: string;
  message?: string;
  cancelled?: boolean;
}

/**
 * UrbaneboltAdapter — talks to the UrbaneBolt Customer API.
 *
 * Docs: https://documenter.getpostman.com/view/19172174/2sAYHzFhxb
 *   POST /api/v1/auth/getToken/     -> obtain bearer token
 *   POST /api/v1/services/manifest/ -> create shipment (manifest)
 *   GET  /api/v1/services/tracking/?awbs=<awb> -> track
 *   POST /api/v1/services/cancellation/ -> cancel
 */
export class UrbaneboltAdapter extends BaseCourierAdapter {
  public readonly courierName = 'Urbanebolt';

  constructor(http?: HttpClient) {
    super(
      http ??
        new HttpClient({
          baseURL: env.URBANEBOLT_BASE_URL,
        }),
    );
  }

  protected async authenticate(): Promise<string> {
    if (!env.URBANEBOLT_USERNAME || !env.URBANEBOLT_PASSWORD) {
      throw new AuthenticationError(
        this.courierName,
        'URBANEBOLT_USERNAME/URBANEBOLT_PASSWORD not configured',
      );
    }
    const res = await this.http.post<UrbaneboltTokenResponse>(
      '/api/v1/auth/getToken/',
      {
        username: env.URBANEBOLT_USERNAME,
        password: env.URBANEBOLT_PASSWORD,
      },
    );

    if (res.status < 200 || res.status >= 300) {
      throw new AuthenticationError(
        this.courierName,
        `getToken failed with status ${res.status}`,
      );
    }

    const body = res.data ?? {};
    const token =
      body.token ??
      body.access_token ??
      body.data?.token ??
      body.data?.access_token;

    if (!token) {
      throw new AuthenticationError(this.courierName, 'Auth response missing token');
    }
    return token;
  }

  async createShipment(input: CreateShipmentInput): Promise<CreateShipmentResult> {
    const payload = this.buildManifestPayload(input);
    const res = await this.executeAuthed<UrbaneboltManifestResponse>(
      'createShipment',
      (token) =>
        this.http.post('/api/v1/services/manifest/', payload, {
          headers: { Authorization: `Bearer ${token}` },
        }),
    );

    const body = this.ensureOk(res, 'createShipment');
    const inner = body.data ?? body;
    const awb = inner.awb ?? inner.awb_number;
    const courierOrderId = inner.courier_order_id ?? inner.order_id ?? awb;

    if (!awb || !courierOrderId) {
      throw new CourierAPIError(
        this.courierName,
        `createShipment: missing awb/order_id in response`,
        res.status,
        body,
      );
    }

    return {
      courierOrderId: String(courierOrderId),
      trackingNumber: String(awb),
      status: mapUrbaneboltStatus(inner.status),
      rawResponse: body,
    };
  }

  async trackShipment(trackingNumber: string, _courierOrderId?: string): Promise<TrackingResult> {
    const res = await this.executeAuthed<UrbaneboltTrackResponse>('trackShipment', (token) =>
      this.http.get(`/api/v1/services/tracking/?awbs=${encodeURIComponent(trackingNumber)}`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
    );

    const body = this.ensureOk(res, 'trackShipment');
    const inner = body.data ?? body;
    const events: TrackingEvent[] = (inner.events ?? []).map((e) => ({
      status: mapUrbaneboltStatus(e.status),
      description: e.status_description ?? e.description ?? null,
      location: e.location ?? null,
      eventTime: new Date(e.event_time ?? e.timestamp ?? Date.now()),
      metadata: { rawStatus: e.status },
    }));

    const currentNative = inner.current_status ?? inner.status;
    const currentStatus: ShipmentStatus =
      events.length > 0 && !currentNative
        ? events[events.length - 1].status
        : mapUrbaneboltStatus(currentNative);

    return {
      currentStatus,
      events,
      rawResponse: body,
    };
  }

  async cancelShipment(input: CancelShipmentInput): Promise<CancelShipmentResult> {
    const res = await this.executeAuthed<UrbaneboltCancelResponse>('cancelShipment', (token) =>
      this.http.post(
        '/api/v1/services/cancellation/',
        {
          awb: input.trackingNumber ?? input.courierOrderId,
          order_id: input.courierOrderId,
          reason: input.reason ?? 'CUSTOMER_REQUEST',
        },
        { headers: { Authorization: `Bearer ${token}` } },
      ),
    );

    const body = this.ensureOk(res, 'cancelShipment');
    const cancelled =
      body.cancelled === true ||
      String(body.status ?? '').toUpperCase() === 'SUCCESS' ||
      String(body.status ?? '').toUpperCase() === 'CANCELLED';

    return {
      cancelled,
      cancelledAt: new Date(),
      rawResponse: body,
    };
  }

  private buildManifestPayload(input: CreateShipmentInput): Record<string, unknown> {
    return {
      order_id: input.orderId,
      product_type: input.productType ?? 'FORWARD',
      payment_mode: input.payment.mode,
      cod_amount: input.payment.codAmount ?? 0,
      pickup: {
        name: input.pickup.name,
        phone: input.pickup.phone,
        email: input.pickup.email,
        address1: input.pickup.addressLine1,
        address2: input.pickup.addressLine2,
        city: input.pickup.city,
        state: input.pickup.state,
        pincode: input.pickup.pincode,
        country: input.pickup.country,
      },
      delivery: {
        name: input.delivery.name,
        phone: input.delivery.phone,
        email: input.delivery.email,
        address1: input.delivery.addressLine1,
        address2: input.delivery.addressLine2,
        city: input.delivery.city,
        state: input.delivery.state,
        pincode: input.delivery.pincode,
        country: input.delivery.country,
      },
      package: {
        weight: input.package.weightGrams,
        length: input.package.lengthCm,
        breadth: input.package.widthCm,
        height: input.package.heightCm,
        declared_value: input.package.declaredValue,
        currency: input.package.currency ?? 'INR',
        description: input.package.description,
      },
      metadata: input.metadata ?? {},
    };
  }
}

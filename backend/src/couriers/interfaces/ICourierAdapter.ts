import { ShipmentStatus } from '@prisma/client';

export interface Address {
  name: string;
  phone: string;
  email?: string;
  addressLine1: string;
  addressLine2?: string;
  city: string;
  state: string;
  pincode: string;
  country: string;
}

export interface PackageDetails {
  weightGrams: number;
  lengthCm: number;
  widthCm: number;
  heightCm: number;
  declaredValue: number;
  currency?: string;
  description?: string;
}

export interface PaymentInfo {
  mode: 'PREPAID' | 'COD';
  codAmount?: number;
}

export interface CreateShipmentInput {
  orderId: string;
  pickup: Address;
  delivery: Address;
  package: PackageDetails;
  payment: PaymentInfo;
  productType?: 'FORWARD' | 'REVERSE';
  metadata?: Record<string, unknown>;
}

export interface CreateShipmentResult {
  courierOrderId: string;
  trackingNumber: string;
  status: ShipmentStatus;
  rawResponse: unknown;
}

export interface TrackingEvent {
  status: ShipmentStatus;
  description: string | null;
  location: string | null;
  eventTime: Date;
  metadata?: Record<string, unknown>;
}

export interface TrackingResult {
  currentStatus: ShipmentStatus;
  events: TrackingEvent[];
  rawResponse: unknown;
}

export interface CancelShipmentInput {
  courierOrderId: string;
  trackingNumber?: string | null;
  reason?: string;
}

export interface CancelShipmentResult {
  cancelled: boolean;
  cancelledAt: Date;
  rawResponse: unknown;
}

/**
 * Every courier integration MUST implement this interface.
 * Adapter is the ONLY layer that knows about a specific courier API.
 */
export interface ICourierAdapter {
  readonly courierName: string;

  createShipment(input: CreateShipmentInput): Promise<CreateShipmentResult>;
  trackShipment(trackingNumber: string, courierOrderId?: string): Promise<TrackingResult>;
  cancelShipment(input: CancelShipmentInput): Promise<CancelShipmentResult>;
}

import { ShipmentStatus } from '@prisma/client';

/**
 * Urbanebolt native status → canonical enum mapping.
 * Uses conservative defaults; unknown values fall back to IN_TRANSIT.
 */
const URBANEBOLT_MAP: Record<string, ShipmentStatus> = {
  MANIFESTED: ShipmentStatus.CREATED,
  BOOKED: ShipmentStatus.CREATED,
  PICKUP_SCHEDULED: ShipmentStatus.CREATED,
  PICKED_UP: ShipmentStatus.PICKED_UP,
  PICKUP: ShipmentStatus.PICKED_UP,
  IN_TRANSIT: ShipmentStatus.IN_TRANSIT,
  OUT_FOR_DELIVERY: ShipmentStatus.IN_TRANSIT,
  OFD: ShipmentStatus.IN_TRANSIT,
  DELIVERED: ShipmentStatus.DELIVERED,
  CANCELLED: ShipmentStatus.CANCELLED,
  CANCELED: ShipmentStatus.CANCELLED,
  RTO_INITIATED: ShipmentStatus.FAILED,
  RTO_DELIVERED: ShipmentStatus.FAILED,
  LOST: ShipmentStatus.FAILED,
  UNDELIVERED: ShipmentStatus.FAILED,
  FAILED: ShipmentStatus.FAILED,
};

export function mapUrbaneboltStatus(native: string | undefined | null): ShipmentStatus {
  if (!native) return ShipmentStatus.IN_TRANSIT;
  const upper = String(native).toUpperCase().replace(/\s+/g, '_');
  return URBANEBOLT_MAP[upper] ?? ShipmentStatus.IN_TRANSIT;
}

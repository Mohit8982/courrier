import { ShipmentStatus } from '@prisma/client';

const MOCK_MAP: Record<string, ShipmentStatus> = {
  CREATED: ShipmentStatus.CREATED,
  PICKED_UP: ShipmentStatus.PICKED_UP,
  IN_TRANSIT: ShipmentStatus.IN_TRANSIT,
  DELIVERED: ShipmentStatus.DELIVERED,
  CANCELLED: ShipmentStatus.CANCELLED,
  FAILED: ShipmentStatus.FAILED,
};

export function mapMockStatus(native: string | undefined | null): ShipmentStatus {
  if (!native) return ShipmentStatus.CREATED;
  const upper = String(native).toUpperCase();
  return MOCK_MAP[upper] ?? ShipmentStatus.IN_TRANSIT;
}

import { ShipmentStatus } from '@prisma/client';

export { ShipmentStatus };

export const TERMINAL_STATUSES: ReadonlySet<ShipmentStatus> = new Set([
  ShipmentStatus.DELIVERED,
  ShipmentStatus.CANCELLED,
  ShipmentStatus.FAILED,
]);

export function isTerminalStatus(status: ShipmentStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export function canCancel(status: ShipmentStatus): boolean {
  return !isTerminalStatus(status) && status !== ShipmentStatus.IN_TRANSIT;
}

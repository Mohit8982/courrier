import { mapUrbaneboltStatus } from '../../src/couriers/statusMaps/urbaneboltStatusMap';
import { mapMockStatus } from '../../src/couriers/statusMaps/mockStatusMap';
import { canCancel, isTerminalStatus } from '../../src/utils/statusEnum';
import { ShipmentStatus } from '@prisma/client';

describe('status maps', () => {
  it('urbanebolt: MANIFESTED -> CREATED', () => {
    expect(mapUrbaneboltStatus('MANIFESTED')).toBe(ShipmentStatus.CREATED);
  });
  it('urbanebolt: OUT_FOR_DELIVERY -> IN_TRANSIT', () => {
    expect(mapUrbaneboltStatus('OUT_FOR_DELIVERY')).toBe(ShipmentStatus.IN_TRANSIT);
  });
  it('urbanebolt: DELIVERED -> DELIVERED', () => {
    expect(mapUrbaneboltStatus('DELIVERED')).toBe(ShipmentStatus.DELIVERED);
  });
  it('urbanebolt: RTO_INITIATED -> FAILED', () => {
    expect(mapUrbaneboltStatus('RTO_INITIATED')).toBe(ShipmentStatus.FAILED);
  });
  it('urbanebolt: unknown falls back to IN_TRANSIT', () => {
    expect(mapUrbaneboltStatus('WEIRD')).toBe(ShipmentStatus.IN_TRANSIT);
  });
  it('urbanebolt: null defaults', () => {
    expect(mapUrbaneboltStatus(null)).toBe(ShipmentStatus.IN_TRANSIT);
  });

  it('mock: passthrough of canonical values', () => {
    expect(mapMockStatus('DELIVERED')).toBe(ShipmentStatus.DELIVERED);
    expect(mapMockStatus('picked_up')).toBe(ShipmentStatus.PICKED_UP);
  });
});

describe('status utils', () => {
  it('isTerminalStatus true for DELIVERED/CANCELLED/FAILED', () => {
    expect(isTerminalStatus(ShipmentStatus.DELIVERED)).toBe(true);
    expect(isTerminalStatus(ShipmentStatus.CANCELLED)).toBe(true);
    expect(isTerminalStatus(ShipmentStatus.FAILED)).toBe(true);
  });
  it('isTerminalStatus false for non-terminal', () => {
    expect(isTerminalStatus(ShipmentStatus.CREATED)).toBe(false);
    expect(isTerminalStatus(ShipmentStatus.PICKED_UP)).toBe(false);
  });
  it('canCancel: allowed for CREATED/PICKED_UP', () => {
    expect(canCancel(ShipmentStatus.CREATED)).toBe(true);
    expect(canCancel(ShipmentStatus.PICKED_UP)).toBe(true);
  });
  it('canCancel: false for IN_TRANSIT/DELIVERED/CANCELLED/FAILED', () => {
    expect(canCancel(ShipmentStatus.IN_TRANSIT)).toBe(false);
    expect(canCancel(ShipmentStatus.DELIVERED)).toBe(false);
    expect(canCancel(ShipmentStatus.CANCELLED)).toBe(false);
    expect(canCancel(ShipmentStatus.FAILED)).toBe(false);
  });
});

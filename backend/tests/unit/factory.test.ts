import { CourierFactory } from '../../src/couriers/factory/CourierFactory';
import { UnsupportedCourierError } from '../../src/errors/AppError';
import { UrbaneboltAdapter } from '../../src/couriers/adapters/UrbaneboltAdapter';
import { MockCourierAdapter } from '../../src/couriers/adapters/MockCourierAdapter';

describe('CourierFactory (Adapter + Factory patterns)', () => {
  afterEach(() => {
    CourierFactory._resetAll(); // re-registers built-ins
  });

  it('resolves built-in Urbanebolt adapter', () => {
    const a = CourierFactory.create('Urbanebolt');
    expect(a).toBeInstanceOf(UrbaneboltAdapter);
    expect(a.courierName).toBe('Urbanebolt');
  });

  it('resolves built-in MockCourier adapter (case-insensitive)', () => {
    const a = CourierFactory.create('mockcourier');
    expect(a).toBeInstanceOf(MockCourierAdapter);
  });

  it('caches instances (same reference for same name)', () => {
    const a = CourierFactory.create('MockCourier');
    const b = CourierFactory.create('MockCourier');
    expect(a).toBe(b);
  });

  it('resetInstances clears the cache but keeps registry', () => {
    const a1 = CourierFactory.create('MockCourier');
    CourierFactory.resetInstances();
    const a2 = CourierFactory.create('MockCourier');
    expect(a1).not.toBe(a2);
  });

  it('throws UnsupportedCourierError for unknown names', () => {
    expect(() => CourierFactory.create('NoSuch')).toThrow(UnsupportedCourierError);
  });

  it('OCP: registering a new adapter is the only change needed', () => {
    class FakeAdapter {
      public readonly courierName: string = 'FakeCo';
      createShipment = jest.fn();
      trackShipment = jest.fn();
      cancelShipment = jest.fn();
    }
    CourierFactory.register('FakeCo', FakeAdapter as any);
    const a = CourierFactory.create('FakeCo');
    expect(a).toBeInstanceOf(FakeAdapter);
    expect(a.courierName).toBe('FakeCo');
    expect(CourierFactory.list()).toContain('fakeco');
  });
});

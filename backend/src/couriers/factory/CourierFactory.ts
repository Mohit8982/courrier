import { ICourierAdapter } from '../interfaces/ICourierAdapter';
import { UnsupportedCourierError } from '../../errors/AppError';
import { UrbaneboltAdapter } from '../adapters/UrbaneboltAdapter';
import { MockCourierAdapter } from '../adapters/MockCourierAdapter';

type AdapterCtor = new () => ICourierAdapter;

/**
 * Registry-based CourierFactory.
 *
 * Adding a new courier is exactly two steps:
 *   1. Create a new adapter class extending BaseCourierAdapter.
 *   2. Register it via `CourierFactory.register('MyCourier', MyCourierAdapter)`
 *      (done here in this file — nothing else changes).
 *
 * This is the OCP boundary: services never touch adapters directly.
 */
export class CourierFactory {
  private static registry: Map<string, AdapterCtor> = new Map();
  private static instances: Map<string, ICourierAdapter> = new Map();

  /** Register (or override) an adapter class for a courier name (case-insensitive). */
  static register(name: string, ctor: AdapterCtor): void {
    this.registry.set(this.norm(name), ctor);
  }

  /** Resolve an adapter INSTANCE for the given courier name. Cached per-name. */
  static create(name: string): ICourierAdapter {
    const key = this.norm(name);
    const cached = this.instances.get(key);
    if (cached) return cached;

    const Ctor = this.registry.get(key);
    if (!Ctor) throw new UnsupportedCourierError(name);

    const instance = new Ctor();
    this.instances.set(key, instance);
    return instance;
  }

  /** List all registered courier names (in the case they were registered with). */
  static list(): string[] {
    return Array.from(this.registry.keys());
  }

  /** For tests: clear cached instances (registry stays). */
  static resetInstances(): void {
    this.instances.clear();
  }

  /** For tests: fully reset both registry and instances. */
  static _resetAll(): void {
    this.registry.clear();
    this.instances.clear();
    registerBuiltIns();
  }

  private static norm(name: string): string {
    return name.trim().toLowerCase();
  }
}

// ---- Built-in registrations ----
function registerBuiltIns(): void {
  CourierFactory.register('Urbanebolt', UrbaneboltAdapter);
  CourierFactory.register('MockCourier', MockCourierAdapter);
}

registerBuiltIns();

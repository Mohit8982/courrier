import { CreateOrderRequest } from '../../src/validators/order.validator';

export function makeOrderRequest(overrides: Partial<CreateOrderRequest> = {}): CreateOrderRequest {
  return {
    orderId: 'ORD-' + Math.random().toString(36).slice(2, 10),
    courierName: 'MockCourier',
    pickup: {
      name: 'Alice',
      phone: '9999999999',
      addressLine1: '1 Main St',
      city: 'Bangalore',
      state: 'KA',
      pincode: '560001',
      country: 'IN',
    },
    delivery: {
      name: 'Bob',
      phone: '8888888888',
      addressLine1: '2 Park Ave',
      city: 'Mumbai',
      state: 'MH',
      pincode: '400001',
      country: 'IN',
    },
    package: {
      weightGrams: 500,
      lengthCm: 10,
      widthCm: 10,
      heightCm: 10,
      declaredValue: 1500,
    },
    payment: { mode: 'PREPAID' },
    ...overrides,
  };
}

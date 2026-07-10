import {
  AppError,
  AuthenticationError,
  CourierAPIError,
  NotFoundError,
  UnsupportedCourierError,
  ValidationError,
  InvalidStateError,
  ConflictError,
} from '../../src/errors/AppError';

describe('AppError hierarchy', () => {
  it('AppError serializes to JSON envelope', () => {
    const e = new AppError('boom', 500, 'X', { a: 1 });
    expect(e.toJSON()).toEqual({ error: { code: 'X', message: 'boom', details: { a: 1 } } });
  });

  it('ValidationError has 400 status and correct code', () => {
    const e = new ValidationError('bad');
    expect(e.statusCode).toBe(400);
    expect(e.code).toBe('VALIDATION_ERROR');
  });

  it('NotFoundError formats message with id', () => {
    const e = new NotFoundError('Order', 'ABC');
    expect(e.message).toContain('Order');
    expect(e.message).toContain('ABC');
    expect(e.statusCode).toBe(404);
  });

  it('CourierAPIError includes upstream metadata', () => {
    const e = new CourierAPIError('Urbanebolt', 'fail', 500, { x: 1 });
    expect(e.statusCode).toBe(502);
    expect(e.courierPartner).toBe('Urbanebolt');
    expect(e.upstreamStatus).toBe(500);
    expect(e.upstreamBody).toEqual({ x: 1 });
  });

  it('AuthenticationError defaults', () => {
    const e = new AuthenticationError('X');
    expect(e.statusCode).toBe(401);
  });

  it('UnsupportedCourierError uses 400', () => {
    const e = new UnsupportedCourierError('Foo');
    expect(e.statusCode).toBe(400);
    expect(e.code).toBe('UNSUPPORTED_COURIER');
  });

  it('InvalidStateError uses 409', () => {
    expect(new InvalidStateError('x').statusCode).toBe(409);
  });

  it('ConflictError uses 409', () => {
    expect(new ConflictError().statusCode).toBe(409);
  });
});

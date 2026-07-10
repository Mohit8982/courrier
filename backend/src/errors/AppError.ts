/**
 * Base application error. All custom errors extend this.
 */
export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly details?: unknown;
  public readonly isOperational: boolean;

  constructor(
    message: string,
    statusCode = 500,
    code = 'INTERNAL_ERROR',
    details?: unknown,
    isOperational = true,
  ) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.isOperational = isOperational;
    Error.captureStackTrace?.(this, this.constructor);
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        details: this.details,
      },
    };
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Validation failed', details?: unknown) {
    super(message, 400, 'VALIDATION_ERROR', details);
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string, id?: string | number) {
    super(
      `${resource}${id !== undefined ? ` with id '${id}'` : ''} not found`,
      404,
      'NOT_FOUND',
    );
  }
}

export class ConflictError extends AppError {
  constructor(message = 'Resource conflict', details?: unknown) {
    super(message, 409, 'CONFLICT', details);
  }
}

export class CourierAPIError extends AppError {
  public readonly courierPartner: string;
  public readonly upstreamStatus?: number;
  public readonly upstreamBody?: unknown;

  constructor(
    courierPartner: string,
    message: string,
    upstreamStatus?: number,
    upstreamBody?: unknown,
  ) {
    super(
      `[${courierPartner}] ${message}`,
      502,
      'COURIER_API_ERROR',
      { courierPartner, upstreamStatus, upstreamBody },
    );
    this.courierPartner = courierPartner;
    this.upstreamStatus = upstreamStatus;
    this.upstreamBody = upstreamBody;
  }
}

export class AuthenticationError extends AppError {
  public readonly courierPartner: string;

  constructor(courierPartner: string, message = 'Courier authentication failed') {
    super(`[${courierPartner}] ${message}`, 401, 'AUTHENTICATION_ERROR', {
      courierPartner,
    });
    this.courierPartner = courierPartner;
  }
}

export class UnsupportedCourierError extends AppError {
  constructor(courierName: string) {
    super(
      `Unsupported courier partner: '${courierName}'`,
      400,
      'UNSUPPORTED_COURIER',
      { courierName },
    );
  }
}

export class InvalidStateError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, 409, 'INVALID_STATE', details);
  }
}

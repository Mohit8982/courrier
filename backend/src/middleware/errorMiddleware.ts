import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { AppError, ValidationError } from '../errors/AppError';
import { logger } from '../config/logger';

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorMiddleware(
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  // Zod validation error → ValidationError shape
  if (err instanceof ZodError) {
    const validation = new ValidationError('Request validation failed', err.flatten());
    logger.warn('Validation error', {
      requestId: req.requestId,
      path: req.originalUrl,
      details: validation.details,
    });
    res.status(validation.statusCode).json(validation.toJSON());
    return;
  }

  if (err instanceof AppError) {
    if (err.statusCode >= 500) {
      logger.error('Application error', {
        requestId: req.requestId,
        path: req.originalUrl,
        code: err.code,
        message: err.message,
        stack: err.stack,
      });
    } else {
      logger.warn('Application error', {
        requestId: req.requestId,
        path: req.originalUrl,
        code: err.code,
        message: err.message,
      });
    }
    res.status(err.statusCode).json(err.toJSON());
    return;
  }

  logger.error('Unhandled error', {
    requestId: req.requestId,
    path: req.originalUrl,
    message: err.message,
    stack: err.stack,
  });

  res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred',
    },
  });
}

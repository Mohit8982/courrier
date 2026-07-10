import { Request, Response, NextFunction } from 'express';
import { logger } from '../config/logger';

export function loggingMiddleware(req: Request, res: Response, next: NextFunction): void {
  const start = Date.now();

  res.on('finish', () => {
    const duration = Date.now() - start;
    const meta = {
      requestId: req.requestId,
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      durationMs: duration,
    };

    if (res.statusCode >= 500) {
      logger.error('HTTP request', meta);
    } else if (res.statusCode >= 400) {
      logger.warn('HTTP request', meta);
    } else {
      logger.info('HTTP request', meta);
    }
  });

  next();
}

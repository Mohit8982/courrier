import express, { Application } from 'express';
import { requestIdMiddleware } from './middleware/requestIdMiddleware';
import { loggingMiddleware } from './middleware/loggingMiddleware';
import { errorMiddleware } from './middleware/errorMiddleware';
import apiRoutes from './routes';

export function createApp(): Application {
  const app = express();

  app.use(express.json({ limit: '2mb' }));
  app.use(requestIdMiddleware);
  app.use(loggingMiddleware);

  // All routes mounted under /api (required by Emergent preview routing)
  app.use('/api', apiRoutes);

  // 404 fallback
  app.use((req, res) => {
    res.status(404).json({
      error: {
        code: 'NOT_FOUND',
        message: `Route ${req.method} ${req.originalUrl} not found`,
      },
    });
  });

  app.use(errorMiddleware);

  return app;
}

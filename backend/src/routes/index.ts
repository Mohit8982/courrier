import { Router } from 'express';
import orderRoutes from './order.routes';
import batchRoutes from './batch.routes';

const router = Router();

router.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok', service: 'multi-courier-platform' });
});

router.get('/', (_req, res) => {
  res.status(200).json({
    name: 'Multi-Courier Integration Platform',
    version: '1.0.0',
    endpoints: [
      'POST   /api/orders',
      'GET    /api/orders/:id',
      'GET    /api/orders/:id/track',
      'POST   /api/orders/:id/cancel',
      'POST   /api/orders/bulk',
      'GET    /api/batches/:batchId',
      'GET    /api/health',
    ],
  });
});

router.use('/orders', orderRoutes);
router.use('/batches', batchRoutes);

export default router;

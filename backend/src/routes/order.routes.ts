import { Router } from 'express';
import { OrderController } from '../controllers/order.controller';

const router = Router();
const controller = new OrderController();

router.post('/bulk', controller.bulkCreate);
router.post('/', controller.create);
router.get('/:id', controller.getById);
router.get('/:id/track', controller.track);
router.post('/:id/cancel', controller.cancel);

export default router;

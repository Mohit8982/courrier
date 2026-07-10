import { Router } from 'express';
import { BatchController } from '../controllers/batch.controller';

const router = Router();
const controller = new BatchController();

router.get('/:batchId', controller.getById);

export default router;

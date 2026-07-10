import { Request, Response, NextFunction } from 'express';
import { BatchJobService } from '../services/BatchJobService';

export class BatchController {
  constructor(private readonly batchService = new BatchJobService()) {}

  getById = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const batch = await this.batchService.getBatch(req.params.batchId);
      res.status(200).json({ data: batch });
    } catch (err) {
      next(err);
    }
  };
}

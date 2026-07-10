import { PrismaClient, BatchJob, Prisma, BatchStatus } from '@prisma/client';
import { prisma as defaultPrisma } from './prismaClient';

export class BatchRepository {
  private readonly prisma: PrismaClient;

  constructor(prismaClient: PrismaClient = defaultPrisma) {
    this.prisma = prismaClient;
  }

  create(data: Prisma.BatchJobCreateInput): Promise<BatchJob> {
    return this.prisma.batchJob.create({ data });
  }

  findByBatchId(batchId: string): Promise<BatchJob | null> {
    return this.prisma.batchJob.findUnique({ where: { batchId } });
  }

  update(batchId: string, data: Prisma.BatchJobUpdateInput): Promise<BatchJob> {
    return this.prisma.batchJob.update({ where: { batchId }, data });
  }

  updateStatus(batchId: string, status: BatchStatus): Promise<BatchJob> {
    return this.prisma.batchJob.update({ where: { batchId }, data: { status } });
  }

  incrementCounts(
    batchId: string,
    success: number,
    failed: number,
  ): Promise<BatchJob> {
    return this.prisma.batchJob.update({
      where: { batchId },
      data: {
        successCount: { increment: success },
        failedCount: { increment: failed },
      },
    });
  }
}

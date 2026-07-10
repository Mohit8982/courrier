import { PrismaClient, TrackingHistory, Prisma } from '@prisma/client';
import { prisma as defaultPrisma } from './prismaClient';

/**
 * Repository: append-only tracking events. DB only.
 */
export class TrackingRepository {
  private readonly prisma: PrismaClient;

  constructor(prismaClient: PrismaClient = defaultPrisma) {
    this.prisma = prismaClient;
  }

  append(data: Prisma.TrackingHistoryCreateInput): Promise<TrackingHistory> {
    return this.prisma.trackingHistory.create({ data });
  }

  appendMany(rows: Prisma.TrackingHistoryCreateManyInput[]) {
    if (!rows.length) return Promise.resolve({ count: 0 });
    return this.prisma.trackingHistory.createMany({ data: rows });
  }

  findByOrderId(orderId: number): Promise<TrackingHistory[]> {
    return this.prisma.trackingHistory.findMany({
      where: { orderId },
      orderBy: { eventTime: 'asc' },
    });
  }

  latestForOrder(orderId: number): Promise<TrackingHistory | null> {
    return this.prisma.trackingHistory.findFirst({
      where: { orderId },
      orderBy: { eventTime: 'desc' },
    });
  }
}

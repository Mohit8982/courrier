import { PrismaClient, Order, Prisma, ShipmentStatus } from '@prisma/client';
import { prisma as defaultPrisma } from './prismaClient';

/**
 * Repository: DB-only. NO business logic here.
 */
export class OrderRepository {
  private readonly prisma: PrismaClient;

  constructor(prismaClient: PrismaClient = defaultPrisma) {
    this.prisma = prismaClient;
  }

  findByOrderId(orderId: string): Promise<Order | null> {
    return this.prisma.order.findUnique({ where: { orderId } });
  }

  findById(id: number): Promise<Order | null> {
    return this.prisma.order.findUnique({ where: { id } });
  }

  findByOrderIdWithCourier(orderId: string) {
    return this.prisma.order.findUnique({
      where: { orderId },
      include: { courier: true, tracking: { orderBy: { eventTime: 'asc' } } },
    });
  }

  create(data: Prisma.OrderCreateInput): Promise<Order> {
    return this.prisma.order.create({ data });
  }

  update(id: number, data: Prisma.OrderUpdateInput): Promise<Order> {
    return this.prisma.order.update({ where: { id }, data });
  }

  updateStatus(id: number, status: ShipmentStatus): Promise<Order> {
    return this.prisma.order.update({ where: { id }, data: { status } });
  }

  findByBatchId(batchId: string): Promise<Order[]> {
    return this.prisma.order.findMany({ where: { batchId } });
  }
}

import { PrismaClient, Courier } from '@prisma/client';
import { prisma as defaultPrisma } from './prismaClient';

export class CourierRepository {
  private readonly prisma: PrismaClient;

  constructor(prismaClient: PrismaClient = defaultPrisma) {
    this.prisma = prismaClient;
  }

  findByName(name: string): Promise<Courier | null> {
    return this.prisma.courier.findUnique({ where: { name } });
  }

  listActive(): Promise<Courier[]> {
    return this.prisma.courier.findMany({ where: { isActive: true } });
  }
}

import { execSync } from 'child_process';
import { prisma } from '../../src/repositories/prismaClient';
import { AuthType } from '@prisma/client';

let migrated = false;

export async function resetDatabase(): Promise<void> {
  if (!migrated) {
    execSync('npx prisma migrate deploy', {
      stdio: 'ignore',
      env: { ...process.env },
    });
    migrated = true;
  }
  // Wipe app data (order matters for FK)
  await prisma.trackingHistory.deleteMany({});
  await prisma.order.deleteMany({});
  await prisma.batchJob.deleteMany({});
  await prisma.courier.deleteMany({});

  // Seed couriers
  await prisma.courier.create({
    data: {
      name: 'Urbanebolt',
      baseUrl: process.env.URBANEBOLT_BASE_URL!,
      authenticationType: AuthType.USERNAME_PASSWORD,
    },
  });
  await prisma.courier.create({
    data: {
      name: 'MockCourier',
      baseUrl: process.env.MOCK_COURIER_BASE_URL!,
      authenticationType: AuthType.API_KEY,
    },
  });
}

export async function disconnectAll(): Promise<void> {
  await prisma.$disconnect();
}

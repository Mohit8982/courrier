import { PrismaClient, AuthType } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding couriers...');

  await prisma.courier.upsert({
    where: { name: 'Urbanebolt' },
    update: {},
    create: {
      name: 'Urbanebolt',
      baseUrl: process.env.URBANEBOLT_BASE_URL || 'https://uat.urbanebolt.in',
      authenticationType: AuthType.USERNAME_PASSWORD,
      isActive: true,
    },
  });

  await prisma.courier.upsert({
    where: { name: 'MockCourier' },
    update: {},
    create: {
      name: 'MockCourier',
      baseUrl: process.env.MOCK_COURIER_BASE_URL || 'https://mock-courier.local',
      authenticationType: AuthType.API_KEY,
      isActive: true,
    },
  });

  console.log('Seed complete.');
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });

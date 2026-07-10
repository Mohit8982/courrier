-- CreateEnum
CREATE TYPE "ShipmentStatus" AS ENUM ('CREATED', 'PICKED_UP', 'IN_TRANSIT', 'DELIVERED', 'CANCELLED', 'FAILED');

-- CreateEnum
CREATE TYPE "BatchStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'PARTIAL', 'FAILED');

-- CreateEnum
CREATE TYPE "AuthType" AS ENUM ('API_KEY', 'BEARER_TOKEN', 'BASIC_AUTH', 'USERNAME_PASSWORD');

-- CreateTable
CREATE TABLE "couriers" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "authenticationType" "AuthType" NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "couriers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" SERIAL NOT NULL,
    "orderId" TEXT NOT NULL,
    "courierId" INTEGER NOT NULL,
    "courierOrderId" TEXT,
    "trackingNumber" TEXT,
    "status" "ShipmentStatus" NOT NULL DEFAULT 'CREATED',
    "requestPayload" JSONB NOT NULL,
    "responsePayload" JSONB,
    "batchId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tracking_history" (
    "id" SERIAL NOT NULL,
    "orderId" INTEGER NOT NULL,
    "status" "ShipmentStatus" NOT NULL,
    "description" TEXT,
    "location" TEXT,
    "eventTime" TIMESTAMP(3) NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tracking_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "batch_jobs" (
    "id" SERIAL NOT NULL,
    "batchId" TEXT NOT NULL,
    "totalOrders" INTEGER NOT NULL,
    "successCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "status" "BatchStatus" NOT NULL DEFAULT 'PENDING',
    "results" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "batch_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "couriers_name_key" ON "couriers"("name");

-- CreateIndex
CREATE UNIQUE INDEX "orders_orderId_key" ON "orders"("orderId");

-- CreateIndex
CREATE INDEX "orders_orderId_idx" ON "orders"("orderId");

-- CreateIndex
CREATE INDEX "orders_trackingNumber_idx" ON "orders"("trackingNumber");

-- CreateIndex
CREATE INDEX "orders_courierOrderId_idx" ON "orders"("courierOrderId");

-- CreateIndex
CREATE INDEX "orders_batchId_idx" ON "orders"("batchId");

-- CreateIndex
CREATE INDEX "orders_status_idx" ON "orders"("status");

-- CreateIndex
CREATE INDEX "tracking_history_orderId_idx" ON "tracking_history"("orderId");

-- CreateIndex
CREATE INDEX "tracking_history_eventTime_idx" ON "tracking_history"("eventTime");

-- CreateIndex
CREATE UNIQUE INDEX "batch_jobs_batchId_key" ON "batch_jobs"("batchId");

-- CreateIndex
CREATE INDEX "batch_jobs_batchId_idx" ON "batch_jobs"("batchId");

-- CreateIndex
CREATE INDEX "batch_jobs_status_idx" ON "batch_jobs"("status");

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_courierId_fkey" FOREIGN KEY ("courierId") REFERENCES "couriers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tracking_history" ADD CONSTRAINT "tracking_history_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

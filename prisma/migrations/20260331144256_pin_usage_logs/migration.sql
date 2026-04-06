-- AlterTable
ALTER TABLE "SchoolPin" ADD COLUMN     "pinType" TEXT NOT NULL DEFAULT 'RESULT_CHECKING';

-- AlterTable
ALTER TABLE "SchoolPinBatch" ADD COLUMN     "pinType" TEXT NOT NULL DEFAULT 'RESULT_CHECKING';

-- CreateTable
CREATE TABLE "PinUsageLog" (
    "id" TEXT NOT NULL,
    "pinId" TEXT NOT NULL,
    "usageContext" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "metadata" JSONB,
    "usedByIdentifier" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PinUsageLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PinUsageLog_pinId_idx" ON "PinUsageLog"("pinId");

-- AddForeignKey
ALTER TABLE "PinUsageLog" ADD CONSTRAINT "PinUsageLog_pinId_fkey" FOREIGN KEY ("pinId") REFERENCES "SchoolPin"("id") ON DELETE CASCADE ON UPDATE CASCADE;

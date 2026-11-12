ALTER TABLE "Order"
ADD COLUMN "idempotencyKey" TEXT;

CREATE UNIQUE INDEX "Order_idempotencyKey_key"
ON "Order"("idempotencyKey");

CREATE INDEX "Order_status_createdAt_idx"
ON "Order"("status", "createdAt");

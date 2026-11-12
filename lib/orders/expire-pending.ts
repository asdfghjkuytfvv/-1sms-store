import { db } from "@/lib/db";
import type { Prisma } from "@prisma/client";

export const ORDER_RESERVATION_MS = 30 * 60 * 1000;
export const ORDER_EXPIRY_BATCH_SIZE = 25;

type RestockLine = { productId: string; quantity: number };

function readRestockLines(value: unknown): RestockLine[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const lines: RestockLine[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return null;
    const line = item as Record<string, unknown>;
    if (typeof line.productId !== "string" || !line.productId || !Number.isSafeInteger(line.quantity) || Number(line.quantity) < 1) return null;
    lines.push({ productId: line.productId, quantity: Number(line.quantity) });
  }
  return lines;
}

export async function expirePendingOrderInTransaction(
  tx: Prisma.TransactionClient,
  candidate: { id: string; lines: unknown },
  cutoff: Date,
) {
  const lines = readRestockLines(candidate.lines);
  if (!lines) throw new Error("ORDER_LINES_INVALID");

  const claimed = await tx.order.updateMany({
    where: {
      id: candidate.id,
      status: "PENDING_WHATSAPP",
      createdAt: { lt: cutoff },
    },
    data: { status: "EXPIRED" },
  });
  if (claimed.count !== 1) return false;

  for (const line of lines) {
    await tx.product.update({
      where: { id: line.productId },
      data: { inventory: { increment: line.quantity } },
    });
  }
  return true;
}

export async function expirePendingOrders(now = new Date()) {
  const cutoff = new Date(now.getTime() - ORDER_RESERVATION_MS);
  const candidates = await db.order.findMany({
    where: { status: "PENDING_WHATSAPP", createdAt: { lt: cutoff } },
    orderBy: { createdAt: "asc" },
    take: ORDER_EXPIRY_BATCH_SIZE,
    select: { id: true, lines: true },
  });

  let expired = 0;
  let skipped = 0;
  let failed = 0;

  for (const candidate of candidates) {
    try {
      const didExpire = await db.$transaction((tx) => expirePendingOrderInTransaction(tx, candidate, cutoff));

      if (didExpire) expired += 1;
      else skipped += 1;
    } catch (error) {
      failed += 1;
      console.error("[order-expiry] Transaction failed; order remains retryable:", candidate.id, error);
    }
  }

  return {
    cutoff: cutoff.toISOString(),
    checked: candidates.length,
    expired,
    skipped,
    failed,
    hasMore: candidates.length === ORDER_EXPIRY_BATCH_SIZE,
  };
}

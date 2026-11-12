import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { enforceRateLimit, RATE_LIMIT_POLICIES } from "@/lib/security/rate-limit";
import { hasSameOrigin, readJsonBody } from "@/lib/http/request-body";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const orderSchema = z.object({
  customerName: z.string().trim().min(2).max(120),
  phone: z.string().trim().min(7).max(32)
    .transform((value) => value.replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x0660)).replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - 0x06f0)))
    .refine((value) => value.replace(/\D/g, "").length >= 7),
  city: z.string().trim().min(2).max(100),
  address: z.string().trim().min(4).max(500),
  items: z.array(z.object({ productId: z.string().min(1).max(160), quantity: z.number().int().min(1).max(50) })).min(1).max(50),
});
const idempotencyKeySchema = z.string().uuid();

type OrderLine = { productId: string; slug: string; name: string; priceIqd: number; quantity: number };
type ExistingOrder = {
  id: string;
  totalIqd: number;
  customerName: string;
  phone: string;
  city: string;
  address: string;
  lines: unknown;
};

function configuredWhatsAppNumber() {
  const number = (process.env.NEXT_PUBLIC_STORE_WHATSAPP || "").replace(/\D/g, "");
  return number.length >= 8 && number.length <= 15 ? number : null;
}

function fingerprintOrder(customer: { customerName: string; phone: string; city: string; address: string }, quantities: Map<string, number>) {
  const items = [...quantities.entries()]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([productId, quantity]) => ({ productId, quantity }));
  const canonical = JSON.stringify({
    customerName: customer.customerName,
    phone: customer.phone,
    city: customer.city,
    address: customer.address,
    items,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

function readOrderLines(value: unknown): OrderLine[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const lines: OrderLine[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return null;
    const line = item as Record<string, unknown>;
    if (
      typeof line.productId !== "string" ||
      typeof line.slug !== "string" ||
      typeof line.name !== "string" ||
      !Number.isSafeInteger(line.priceIqd) ||
      Number(line.priceIqd) < 0 ||
      !Number.isSafeInteger(line.quantity) ||
      Number(line.quantity) < 1
    ) return null;
    lines.push({
      productId: line.productId,
      slug: line.slug,
      name: line.name,
      priceIqd: Number(line.priceIqd),
      quantity: Number(line.quantity),
    });
  }
  return lines;
}

function fingerprintStoredOrder(order: ExistingOrder) {
  const lines = readOrderLines(order.lines);
  if (!lines) return null;
  const quantities = new Map<string, number>();
  for (const line of lines) quantities.set(line.productId, (quantities.get(line.productId) || 0) + line.quantity);
  return fingerprintOrder(order, quantities);
}

function responseForOrder(
  order: ExistingOrder,
  fingerprint: string,
  whatsappNumber: string,
  replayed: boolean,
) {
  const storedFingerprint = fingerprintStoredOrder(order);
  if (!storedFingerprint) {
    return NextResponse.json({
      error: "تعذر التحقق من نتيجة الطلب السابق لهذا المفتاح.",
      code: "IDEMPOTENCY_RESULT_UNVERIFIABLE",
    }, { status: 409, headers: { "Cache-Control": "no-store" } });
  }
  if (storedFingerprint !== fingerprint) {
    return NextResponse.json({
      error: "مفتاح الطلب مستخدم مسبقاً لبيانات مختلفة.",
      code: "IDEMPOTENCY_KEY_REUSED",
    }, { status: 409, headers: { "Cache-Control": "no-store" } });
  }

  const lines = readOrderLines(order.lines);
  if (!lines) {
    return NextResponse.json({ error: "تعذر استعادة نتيجة الطلب السابق." }, {
      status: 500,
      headers: { "Cache-Control": "no-store" },
    });
  }
  const message = [
    "طلب جديد من 1sms.store",
    `رقم الطلب: ${order.id}`,
    `الاسم: ${order.customerName}`,
    `الهاتف: ${order.phone}`,
    `المدينة: ${order.city}`,
    `العنوان: ${order.address}`,
    "",
    ...lines.map((line) => `• ${line.name} × ${line.quantity} — ${(line.priceIqd * line.quantity).toLocaleString("en-US")} د.ع`),
    "",
    `الإجمالي: ${order.totalIqd.toLocaleString("en-US")} د.ع`,
  ].join("\n");
  const whatsappUrl = `https://wa.me/${whatsappNumber}?text=${encodeURIComponent(message)}`;
  return NextResponse.json({ orderId: order.id, totalIqd: order.totalIqd, whatsappUrl }, {
    status: replayed ? 200 : 201,
    headers: {
      "Cache-Control": "no-store",
      ...(replayed ? { "Idempotency-Replayed": "true" } : {}),
    },
  });
}

function isUniqueConstraintError(error: unknown): error is { code: string } {
  return !!error && typeof error === "object" && "code" in error && error.code === "P2002";
}

async function findByIdempotencyKey(idempotencyKey: string) {
  return db.order.findUnique({
    where: { idempotencyKey },
    select: {
      id: true,
      totalIqd: true,
      customerName: true,
      phone: true,
      city: true,
      address: true,
      lines: true,
    },
  });
}

function jsonError(error: string, status: number) {
  return NextResponse.json({ error }, { status, headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: NextRequest) {
  if (!hasSameOrigin(request)) return jsonError("تعذر التحقق من مصدر الطلب.", 403);
  const limited = await enforceRateLimit(request, RATE_LIMIT_POLICIES.checkout);
  if (limited) return limited;

  const keyResult = idempotencyKeySchema.safeParse(request.headers.get("idempotency-key"));
  if (!keyResult.success) return jsonError("مفتاح الطلب غير صالح أو مفقود. أعد المحاولة بمفتاح UUID.", 400);
  const idempotencyKey = keyResult.data.toLowerCase();
  const whatsappNumber = configuredWhatsAppNumber();
  if (!whatsappNumber) return jsonError("رقم واتساب المتجر غير مهيأ بعد.", 503);

  const body = await readJsonBody(request, 16 * 1024);
  if (!body.ok) return jsonError(body.error, body.status);
  const parsed = orderSchema.safeParse(body.value);
  if (!parsed.success) return jsonError("أكمل بيانات التوصيل واختر منتجاً واحداً على الأقل.", 400);
  const { items, ...customer } = parsed.data;
  const quantities = new Map<string, number>();
  for (const item of items) quantities.set(item.productId, (quantities.get(item.productId) || 0) + item.quantity);
  if ([...quantities.values()].some((quantity) => quantity > 50)) {
    return jsonError("الكمية المطلوبة من المنتج الواحد تتجاوز الحد المسموح.", 400);
  }

  const idempotencyFingerprint = fingerprintOrder(customer, quantities);
  const existing = await findByIdempotencyKey(idempotencyKey);
  if (existing) return responseForOrder(existing, idempotencyFingerprint, whatsappNumber, true);

  try {
    const { order, orderLines } = await db.$transaction(async (tx) => {
      const products = await tx.product.findMany({
        where: { id: { in: [...quantities.keys()] }, isPublished: true },
        select: { id: true, slug: true, name: true, priceIqd: true, inventory: true },
      });
      if (products.length !== quantities.size) throw new Error("PRODUCT_UNAVAILABLE");

      const lines: OrderLine[] = products.map((product) => ({
        productId: product.id,
        slug: product.slug,
        name: product.name,
        priceIqd: product.priceIqd,
        quantity: quantities.get(product.id)!,
      }));
      for (const line of lines) {
        if (line.quantity > products.find((product) => product.id === line.productId)!.inventory) {
          throw new Error("INSUFFICIENT_STOCK");
        }
        const changed = await tx.product.updateMany({
          where: { id: line.productId, isPublished: true, inventory: { gte: line.quantity } },
          data: { inventory: { decrement: line.quantity } },
        });
        if (changed.count !== 1) throw new Error("INSUFFICIENT_STOCK");
      }

      const totalIqd = lines.reduce((total, line) => total + line.priceIqd * line.quantity, 0);
      if (!Number.isSafeInteger(totalIqd) || totalIqd > 2_147_483_647) throw new Error("ORDER_TOTAL_TOO_LARGE");
      const order = await tx.order.create({
        data: {
          ...customer,
          totalIqd,
          lines,
          status: "PENDING_WHATSAPP",
          idempotencyKey,
        },
        select: { id: true, totalIqd: true },
      });
      return { order, orderLines: lines };
    });

    return responseForOrder({
      ...customer,
      id: order.id,
      totalIqd: order.totalIqd,
      lines: orderLines,
    }, idempotencyFingerprint, whatsappNumber, false);
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      const racedOrder = await findByIdempotencyKey(idempotencyKey);
      if (racedOrder) return responseForOrder(racedOrder, idempotencyFingerprint, whatsappNumber, true);
    }
    if (error instanceof Error && error.message === "PRODUCT_UNAVAILABLE") {
      return jsonError("أحد المنتجات لم يعد متاحاً. حدّث المتجر ثم حاول مجدداً.", 409);
    }
    if (error instanceof Error && error.message === "INSUFFICIENT_STOCK") {
      return jsonError("الكمية المتوفرة تغيّرت. حدّث السلة وحاول بكمية أقل.", 409);
    }
    if (error instanceof Error && error.message === "ORDER_TOTAL_TOO_LARGE") {
      return jsonError("إجمالي الطلب يتجاوز الحد المسموح. قلل الكميات ثم حاول مجدداً.", 400);
    }
    throw error;
  }
}

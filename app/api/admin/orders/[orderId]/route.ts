import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { authorizeAdminRequest } from "@/lib/security/rate-limit";
import { hasSameOrigin, readJsonBody } from "@/lib/http/request-body";
import { expirePendingOrderInTransaction, ORDER_RESERVATION_MS } from "@/lib/orders/expire-pending";

export const dynamic = "force-dynamic";

const statusSchema = z.object({
  status: z.enum(["PENDING_WHATSAPP", "CONFIRMED", "PROCESSING", "SHIPPED", "DELIVERED", "CANCELLED"]),
});
const allowedTransitions: Record<string, string[]> = {
  PENDING_WHATSAPP: ["CONFIRMED", "CANCELLED"],
  CONFIRMED: ["PROCESSING", "CANCELLED"],
  PROCESSING: ["SHIPPED", "CANCELLED"],
  SHIPPED: ["DELIVERED"],
  DELIVERED: [],
  CANCELLED: [],
  EXPIRED: [],
};

function getOrderLines(value: unknown) {
  if (!Array.isArray(value)) return null;
  const lines: { productId: string; quantity: number }[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return null;
    const line = item as Record<string, unknown>;
    if (typeof line.productId !== "string" || !Number.isSafeInteger(line.quantity) || Number(line.quantity) < 1) return null;
    lines.push({ productId: line.productId, quantity: Number(line.quantity) });
  }
  return lines.length ? lines : null;
}

export async function PATCH(request: NextRequest, context: { params: Promise<{ orderId: string }> }) {
  if (!hasSameOrigin(request)) return NextResponse.json({ error: "تعذر التحقق من مصدر الطلب." }, { status: 403, headers: { "Cache-Control": "no-store" } });
  const denied = await authorizeAdminRequest(request);
  if (denied) return denied;
  const { orderId } = await context.params;
  if (!orderId || orderId.length > 160) return NextResponse.json({ error: "معرف الطلب غير صالح." }, { status: 400, headers: { "Cache-Control": "no-store" } });
  const body = await readJsonBody(request, 4 * 1024);
  if (!body.ok) return NextResponse.json({ error: body.error }, { status: body.status, headers: { "Cache-Control": "no-store" } });
  const parsed = statusSchema.safeParse(body.value);
  if (!parsed.success) return NextResponse.json({ error: "حالة الطلب غير صالحة." }, { status: 400, headers: { "Cache-Control": "no-store" } });

  try {
    const result = await db.$transaction(async (tx) => {
      const current = await tx.order.findUnique({ where: { id: orderId } });
      if (!current) throw new Error("ORDER_NOT_FOUND");
      const cutoff = new Date(Date.now() - ORDER_RESERVATION_MS);
      if (current.status === "PENDING_WHATSAPP" && current.createdAt < cutoff) {
        const expired = await expirePendingOrderInTransaction(tx, current, cutoff);
        if (!expired) throw new Error("ORDER_STATUS_CHANGED");
        return { expired: true as const };
      }
      if (current.status === "CANCELLED" && parsed.data.status !== "CANCELLED") throw new Error("CANCELLED_ORDER");
      if (current.status in allowedTransitions && parsed.data.status !== current.status && !allowedTransitions[current.status].includes(parsed.data.status)) {
        throw new Error("INVALID_ORDER_TRANSITION");
      }
      if (parsed.data.status === "CANCELLED" && current.status !== "CANCELLED") {
        if (current.status === "SHIPPED" || current.status === "DELIVERED") throw new Error("ORDER_ALREADY_SHIPPED");
        const lines = getOrderLines(current.lines);
        if (!lines) throw new Error("ORDER_LINES_INVALID");
        const claimed = await tx.order.updateMany({
          where: { id: orderId, status: current.status },
          data: { status: "CANCELLED" },
        });
        if (claimed.count !== 1) throw new Error("ORDER_STATUS_CHANGED");
        for (const line of lines) {
          await tx.product.update({ where: { id: line.productId }, data: { inventory: { increment: line.quantity } } });
        }
        return { expired: false as const, order: await tx.order.findUniqueOrThrow({
          where: { id: orderId },
          select: { id: true, customerName: true, phone: true, address: true, city: true, totalIqd: true, lines: true, status: true, createdAt: true },
        }) };
      }
      const changed = await tx.order.updateMany({
        where: { id: orderId, status: current.status },
        data: { status: parsed.data.status },
      });
      if (changed.count !== 1) throw new Error("ORDER_STATUS_CHANGED");
      return { expired: false as const, order: await tx.order.findUniqueOrThrow({
        where: { id: orderId },
        select: { id: true, customerName: true, phone: true, address: true, city: true, totalIqd: true, lines: true, status: true, createdAt: true },
      }) };
    });
    if (result.expired) {
      return NextResponse.json({ error: "انتهت مهلة حجز المخزون وأُعيدت الكمية المتاحة.", code: "ORDER_RESERVATION_EXPIRED" }, { status: 409, headers: { "Cache-Control": "no-store" } });
    }
    return NextResponse.json(result.order, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof Error && error.message === "ORDER_NOT_FOUND") return NextResponse.json({ error: "الطلب غير موجود." }, { status: 404 });
    if (error instanceof Error && error.message === "CANCELLED_ORDER") return NextResponse.json({ error: "لا يمكن إعادة فتح طلب ملغي؛ أنشئ طلباً جديداً لتجنب حجز المخزون مرتين." }, { status: 409 });
    if (error instanceof Error && error.message === "INVALID_ORDER_TRANSITION") return NextResponse.json({ error: "انتقل بالطلب خطوة واحدة في مسار التجهيز أو ألغِه قبل الشحن." }, { status: 409 });
    if (error instanceof Error && error.message === "ORDER_ALREADY_SHIPPED") return NextResponse.json({ error: "لا يمكن إلغاء طلب تم شحنه أو تسليمه. استخدم إجراء المرتجعات بعد استلام المنتج." }, { status: 409 });
    if (error instanceof Error && error.message === "ORDER_LINES_INVALID") return NextResponse.json({ error: "تعذر استعادة المخزون لأن تفاصيل الطلب لا تحتوي بيانات صالحة." }, { status: 409 });
    if (error instanceof Error && error.message === "ORDER_STATUS_CHANGED") return NextResponse.json({ error: "تغيرت حالة الطلب بالتزامن. حدّث الصفحة وحاول مجدداً." }, { status: 409 });
    if (error && typeof error === "object" && "code" in error && error.code === "P2025") return NextResponse.json({ error: "أحد المنتجات المرتبطة بالطلب غير موجود." }, { status: 409 });
    throw error;
  }
}

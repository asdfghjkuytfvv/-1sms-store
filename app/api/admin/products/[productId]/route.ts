import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { authorizeAdminRequest } from "@/lib/security/rate-limit";
import { isCredentialFreeHttpsUrl } from "@/lib/security/url-validation";
import { hasSameOrigin, readJsonBody } from "@/lib/http/request-body";

export const dynamic = "force-dynamic";

const imageUrlSchema = z.preprocess(
  (value) => value === "" ? null : value,
  z.string().url().refine(isCredentialFreeHttpsUrl, "استخدم رابط صورة HTTPS دون بيانات دخول مضمّنة.").nullable(),
);
const productPatchSchema = z.object({
  name: z.string().trim().min(2).max(140).optional(),
  slug: z.string().trim().min(1).max(160).optional(),
  description: z.string().trim().max(2000).optional(),
  category: z.string().trim().min(1).max(80).optional(),
  priceIqd: z.number().int().min(0).max(1_000_000_000).optional(),
  inventory: z.number().int().min(0).max(1_000_000).optional(),
  imageUrl: imageUrlSchema.optional(),
  isPublished: z.boolean().optional(),
}).refine((data) => Object.keys(data).length > 0, "No changes were provided.");

export async function PATCH(request: NextRequest, context: { params: Promise<{ productId: string }> }) {
  if (!hasSameOrigin(request)) return NextResponse.json({ error: "تعذر التحقق من مصدر الطلب." }, { status: 403, headers: { "Cache-Control": "no-store" } });
  const denied = await authorizeAdminRequest(request);
  if (denied) return denied;
  const { productId } = await context.params;
  if (!productId || productId.length > 160) return NextResponse.json({ error: "معرف المنتج غير صالح." }, { status: 400, headers: { "Cache-Control": "no-store" } });
  const body = await readJsonBody(request, 8 * 1024);
  if (!body.ok) return NextResponse.json({ error: body.error }, { status: body.status, headers: { "Cache-Control": "no-store" } });
  const parsed = productPatchSchema.safeParse(body.value);
  if (!parsed.success) return NextResponse.json({ error: "تعذر حفظ المنتج. تحقق من البيانات المدخلة.", details: parsed.error.flatten() }, { status: 400, headers: { "Cache-Control": "no-store" } });

  try {
    const product = await db.product.update({ where: { id: productId }, data: parsed.data });
    return NextResponse.json(product, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "P2025") {
      return NextResponse.json({ error: "المنتج غير موجود." }, { status: 404 });
    }
    if (error && typeof error === "object" && "code" in error && error.code === "P2002") {
      return NextResponse.json({ error: "رابط المنتج مستخدم مسبقاً." }, { status: 409 });
    }
    throw error;
  }
}

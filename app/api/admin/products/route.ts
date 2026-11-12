import { randomUUID } from "node:crypto";
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
const productSchema = z.object({
  name: z.string().trim().min(2).max(140),
  slug: z.string().trim().max(160).optional(),
  description: z.string().trim().max(2000).optional().default(""),
  category: z.string().trim().min(1).max(80).optional().default("عام"),
  priceIqd: z.number().int().min(0).max(1_000_000_000),
  inventory: z.number().int().min(0).max(1_000_000).optional().default(0),
  imageUrl: imageUrlSchema.optional().default(null),
  isPublished: z.boolean().optional().default(true),
});

function makeSlug(input: string) {
  const slug = input.normalize("NFKC").toLocaleLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-|-$/g, "");
  return slug || `product-${randomUUID()}`;
}

export async function GET(request: NextRequest) {
  const denied = await authorizeAdminRequest(request);
  if (denied) return denied;
  const products = await db.product.findMany({
    orderBy: { updatedAt: "desc" },
    select: { id: true, slug: true, name: true, description: true, category: true, priceIqd: true, inventory: true, imageUrl: true, modelUrl: true, modelStatus: true, isPublished: true, updatedAt: true },
  });
  return NextResponse.json(products, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: NextRequest) {
  if (!hasSameOrigin(request)) return NextResponse.json({ error: "تعذر التحقق من مصدر الطلب." }, { status: 403, headers: { "Cache-Control": "no-store" } });
  const denied = await authorizeAdminRequest(request);
  if (denied) return denied;
  const body = await readJsonBody(request, 8 * 1024);
  if (!body.ok) return NextResponse.json({ error: body.error }, { status: body.status, headers: { "Cache-Control": "no-store" } });
  const parsed = productSchema.safeParse(body.value);
  if (!parsed.success) return NextResponse.json({ error: "تحقق من حقول المنتج والأسعار والمخزون.", details: parsed.error.flatten() }, { status: 400, headers: { "Cache-Control": "no-store" } });

  try {
    const product = await db.product.create({
      data: { ...parsed.data, slug: makeSlug(parsed.data.slug || parsed.data.name) },
    });
    return NextResponse.json(product, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "P2002") {
      return NextResponse.json({ error: "رابط المنتج مستخدم مسبقاً. اختر رابطاً آخر." }, { status: 409 });
    }
    throw error;
  }
}

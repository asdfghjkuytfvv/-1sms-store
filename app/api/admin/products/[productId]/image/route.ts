import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import sharp from "sharp";
import { db } from "@/lib/db";
import { authorizeAdminRequest, RATE_LIMIT_POLICIES } from "@/lib/security/rate-limit";
import { hasSameOrigin, readMultipartFormData } from "@/lib/http/request-body";
import { publicAssetUrl, putObject } from "@/lib/storage";

export const runtime = "nodejs";
export const maxDuration = 30;
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_BODY_BYTES = MAX_BYTES + 256 * 1024;
const MIME = new Set(["image/jpeg", "image/png", "image/webp"]);

function hasValidSignature(bytes: Buffer, mime: string) {
  if (mime === "image/jpeg") return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mime === "image/png") return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mime === "image/webp") return bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
  return false;
}

export async function POST(request: NextRequest, context: { params: Promise<{ productId: string }> }) {
  if (!hasSameOrigin(request)) return NextResponse.json({ error: "تعذر التحقق من مصدر الطلب." }, { status: 403, headers: { "Cache-Control": "no-store" } });
  const denied = await authorizeAdminRequest(request, RATE_LIMIT_POLICIES.adminImageUpload);
  if (denied) return denied;
  const { productId } = await context.params;
  if (!productId || productId.length > 160) return NextResponse.json({ error: "معرف المنتج غير صالح." }, { status: 400 });
  const product = await db.product.findUnique({ where: { id: productId }, select: { id: true } });
  if (!product) return NextResponse.json({ error: "المنتج غير موجود." }, { status: 404 });

  const parsedForm = await readMultipartFormData(request, MAX_BODY_BYTES);
  if (!parsedForm.ok) return NextResponse.json({ error: parsedForm.error }, { status: parsedForm.status, headers: { "Cache-Control": "no-store" } });
  const form = parsedForm.form;
  const file = form.get("image");
  if (!(file instanceof File)) return NextResponse.json({ error: "اختر صورة للمنتج." }, { status: 400 });
  if (!MIME.has(file.type) || file.size < 32 || file.size > MAX_BYTES) {
    return NextResponse.json({ error: "اختر صورة JPG أو PNG أو WebP بحجم لا يتجاوز 10 MB." }, { status: 400 });
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  if (!hasValidSignature(bytes, file.type)) return NextResponse.json({ error: "محتوى الملف لا يطابق نوع الصورة." }, { status: 400 });

  let optimized: Buffer;
  try {
    optimized = await sharp(bytes, { limitInputPixels: 40_000_000 })
      .rotate()
      .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 86, effort: 5 })
      .toBuffer();
  } catch {
    return NextResponse.json({ error: "تعذر قراءة الصورة. جرّب ملفاً آخر." }, { status: 400 });
  }

  const key = `products/${productId}/images/${randomUUID()}.webp`;
  await putObject(key, optimized, "image/webp", "public, max-age=31536000, immutable");
  const imageUrl = publicAssetUrl(key);
  await db.product.update({ where: { id: productId }, data: { imageUrl, imageKey: key } });
  return NextResponse.json({ imageUrl }, { status: 201, headers: { "Cache-Control": "no-store" } });
}

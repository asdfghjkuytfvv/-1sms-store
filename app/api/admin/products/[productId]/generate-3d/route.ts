import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { isStorageConfigured, putObject } from "@/lib/storage";
import { getGenerationQueue, isRedisConfigured } from "@/lib/queue";
import { authorizeAdminRequest, RATE_LIMIT_POLICIES } from "@/lib/security/rate-limit";
import { hasSameOrigin, readMultipartFormData } from "@/lib/http/request-body";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_BYTES = 20 * 1024 * 1024;
const MAX_BODY_BYTES = MAX_BYTES + 256 * 1024;

const MIME_TYPES = new Map<string, string>([
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/webp", "webp"],
]);

function hasValidSignature(bytes: Buffer, mime: string): boolean {
  if (mime === "image/jpeg") {
    return (
      bytes.length >= 3 &&
      bytes[0] === 0xff &&
      bytes[1] === 0xd8 &&
      bytes[2] === 0xff
    );
  }

  if (mime === "image/png") {
    return bytes
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  }

  if (mime === "image/webp") {
    return (
      bytes.toString("ascii", 0, 4) === "RIFF" &&
      bytes.toString("ascii", 8, 12) === "WEBP"
    );
  }

  return false;
}

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ productId: string }> }
) {
  try {
    if (!hasSameOrigin(request)) return jsonError("تعذر التحقق من مصدر الطلب.", 403);
    const denied = await authorizeAdminRequest(request, RATE_LIMIT_POLICIES.admin3d);
    if (denied) return denied;

    // خدمات 3D اختيارية، ولا توقف المتجر إذا لم تكن مربوطة
    if (!isRedisConfigured()) {
      return jsonError(
        "خدمة إنشاء المجسمات ثلاثية الأبعاد غير مفعلة حالياً.",
        503
      );
    }

    if (!isStorageConfigured()) {
      return jsonError(
        "خدمة تخزين الصور غير مهيأة حالياً.",
        503
      );
    }

    const { productId } = await context.params;

    if (!productId || typeof productId !== "string" || productId.length > 160) {
      return jsonError("Product ID is required.", 400);
    }

    const product = await db.product.findUnique({
      where: { id: productId },
      select: { id: true, modelUrl: true },
    });

    if (!product) {
      return jsonError("Product not found.", 404);
    }

    const parsedForm = await readMultipartFormData(request, MAX_BODY_BYTES);
    if (!parsedForm.ok) return jsonError(parsedForm.error, parsedForm.status);
    const form = parsedForm.form;
    const file = form.get("image");

    if (!(file instanceof File)) {
      return jsonError("Upload one product image.", 400);
    }

    const extension = MIME_TYPES.get(file.type);

    if (!extension || file.size < 32 || file.size > MAX_BYTES) {
      return jsonError(
        "استخدم صورة JPG أو PNG أو WebP بحجم لا يتجاوز 20 MB.",
        400
      );
    }

    const bytes = Buffer.from(await file.arrayBuffer());

    if (!hasValidSignature(bytes, file.type)) {
      return jsonError(
        "محتوى الملف لا يطابق نوع الصورة.",
        400
      );
    }

    const key =
      `products/${productId}/source/${randomUUID()}.${extension}`;

    // رفع الصورة إلى التخزين
    await putObject(key, bytes, file.type);

    // إنشاء مهمة التوليد
    const job = await db.$transaction(async (tx) => {
      const createdJob = await tx.generationJob.create({
        data: {
          productId,
          sourceImageKey: key,
          status: "QUEUED",
          provider: "meshy",
        },
      });

      await tx.product.update({
        where: { id: productId },
        data: {
          ...(product.modelUrl ? {} : { modelStatus: "QUEUED" }),
          imageKey: key,
        },
      });
      return createdJob;
    });

    // إرسال المهمة إلى Redis
    try {
      await getGenerationQueue().add(
        "generate-product-model",
        { generationJobId: job.id },
        { jobId: job.id }
      );
    } catch {
      const message = "Queue unavailable.";

      await db.$transaction(async (tx) => {
        await tx.generationJob.update({
          where: { id: job.id },
          data: {
            status: "FAILED",
            errorMessage: message.slice(0, 500),
          },
        });

        if (!product.modelUrl) {
          await tx.product.update({
            where: { id: productId },
            data: { modelStatus: "FAILED" },
          });
        }
      });

      return jsonError(
        "تعذر تشغيل مهمة إنشاء المجسم. حاول لاحقاً.",
        503
      );
    }

    return NextResponse.json(
      {
        success: true,
        jobId: job.id,
        status: "QUEUED",
      },
      { status: 202, headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    console.error("[generate-3d] request failed:", error instanceof Error ? error.name : "UnknownError");

    return jsonError(
      "حدث خطأ أثناء معالجة الطلب. تحقق من إعدادات الخدمات.",
      500
    );
  }
}

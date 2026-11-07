import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { putObject, isStorageConfigured } from "@/lib/storage";
import { generationQueue } from "@/lib/queue";
import { requireAdminRequest } from "@/lib/auth/admin";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_BYTES = 20 * 1024 * 1024;

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
  return NextResponse.json({ error: message }, { status });
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ productId: string }> }
) {
  try {
    // التحقق من تسجيل دخول المدير
    if (!requireAdminRequest(request)) {
      return jsonError("Unauthorized", 401);
    }

    // خدمات 3D اختيارية، ولا توقف المتجر إذا لم تكن مربوطة
    if (!generationQueue) {
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

    if (!productId || typeof productId !== "string") {
      return jsonError("Product ID is required.", 400);
    }

    const product = await db.product.findUnique({
      where: { id: productId },
      select: { id: true },
    });

    if (!product) {
      return jsonError("Product not found.", 404);
    }

    const form = await request.formData();
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
    const job = await db.generationJob.create({
      data: {
        productId,
        sourceImageKey: key,
        status: "QUEUED",
        provider: "meshy",
      },
    });

    await db.product.update({
      where: { id: productId },
      data: {
        modelStatus: "QUEUED",
        imageKey: key,
      },
    });

    // إرسال المهمة إلى Redis
    try {
      await generationQueue.add(
        "generate-product-model",
        { generationJobId: job.id },
        { jobId: job.id }
      );
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Queue unavailable.";

      await db.generationJob.update({
        where: { id: job.id },
        data: {
          status: "FAILED",
          errorMessage: message.slice(0, 500),
        },
      });

      await db.product.update({
        where: { id: productId },
        data: { modelStatus: "FAILED" },
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
      { status: 202 }
    );
  } catch (error) {
    console.error("[generate-3d]", error);

    return jsonError(
      "حدث خطأ أثناء معالجة الطلب. تحقق من إعدادات الخدمات.",
      500
    );
  }
}

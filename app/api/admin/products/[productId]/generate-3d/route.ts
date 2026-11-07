import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { putObject } from "@/lib/storage";
import { generationQueue } from "@/lib/queue";
import { requireAdminRequest } from "@/lib/auth/admin";

export const runtime = "nodejs";
export const maxDuration = 60;
const MAX_BYTES = 20 * 1024 * 1024;
const MIME = new Set(["image/jpeg", "image/png", "image/webp"]);
function hasValidSignature(bytes: Buffer, mime: string) {
  if (mime === "image/jpeg") return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mime === "image/png") return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mime === "image/webp") return bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
  return false;
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ productId: string }> },
) {
  if (!requireAdminRequest(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { productId } = await context.params;
  const product = await db.product.findUnique({ where: { id: productId } });
  if (!product) return NextResponse.json({ error: "Product not found." }, { status: 404 });

  const form = await request.formData();
  const file = form.get("image");
  if (!(file instanceof File)) return NextResponse.json({ error: "Upload one product image." }, { status: 400 });
  if (!MIME.has(file.type) || file.size < 32 || file.size > MAX_BYTES) {
    return NextResponse.json({ error: "Use JPG, PNG, or WebP up to 20 MB." }, { status: 400 });
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  if (!hasValidSignature(bytes, file.type)) {
    return NextResponse.json({ error: "The uploaded file content does not match its image type." }, { status: 400 });
  }
  const key = `products/${productId}/source/${randomUUID()}.${file.type.split("/")[1]}`;
  await putObject(key, bytes, file.type);

  const job = await db.generationJob.create({
    data: { productId, sourceImageKey: key, status: "QUEUED", provider: "meshy" },
  });
  await db.product.update({ where: { id: productId }, data: { modelStatus: "QUEUED", imageKey: key } });

  try {
    await generationQueue.add("generate-product-model", { generationJobId: job.id }, { jobId: job.id });
  } catch (error) {
    await db.generationJob.update({
      where: { id: job.id },
      data: { status: "FAILED", errorMessage: "Queue unavailable; try again." },
    });
    await db.product.update({ where: { id: productId }, data: { modelStatus: "FAILED" } });
    throw error;
  }

  return NextResponse.json({ jobId: job.id, status: job.status }, { status: 202 });
}

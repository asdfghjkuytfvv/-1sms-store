import { randomUUID } from "node:crypto";
import { writeFile, readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { db } from "../lib/db";
import { signedGetUrl, putObject, publicAssetUrl } from "../lib/storage";
import { preprocessProductImage } from "../lib/image-preprocess";
import { createImageTo3DTask, getImageTo3DTask } from "../lib/providers/meshy";

const exec = promisify(execFile);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function update(jobId: string, status: any, progress: number, errorMessage?: string) {
  const job = await db.generationJob.findUnique({ where: { id: jobId }, select: { productId: true } });
  if (!job) throw new Error(`Generation job ${jobId} was removed.`);
  const modelStatus =
    status === "GENERATING" || status === "DOWNLOADING" ? "GENERATING" :
    status === "OPTIMIZING" || status === "PUBLISHING" ? "OPTIMIZING" : "QUEUED";
  await db.$transaction([
    db.generationJob.update({
      where: { id: jobId },
      data: { status, progress, ...(errorMessage ? { errorMessage } : {}) },
    }),
    db.product.update({ where: { id: job.productId }, data: { modelStatus } }),
  ]);
}

export async function processGeneration(generationJobId: string) {
  const job = await db.generationJob.findUnique({ where: { id: generationJobId }, include: { product: true } });
  if (!job) throw new Error(`Generation job ${generationJobId} does not exist.`);
  const timeoutAt = Date.now() + Number(process.env.GENERATION_MAX_MINUTES || 45) * 60_000;
  let tempInput = "", tempOutput = "";

  try {
    // Resume a previous attempt instead of paying for a duplicate provider task.
    if (job.outputModelKey) {
      const modelUrl = publicAssetUrl(job.outputModelKey);
      await db.$transaction([
        db.generationJob.update({ where: { id: job.id }, data: { status: "SUCCEEDED", progress: 100 } }),
        db.product.update({ where: { id: job.productId }, data: { modelUrl, modelKey: job.outputModelKey, modelStatus: "READY" } }),
      ]);
      return;
    }

    await update(job.id, "PREPROCESSING", 4);
    let normalizedKey = job.normalizedKey;
    if (!normalizedKey) {
      const sourceUrl = await signedGetUrl(job.sourceImageKey, 60 * 60);
      const response = await fetch(sourceUrl, { signal: AbortSignal.timeout(60_000) });
      if (!response.ok) throw new Error(`Could not retrieve uploaded image (${response.status}).`);
      const normalized = await preprocessProductImage(Buffer.from(await response.arrayBuffer()));
      normalizedKey = `products/${job.productId}/normalized/${randomUUID()}.png`;
      await putObject(normalizedKey, normalized, "image/png");
      await db.generationJob.update({ where: { id: job.id }, data: { normalizedKey } });
    }

    await update(job.id, "GENERATING", 12);
    const inputUrl = await signedGetUrl(normalizedKey, 60 * 60);
    let taskId = job.providerTaskId;
    if (!taskId) {
      taskId = await createImageTo3DTask(inputUrl);
      await db.generationJob.update({ where: { id: job.id }, data: { providerTaskId: taskId } });
    }

    let modelUrl: string | undefined;
    while (Date.now() < timeoutAt) {
      const { task, retryAfterSeconds } = await getImageTo3DTask(taskId);
      const pct = Math.min(85, 12 + Math.round((task.progress || 0) * 0.73));
      await update(job.id, "GENERATING", pct);
      if (task.status === "SUCCEEDED") { modelUrl = task.model_urls?.glb; break; }
      if (task.status === "FAILED" || task.status === "CANCELED") {
        throw new Error(task.task_error?.message || `Meshy task finished with ${task.status}.`);
      }
      await sleep(Math.max(2, Math.min(retryAfterSeconds || 5, 20)) * 1000);
    }
    if (!modelUrl) throw new Error("3D generation timed out.");
    await update(job.id, "DOWNLOADING", 88);

    const modelResponse = await fetch(modelUrl, { signal: AbortSignal.timeout(120_000) });
    if (!modelResponse.ok) throw new Error(`Could not download generated GLB (${modelResponse.status}).`);
    const modelBytes = Buffer.from(await modelResponse.arrayBuffer());
    const maxBytes = Number(process.env.MODEL_MAX_BYTES || 104857600);
    if (modelBytes.byteLength > maxBytes) throw new Error(`Generated model exceeds ${maxBytes} bytes.`);
    tempInput = join(tmpdir(), `${job.id}-input.glb`);
    tempOutput = join(tmpdir(), `${job.id}-optimized.glb`);
    await writeFile(tempInput, modelBytes);

    await update(job.id, "OPTIMIZING", 92);
    // glTF Transform CLI: Draco mesh compression + KTX2/Basis texture compression.
    await exec("gltf-transform", [
      "optimize", tempInput, tempOutput,
      "--compress", "draco",
      "--texture-compress", "ktx2",
      "--texture-size", "1024",
    ], { timeout: 10 * 60_000, maxBuffer: 10 * 1024 * 1024 });

    await update(job.id, "PUBLISHING", 97);
    const optimized = await readFile(tempOutput);
    const modelKey = `products/${job.productId}/models/${randomUUID()}.glb`;
    await putObject(modelKey, optimized, "model/gltf-binary");
    const modelUrlPublished = publicAssetUrl(modelKey);

    await db.$transaction([
      db.generationJob.update({
        where: { id: job.id },
        data: { status: "SUCCEEDED", progress: 100, outputModelKey: modelKey, errorMessage: null },
      }),
      db.product.update({
        where: { id: job.productId },
        data: {
          modelUrl: modelUrlPublished,
          modelKey,
          modelStatus: "READY",
          imageUrl: publicAssetUrl(normalizedKey),
        },
      }),
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown 3D generation error.";
    await db.$transaction([
      db.generationJob.update({ where: { id: job.id }, data: { status: "FAILED", errorMessage: message } }),
      db.product.update({ where: { id: job.productId }, data: { modelStatus: "FAILED" } }),
    ]);
    throw error;
  } finally {
    for (const path of [tempInput, tempOutput]) if (path) await unlink(path).catch(() => undefined);
  }
}

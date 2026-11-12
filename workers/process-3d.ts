import { randomUUID } from "node:crypto";
import { readFile, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { db } from "../lib/db";
import type { GenerationStatus } from "@prisma/client";
import { signedGetUrl, putObject, publicAssetUrl } from "../lib/storage";
import { preprocessProductImage } from "../lib/image-preprocess";
import { createImageTo3DTask, getImageTo3DTask } from "../lib/providers/meshy";
import { readResponseBuffer } from "../lib/http/response-body";
import { isCredentialFreeHttpsUrl } from "../lib/security/url-validation";

const exec = promisify(execFile);
const sleep = (ms: number): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, ms));

export type GenerationDependencies = {
  database: typeof db;
  signedGetUrl: typeof signedGetUrl;
  putObject: typeof putObject;
  publicAssetUrl: typeof publicAssetUrl;
  preprocessProductImage: typeof preprocessProductImage;
  createImageTo3DTask: typeof createImageTo3DTask;
  getImageTo3DTask: typeof getImageTo3DTask;
  fetch: typeof fetch;
  optimizeModel: (input: Buffer, jobId: string, maxBytes: number) => Promise<Buffer>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  uuid: () => string;
};

async function optimizeModelFile(input: Buffer, jobId: string, maxBytes: number) {
  const tempInput = join(tmpdir(), `${jobId}-input.glb`);
  const tempOutput = join(tmpdir(), `${jobId}-optimized.glb`);
  try {
    await writeFile(tempInput, input);
    await exec("gltf-transform", [
      "optimize", tempInput, tempOutput,
      "--compress", "draco",
      "--texture-compress", "ktx2",
      "--texture-size", "1024",
    ], { timeout: 10 * 60_000, maxBuffer: 10 * 1024 * 1024 });
    const outputStats = await stat(tempOutput);
    if (outputStats.size > maxBytes) throw new Error(`Optimized model exceeds ${maxBytes} bytes.`);
    return await readFile(tempOutput);
  } finally {
    await unlink(tempInput).catch(() => undefined);
    await unlink(tempOutput).catch(() => undefined);
  }
}

const defaultDependencies: GenerationDependencies = {
  database: db,
  signedGetUrl,
  putObject,
  publicAssetUrl,
  preprocessProductImage,
  createImageTo3DTask,
  getImageTo3DTask,
  fetch: (...args) => fetch(...args),
  optimizeModel: optimizeModelFile,
  sleep,
  now: () => Date.now(),
  uuid: randomUUID,
};

async function update(database: typeof db, jobId: string, status: GenerationStatus, progress: number, errorMessage?: string) {
  const job = await database.generationJob.findUnique({ where: { id: jobId }, select: { productId: true } });
  if (!job) throw new Error(`Generation job ${jobId} was removed.`);
  const modelStatus =
    status === "GENERATING" || status === "DOWNLOADING" ? "GENERATING" :
    status === "OPTIMIZING" || status === "PUBLISHING" ? "OPTIMIZING" : "QUEUED";
  await database.$transaction([
    database.generationJob.update({
      where: { id: jobId },
      data: { status, progress, ...(errorMessage ? { errorMessage } : {}) },
    }),
    database.product.updateMany({ where: { id: job.productId, modelUrl: null }, data: { modelStatus } }),
  ]);
}

export async function processGeneration(generationJobId: string, overrides: Partial<GenerationDependencies> = {}) {
  const services = { ...defaultDependencies, ...overrides };
  const database = services.database;
  const job = await database.generationJob.findUnique({ where: { id: generationJobId }, include: { product: true } });
  if (!job) throw new Error(`Generation job ${generationJobId} does not exist.`);
  let timeoutAt = 0;

  try {
    const maxMinutes = Number(process.env.GENERATION_MAX_MINUTES || 45);
    if (!Number.isSafeInteger(maxMinutes) || maxMinutes < 1 || maxMinutes > 120) {
      throw new Error("GENERATION_MAX_MINUTES must be an integer from 1 to 120.");
    }
    timeoutAt = services.now() + maxMinutes * 60_000;

    // Resume a previous attempt instead of paying for a duplicate provider task.
    if (job.outputModelKey) {
      const modelUrl = services.publicAssetUrl(job.outputModelKey);
      await database.$transaction([
        database.generationJob.update({ where: { id: job.id }, data: { status: "SUCCEEDED", progress: 100 } }),
        database.product.update({ where: { id: job.productId }, data: { modelUrl, modelKey: job.outputModelKey, modelStatus: "READY" } }),
      ]);
      return;
    }

    await update(database, job.id, "PREPROCESSING", 4);
    let normalizedKey = job.normalizedKey;
    if (!normalizedKey) {
      const sourceUrl = await services.signedGetUrl(job.sourceImageKey, 15 * 60);
      const response = await services.fetch(sourceUrl, { signal: AbortSignal.timeout(60_000) });
      if (!response.ok) throw new Error(`Could not retrieve uploaded image (${response.status}).`);
      const sourceBytes = await readResponseBuffer(response, 20 * 1024 * 1024);
      const normalized = await services.preprocessProductImage(sourceBytes);
      normalizedKey = `products/${job.productId}/normalized/${services.uuid()}.png`;
      // Normalized inputs remain private; Meshy receives only a short-lived signed URL.
      await services.putObject(normalizedKey, normalized, "image/png");
      await database.generationJob.update({ where: { id: job.id }, data: { normalizedKey } });
    }

    await update(database, job.id, "GENERATING", 12);
    const inputUrl = await services.signedGetUrl(normalizedKey, 15 * 60);
    let taskId = job.providerTaskId;
    if (!taskId) {
      taskId = await services.createImageTo3DTask(inputUrl);
      await database.generationJob.update({ where: { id: job.id }, data: { providerTaskId: taskId } });
    }

    let modelUrl: string | undefined;
    while (services.now() < timeoutAt) {
      const { task, retryAfterSeconds } = await services.getImageTo3DTask(taskId);
      const pct = Math.min(85, 12 + Math.round((task.progress || 0) * 0.73));
      await update(database, job.id, "GENERATING", pct);
      if (task.status === "SUCCEEDED") { modelUrl = task.model_urls?.glb; break; }
      if (task.status === "FAILED" || task.status === "CANCELED") {
        throw new Error(task.task_error?.message || `Meshy task finished with ${task.status}.`);
      }
      await services.sleep(Math.max(2, Math.min(retryAfterSeconds || 5, 20)) * 1000);
    }
    if (!modelUrl) throw new Error("3D generation timed out.");
    if (!isCredentialFreeHttpsUrl(modelUrl)) throw new Error("Meshy returned an invalid model URL.");
    await update(database, job.id, "DOWNLOADING", 88);

    const modelResponse = await services.fetch(modelUrl, { signal: AbortSignal.timeout(120_000) });
    if (!modelResponse.ok) throw new Error(`Could not download generated GLB (${modelResponse.status}).`);
    const maxBytes = Number(process.env.MODEL_MAX_BYTES || 104857600);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1024 * 1024 * 1024) throw new Error("MODEL_MAX_BYTES must be from 1 byte to 1 GiB.");
    const modelBytes = await readResponseBuffer(modelResponse, maxBytes);
    if (modelBytes.length === 0) throw new Error("Generated model response was empty.");

    await update(database, job.id, "OPTIMIZING", 92);
    const optimized = await services.optimizeModel(modelBytes, job.id, maxBytes);
    if (optimized.byteLength > maxBytes) throw new Error(`Optimized model exceeds ${maxBytes} bytes.`);

    await update(database, job.id, "PUBLISHING", 97);
    const modelKey = `products/${job.productId}/models/${services.uuid()}.glb`;
    await services.putObject(modelKey, optimized, "model/gltf-binary", "public, max-age=31536000, immutable");
    const modelUrlPublished = services.publicAssetUrl(modelKey);

    await database.$transaction([
      database.generationJob.update({
        where: { id: job.id },
        data: { status: "SUCCEEDED", progress: 100, outputModelKey: modelKey, errorMessage: null },
      }),
      database.product.update({
        where: { id: job.productId },
        data: {
          modelUrl: modelUrlPublished,
          modelKey,
          modelStatus: "READY",
        },
      }),
    ]);
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : "Unknown 3D generation error.";
    const message = rawMessage
      .replace(/https?:\/\/\S+/gi, "[remote URL]")
      .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
      .slice(0, 500);
    await database.$transaction([
      database.generationJob.update({ where: { id: job.id }, data: { status: "FAILED", errorMessage: message } }),
      database.product.updateMany({ where: { id: job.productId, modelUrl: null }, data: { modelStatus: "FAILED" } }),
    ]);
    throw error;
  }
}

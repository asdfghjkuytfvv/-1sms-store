import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { NextRequest } from "next/server";
import { S3Client } from "@aws-sdk/client-s3";
import sharp from "sharp";
import { db } from "../lib/db";
import { getRedisConnection, isRedisConfigured } from "../lib/queue";
import { isStorageConfigured, publicAssetUrl, putObject, signedGetUrl } from "../lib/storage";
import { createImageTo3DTask, getImageTo3DTask } from "../lib/providers/meshy";
import { preprocessProductImage } from "../lib/image-preprocess";
import { CHECKOUT_INTENT_STORAGE_KEY, clearCheckoutIntent, getOrCreateCheckoutIntent, type CheckoutIntentStorage } from "../lib/orders/client-idempotency";
import { readJsonBody, readMultipartFormData } from "../lib/http/request-body";
import { readResponseBuffer } from "../lib/http/response-body";
import { processGeneration, type GenerationDependencies } from "../workers/process-3d";
import { releaseCheckoutSubmitLock, tryAcquireCheckoutSubmitLock } from "../lib/orders/checkout-submit-lock";

function setEnv(t: TestContext, key: string, value: string | undefined) {
  const previous = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  t.after(() => {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  });
}

test("Redis queue connection is lazy and can be constructed without connecting", (t) => {
  setEnv(t, "REDIS_URL", "redis://127.0.0.1:1/test-only");
  assert.equal(isRedisConfigured(), true);
  const connection = getRedisConnection();
  assert.equal(connection.options.lazyConnect, true);
  assert.equal(connection.status, "wait");
  t.after(() => connection.disconnect());
});

test("storage uses private no-store by default and can presign with dummy credentials", async (t) => {
  setEnv(t, "S3_BUCKET", "test-only-bucket");
  setEnv(t, "S3_ACCESS_KEY_ID", "test-only-access-key");
  setEnv(t, "S3_SECRET_ACCESS_KEY", "test-only-secret-key");
  setEnv(t, "S3_ENDPOINT", "https://storage.invalid.test");
  setEnv(t, "S3_REGION", "auto");
  setEnv(t, "S3_PUBLIC_BASE_URL", "https://cdn.invalid.test");

  const clientBase = Object.getPrototypeOf(S3Client.prototype) as { send: (...args: unknown[]) => Promise<unknown> };
  const originalSend = clientBase.send;
  const sent: { input?: Record<string, unknown> }[] = [];
  clientBase.send = async function (...args: unknown[]) {
    const [command] = args as [{ input?: Record<string, unknown> }];
    sent.push(command);
    return {};
  };
  t.after(() => { clientBase.send = originalSend; });

  assert.equal(isStorageConfigured(), true);
  await putObject("products/test/source/input.png", Buffer.from("local-test"), "image/png");
  await putObject("products/test/models/output.glb", Buffer.from("local-test"), "model/gltf-binary", "public, max-age=31536000, immutable");
  assert.equal(sent[0].input?.CacheControl, "private, no-store");
  assert.equal(sent[1].input?.CacheControl, "public, max-age=31536000, immutable");
  assert.equal(sent[0].input?.Bucket, "test-only-bucket");

  const signedUrl = await signedGetUrl("products/test/source/input.png", 120);
  assert.match(signedUrl, /^https:\/\/test-only-bucket\.storage\.invalid\.test\//);
  assert.match(signedUrl, /X-Amz-Expires=120/);
  const boundedUrl = await signedGetUrl("products/test/source/input.png", 3600);
  assert.match(boundedUrl, /X-Amz-Expires=900/);
  assert.equal(publicAssetUrl("products/test/images/item.webp"), "https://cdn.invalid.test/products/test/images/item.webp");
});

test("public asset URLs reject non-HTTPS bases and embedded credentials", (t) => {
  setEnv(t, "S3_PUBLIC_BASE_URL", "http://cdn.invalid.test");
  assert.throws(() => publicAssetUrl("products/p1/image.webp"), /HTTPS base URL/);
});

test("production object storage rejects an HTTP endpoint before signing or uploading", async (t) => {
  setEnv(t, "NODE_ENV", "production");
  setEnv(t, "S3_BUCKET", "test-only-bucket");
  setEnv(t, "S3_ACCESS_KEY_ID", "test-only-access-key");
  setEnv(t, "S3_SECRET_ACCESS_KEY", "test-only-secret-key");
  setEnv(t, "S3_ENDPOINT", "http://storage.invalid.test");
  setEnv(t, "S3_PUBLIC_BASE_URL", "https://cdn.invalid.test");
  await assert.rejects(signedGetUrl("products/p1/source.png"), /use HTTPS in production/);
});

test("Meshy requests are testable with a mocked fetch and a placeholder key", async (t) => {
  setEnv(t, "MESHY_API_KEY", "placeholder-test-key");
  setEnv(t, "MESHY_MODEL", "test-model");
  const originalFetch = globalThis.fetch;
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    if (calls.length === 1) return new Response(JSON.stringify({ result: "task-test-1" }), { status: 200 });
    return new Response(JSON.stringify({ id: "task-test-1", status: "IN_PROGRESS", progress: 25 }), {
      status: 200, headers: { "retry-after": "7" },
    });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const id = await createImageTo3DTask("https://signed.invalid.test/source.png");
  const result = await getImageTo3DTask(id);
  assert.equal(id, "task-test-1");
  assert.match(calls[0].url, /api\.meshy\.ai\/openapi\/v1\/image-to-3d$/);
  assert.equal(calls[0].init?.method, "POST");
  assert.equal(new Headers(calls[0].init?.headers).get("authorization"), "Bearer placeholder-test-key");
  assert.equal(JSON.parse(String(calls[0].init?.body)).image_url, "https://signed.invalid.test/source.png");
  assert.equal(result.task.status, "IN_PROGRESS");
  assert.equal(result.retryAfterSeconds, 7);
});

test("image normalization runs locally without background-removal credentials", async (t) => {
  setEnv(t, "REMOVE_BG_API_KEY", undefined);
  const sample = await sharp({ create: { width: 4, height: 3, channels: 3, background: "#cc8844" } }).png().toBuffer();
  const normalized = await preprocessProductImage(sample);
  const metadata = await sharp(normalized).metadata();
  assert.equal(metadata.format, "png");
  assert.equal(metadata.width, 4);
  assert.equal(metadata.height, 3);
});

test("checkout intent persists only the UUID key for retries without customer data", () => {
  const values = new Map<string, string>();
  const storage: CheckoutIntentStorage = {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  };
  const first = getOrCreateCheckoutIntent("private-payload-a", storage, null, () => "00000000-0000-4000-8000-000000000011");
  const retry = getOrCreateCheckoutIntent("private-payload-a", storage, first, () => "00000000-0000-4000-8000-000000000012");
  assert.equal(retry.key, first.key);
  assert.equal(values.get(CHECKOUT_INTENT_STORAGE_KEY), first.key);
  const changed = getOrCreateCheckoutIntent("private-payload-b", storage, retry, () => "00000000-0000-4000-8000-000000000012");
  assert.notEqual(changed.key, first.key);
  clearCheckoutIntent(storage, retry.key);
  assert.equal(values.get(CHECKOUT_INTENT_STORAGE_KEY), changed.key);
  clearCheckoutIntent(storage, changed.key);
  assert.equal(values.has(CHECKOUT_INTENT_STORAGE_KEY), false);
});

test("checkout submit lock rejects a duplicate while the order request is pending", async () => {
  const lock = { current: false };
  let finishRequest!: () => void;
  const pendingRequest = new Promise<void>((resolve) => { finishRequest = resolve; });
  let requestCount = 0;
  const submit = async () => {
    if (!tryAcquireCheckoutSubmitLock(lock)) return false;
    requestCount++;
    try {
      await pendingRequest;
      return true;
    } finally {
      releaseCheckoutSubmitLock(lock);
    }
  };

  const first = submit();
  assert.equal(await submit(), false);
  assert.equal(requestCount, 1);
  finishRequest();
  assert.equal(await first, true);
  assert.equal(await submit(), true);
  assert.equal(requestCount, 2);
  assert.equal(lock.current, false);
});

test("JSON and multipart readers enforce streaming byte limits", async () => {
  const oversizedJson = new NextRequest("http://localhost/api/test", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ value: "x".repeat(128) }),
  });
  const jsonResult = await readJsonBody(oversizedJson, 32);
  assert.equal(jsonResult.ok, false);
  if (!jsonResult.ok) assert.equal(jsonResult.status, 413);

  const malformedJson = new NextRequest("http://localhost/api/test", {
    method: "POST", headers: { "content-type": "application/json" }, body: "{invalid",
  });
  const malformedResult = await readJsonBody(malformedJson, 1024);
  assert.equal(malformedResult.ok, false);
  if (!malformedResult.ok) assert.equal(malformedResult.status, 400);

  const form = new FormData();
  form.append("image", new File([new Uint8Array(128)], "sample.png", { type: "image/png" }));
  const oversizedForm = new NextRequest("http://localhost/api/test", { method: "POST", headers: { "content-length": "1024" }, body: form });
  const formResult = await readMultipartFormData(oversizedForm, 64);
  assert.equal(formResult.ok, false);
  if (!formResult.ok) assert.equal(formResult.status, 413);
});

test("3D worker streams remote outputs within configured size limits", async () => {
  const small = await readResponseBuffer(new Response(new Uint8Array([1, 2, 3])), 3);
  assert.deepEqual([...small], [1, 2, 3]);
  await assert.rejects(readResponseBuffer(new Response(new Uint8Array(8)), 4), /exceeds 4 bytes/);
});

test("3D generation lifecycle completes using mocked database, storage, Meshy and optimizer adapters", async (t) => {
  setEnv(t, "MODEL_MAX_BYTES", "1024");
  const job: Record<string, unknown> = {
    id: "job-test-3d", productId: "product-test-3d", sourceImageKey: "products/p/source/input.png",
    normalizedKey: null, providerTaskId: null, outputModelKey: null,
  };
  const product: Record<string, unknown> = { id: "product-test-3d", modelUrl: null, modelStatus: "QUEUED" };
  const statusHistory: string[] = [];
  const uploaded: { key: string; type: string; size: number; cacheControl?: string }[] = [];
  const privateUrls: string[] = [];
  let generatedTaskInput = "";
  let uuidIndex = 0;

  const fakeDatabase = {
    generationJob: {
      findUnique: async (args: { include?: unknown; select?: unknown }) => args.include
        ? { ...job, product: { ...product } }
        : args.select ? { productId: job.productId } : { ...job },
      update: async (args: { data: Record<string, unknown> }) => {
        Object.assign(job, args.data);
        if (typeof args.data.status === "string") statusHistory.push(args.data.status);
        return { ...job };
      },
    },
    product: {
      updateMany: async (args: { data: Record<string, unknown> }) => { Object.assign(product, args.data); return { count: 1 }; },
      update: async (args: { data: Record<string, unknown> }) => { Object.assign(product, args.data); return { ...product }; },
    },
    $transaction: async (operations: Promise<unknown>[]) => Promise.all(operations),
  } as unknown as typeof db;

  const dependencies: Partial<GenerationDependencies> = {
    database: fakeDatabase,
    signedGetUrl: async (key) => {
      const url = `https://private.invalid/${key}`;
      privateUrls.push(url);
      return url;
    },
    putObject: async (key, body, contentType, cacheControl) => {
      uploaded.push({ key, type: contentType, size: body.byteLength, cacheControl });
    },
    publicAssetUrl: (key) => `https://cdn.invalid/${key}`,
    preprocessProductImage: async () => Buffer.from("normalized-image"),
    createImageTo3DTask: async (imageUrl) => { generatedTaskInput = imageUrl; return "meshy-task-test"; },
    getImageTo3DTask: async () => ({
      task: { id: "meshy-task-test", status: "SUCCEEDED", progress: 100, model_urls: { glb: "https://provider.invalid/model.glb" } },
      retryAfterSeconds: 1,
    }),
    fetch: async (input) => String(input).includes("model.glb")
      ? new Response(Buffer.from("mock-glb"), { status: 200 })
      : new Response(Buffer.from("mock-source-image"), { status: 200 }),
    optimizeModel: async (input) => Buffer.concat([input, Buffer.from("-optimized")]),
    sleep: async () => undefined,
    now: () => 1000,
    uuid: () => `uuid-${++uuidIndex}`,
  };

  await processGeneration("job-test-3d", dependencies);
  assert.equal(job.status, "SUCCEEDED");
  assert.equal(job.progress, 100);
  assert.equal(job.outputModelKey, "products/product-test-3d/models/uuid-2.glb");
  assert.equal(product.modelStatus, "READY");
  assert.equal(product.modelUrl, "https://cdn.invalid/products/product-test-3d/models/uuid-2.glb");
  assert.equal(generatedTaskInput, privateUrls[1]);
  assert.ok(uploaded[0].key.includes("/normalized/"));
  assert.equal(uploaded[1].cacheControl, "public, max-age=31536000, immutable");
  assert.ok(statusHistory.includes("GENERATING"));
  assert.ok(statusHistory.includes("PUBLISHING"));
});

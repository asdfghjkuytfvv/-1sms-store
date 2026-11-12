import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { after, test } from "node:test";
import { NextRequest } from "next/server";

function assertLocalTestEnvironment() {
  assert.equal(process.env.NODE_ENV, "test");
  const database = new URL(process.env.DATABASE_URL || "");
  assert.equal(database.protocol, "postgresql:");
  assert.equal(database.hostname, "127.0.0.1");
  assert.equal(database.port, "55432");
  assert.equal(database.pathname, "/onesms_stage6_test");
  assert.equal(database.searchParams.get("schema"), "public");
  assert.equal(database.username, "onesms_stage6_user");
  const redis = new URL(process.env.REDIS_URL || "");
  assert.equal(redis.protocol, "redis:");
  assert.equal(redis.hostname, "127.0.0.1");
  assert.equal(redis.port, "56379");
  assert.equal(redis.username, "default");
  assert.match(redis.password, /^[0-9a-f]{64}$/);
  assert.equal(process.env.S3_ENDPOINT, "http://127.0.0.1:59000");
  assert.equal(process.env.S3_BUCKET, "onesms-stage6-test");
  assert.equal(process.env.S3_FORCE_PATH_STYLE, "true");
  assert.ok(process.env.AUTH_SECRET && process.env.AUTH_SECRET.length >= 32);
}
assertLocalTestEnvironment();

const { db } = await import("../lib/db");
const { POST: createOrder } = await import("../app/api/orders/route");
const { PATCH: updateOrder } = await import("../app/api/admin/orders/[orderId]/route");
const { GET: listProducts } = await import("../app/api/products/route");
const { expirePendingOrders, ORDER_RESERVATION_MS } = await import("../lib/orders/expire-pending");
const { adminCookieName, createAdminSession } = await import("../lib/auth/admin");
const { enforceRateLimit } = await import("../lib/security/rate-limit");
const { putObject, signedGetUrl } = await import("../lib/storage");

const now = () => new Date();
const unique = () => randomUUID();
async function makeProduct(inventory: number, extra: Record<string, unknown> = {}) {
  const id = unique();
  return db.product.create({
    data: {
      slug: `stage6-${id}`,
      name: `Stage 6 test ${id.slice(0, 8)}`,
      priceIqd: 1250,
      inventory,
      isPublished: true,
      ...extra,
    },
  });
}
function checkoutRequest(key: string, productId: string, quantity: number, customerName = "Stage Six Tester", ip = "198.51.100.21") {
  const url = "http://localhost:3000/api/orders";
  return new NextRequest(url, {
    method: "POST",
    headers: {
      origin: "http://localhost:3000",
      "content-type": "application/json",
      "idempotency-key": key,
      "x-real-ip": ip,
    },
    body: JSON.stringify({
      customerName,
      phone: "9647000000000",
      city: "Baghdad",
      address: "Stage six integration address",
      items: [{ productId, quantity }],
    }),
  });
}
async function reserve(productId: string, key = unique(), quantity = 1, ip?: string) {
  return createOrder(checkoutRequest(key, productId, quantity, "Stage Six Tester", ip));
}
function adminCancelRequest(orderId: string) {
  return new NextRequest(`http://localhost:3000/api/admin/orders/${orderId}`, {
    method: "PATCH",
    headers: {
      origin: "http://localhost:3000",
      cookie: `${adminCookieName}=${createAdminSession()}`,
      "content-type": "application/json",
      "x-real-ip": "198.51.100.44",
    },
    body: JSON.stringify({ status: "CANCELLED" }),
  });
}

const { S3Client, CreateBucketCommand, HeadObjectCommand } = await import("@aws-sdk/client-s3");
const s3 = new S3Client({
  region: process.env.S3_REGION,
  endpoint: process.env.S3_ENDPOINT,
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID!,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
  },
});
after(async () => {
  await s3.destroy();
  await db.$disconnect();
});

test("PostgreSQL checkout reserves stock, replays idempotency, and rejects key reuse", async () => {
  const product = await makeProduct(6);
  const key = unique();
  const first = await createOrder(checkoutRequest(key, product.id, 2));
  const firstResponseText = await first.clone().text();
  assert.equal(first.status, 201, `Checkout response ${first.status}: ${firstResponseText}`);
  const firstBody = await first.json() as { orderId: string };
  assert.ok(firstBody.orderId);
  assert.equal((await db.product.findUniqueOrThrow({ where: { id: product.id } })).inventory, 4);

  const replay = await createOrder(checkoutRequest(key, product.id, 2));
  assert.equal(replay.status, 200);
  assert.equal(replay.headers.get("Idempotency-Replayed"), "true");
  assert.equal((await replay.json() as { orderId: string }).orderId, firstBody.orderId);

  const mismatch = await createOrder(checkoutRequest(key, product.id, 1, "Different Customer"));
  assert.equal(mismatch.status, 409);
  assert.equal((await db.order.count({ where: { idempotencyKey: key } })), 1);
  assert.equal((await db.product.findUniqueOrThrow({ where: { id: product.id } })).inventory, 4);

  const independentOne = await reserve(product.id, unique(), 1);
  const independentTwo = await reserve(product.id, unique(), 1);
  assert.equal(independentOne.status, 201);
  assert.equal(independentTwo.status, 201);
  assert.equal((await db.product.findUniqueOrThrow({ where: { id: product.id } })).inventory, 2);
});

test("PostgreSQL unique constraint rolls back a concurrent duplicate reservation", async () => {
  const product = await makeProduct(4);
  const key = unique();
  const responses = await Promise.all([
    createOrder(checkoutRequest(key, product.id, 1, "Concurrent Tester", "198.51.100.22")),
    createOrder(checkoutRequest(key, product.id, 1, "Concurrent Tester", "198.51.100.23")),
  ]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 201]);
  assert.equal(await db.order.count({ where: { idempotencyKey: key } }), 1);
  assert.equal((await db.product.findUniqueOrThrow({ where: { id: product.id } })).inventory, 3);

});

test("PostgreSQL conditional stock update permits one buyer for the last unit", async () => {
  const product = await makeProduct(1);
  const keys = [unique(), unique()];
  const responses = await Promise.all([
    reserve(product.id, keys[0], 1, "198.51.100.24"),
    reserve(product.id, keys[1], 1, "198.51.100.25"),
  ]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [201, 409]);
  assert.equal((await db.product.findUniqueOrThrow({ where: { id: product.id } })).inventory, 0);
  assert.equal(await db.order.count({ where: { idempotencyKey: { in: keys } } }), 1);
});

test("PostgreSQL expiry restores inventory once under concurrent scheduler runs", async () => {
  const product = await makeProduct(1);
  const idempotencyKey = unique();
  const createdAt = new Date(Date.now() - ORDER_RESERVATION_MS - 60_000);
  const order = await db.order.create({
    data: {
      customerName: "Expired integration order",
      phone: "9647000000000",
      city: "Baghdad",
      address: "Stage six expiry test",
      totalIqd: 2500,
      status: "PENDING_WHATSAPP",
      idempotencyKey,
      createdAt,
      lines: [{ productId: product.id, slug: product.slug, name: product.name, priceIqd: 1250, quantity: 2 }],
    },
  });
  const confirmedProduct = await makeProduct(0);
  const confirmed = await db.order.create({ data: {
    customerName: "Confirmed integration order", phone: "9647000000000", city: "Baghdad", address: "Stage six confirmed test",
    totalIqd: 1250, status: "CONFIRMED", idempotencyKey: unique(), createdAt,
    lines: [{ productId: confirmedProduct.id, slug: confirmedProduct.slug, name: confirmedProduct.name, priceIqd: 1250, quantity: 1 }],
  } });
  const cancelledProduct = await makeProduct(0);
  const cancelled = await db.order.create({ data: {
    customerName: "Cancelled integration order", phone: "9647000000000", city: "Baghdad", address: "Stage six cancelled test",
    totalIqd: 1250, status: "CANCELLED", idempotencyKey: unique(), createdAt,
    lines: [{ productId: cancelledProduct.id, slug: cancelledProduct.slug, name: cancelledProduct.name, priceIqd: 1250, quantity: 1 }],
  } });
  const at = now();
  const results = await Promise.all([expirePendingOrders(at), expirePendingOrders(at)]);
  const saved = await db.order.findUniqueOrThrow({ where: { id: order.id } });
  assert.equal(saved.status, "EXPIRED");
  assert.equal((await db.product.findUniqueOrThrow({ where: { id: product.id } })).inventory, 3);
  assert.equal((await db.product.findUniqueOrThrow({ where: { id: confirmedProduct.id } })).inventory, 0);
  assert.equal((await db.order.findUniqueOrThrow({ where: { id: confirmed.id } })).status, "CONFIRMED");
  assert.equal((await db.product.findUniqueOrThrow({ where: { id: cancelledProduct.id } })).inventory, 0);
  assert.equal((await db.order.findUniqueOrThrow({ where: { id: cancelled.id } })).status, "CANCELLED");

  assert.ok(results.reduce((sum, result) => sum + result.expired, 0) >= 1);
  assert.equal(results.reduce((sum, result) => sum + result.failed, 0), 0);

  const young = await makeProduct(0);
  const youngOrder = await db.order.create({
    data: {
      customerName: "Young integration order", phone: "9647000000000", city: "Baghdad", address: "Stage six young test",
      totalIqd: 1250, status: "PENDING_WHATSAPP", idempotencyKey: unique(),
      createdAt: new Date(Date.now() - ORDER_RESERVATION_MS + 60_000),
      lines: [{ productId: young.id, slug: young.slug, name: young.name, priceIqd: 1250, quantity: 1 }],
    },
  });
  await expirePendingOrders(now());
  assert.equal((await db.order.findUniqueOrThrow({ where: { id: youngOrder.id } })).status, "PENDING_WHATSAPP");
  assert.equal((await db.product.findUniqueOrThrow({ where: { id: young.id } })).inventory, 0);
});

test("admin cancellation restores PostgreSQL inventory once", async () => {
  const product = await makeProduct(1);
  const order = await db.order.create({
    data: {
      customerName: "Cancellation integration order", phone: "9647000000000", city: "Baghdad", address: "Stage six cancel test",
      totalIqd: 2500, status: "PENDING_WHATSAPP", idempotencyKey: unique(),
      lines: [{ productId: product.id, slug: product.slug, name: product.name, priceIqd: 1250, quantity: 2 }],
    },
  });
  const first = await updateOrder(adminCancelRequest(order.id), { params: Promise.resolve({ orderId: order.id }) });
  assert.equal(first.status, 200);
  assert.equal((await first.json() as { status: string }).status, "CANCELLED");
  const second = await updateOrder(adminCancelRequest(order.id), { params: Promise.resolve({ orderId: order.id }) });
  assert.equal(second.status, 200);
  assert.equal((await db.product.findUniqueOrThrow({ where: { id: product.id } })).inventory, 3);

});

test("real Redis Lua rate limiter handles concurrent requests atomically", async () => {
  const policy = { name: `stage6-${unique()}`, limit: 4, windowMs: 10_000 };
  const ip = "198.51.100.31";
  const responses = await Promise.all(Array.from({ length: 12 }, () => enforceRateLimit(
    new NextRequest("http://localhost:3000/rate-test", { headers: { "x-real-ip": ip } }), policy,
  )));
  assert.equal(responses.filter((response) => response === null).length, 4);
  const limited = responses.filter((response) => response?.status === 429);
  assert.equal(limited.length, 8);
  assert.ok(limited.every((response) => response?.headers.get("RateLimit-Limit") === "4"));
});

test("real Redis connection failure fails the limiter closed", async () => {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  const helper = resolve("tests/stage6-redis-failure-probe.mts");
  const cli = resolve("node_modules/tsx/dist/cli.mjs");
  const result = spawnSync(process.execPath, [cli, helper], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 15_000,
    env: { ...process.env, REDIS_URL: `redis://default:stage6invalid@127.0.0.1:${port}` },
  });
  assert.equal(result.status, 0, `Redis failure probe exited ${result.status}: ${result.stderr}`);
  assert.match(result.stdout, /stage6-redis-failure:503/);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /stage6invalid/);
});

test("MinIO keeps uploads private and signed URLs expire", { timeout: 100_000 }, async () => {
  const bucket = process.env.S3_BUCKET!;
  try {
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
  } catch (error) {
    if (!(error && typeof error === "object" && "name" in error && error.name === "BucketAlreadyOwnedByYou")) throw error;
  }
  const key = `private/stage6/${unique()}.txt`;
  const content = Buffer.from(`stage6-test-${unique()}`);
  await putObject(key, content, "text/plain");
  const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
  assert.equal(head.CacheControl, "private, no-store");

  const unsigned = await fetch(`${process.env.S3_ENDPOINT}/${bucket}/${key}`);
  assert.equal(unsigned.status, 403);

  const signed = await signedGetUrl(key, 60);
  const signedUrl = new URL(signed);
  assert.equal(signedUrl.hostname, "127.0.0.1");
  assert.equal(signedUrl.port, "59000");
  assert.equal(signedUrl.searchParams.get("X-Amz-Expires"), "60");
  const firstRead = await fetch(signed);
  assert.equal(firstRead.status, 200);
  assert.deepEqual(Buffer.from(await firstRead.arrayBuffer()), content);

  await new Promise((resolveDelay) => setTimeout(resolveDelay, 62_000));
  const expiredRead = await fetch(signed);
  assert.ok(expiredRead.status >= 400, `Expected an expired signature, got ${expiredRead.status}`);

  const product = await makeProduct(0, { imageKey: key, modelKey: `private/model/${unique()}.glb` });
  const response = await listProducts(new NextRequest("http://localhost:3000/api/products", {
    headers: { "x-real-ip": "198.51.100.32" },
  }));
  assert.equal(response.status, 200);
  const serialized = JSON.stringify(await response.json());
  assert.ok(serialized.includes(product.id));
  assert.ok(!serialized.includes(key));
  assert.ok(!serialized.includes("private/model/"));
  assert.ok(!serialized.includes(process.env.S3_SECRET_ACCESS_KEY!));
  assert.ok(!serialized.includes(process.env.S3_ACCESS_KEY_ID!));
});
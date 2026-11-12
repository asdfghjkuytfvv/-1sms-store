import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { test, type TestContext } from "node:test";
import { scryptSync } from "node:crypto";
import { NextRequest } from "next/server";
import { db } from "../lib/db";
import { createAdminSession } from "../lib/auth/admin";
import { GET as getPublicProducts } from "../app/api/products/route";
import { GET as getAdminProducts, POST as createProduct } from "../app/api/admin/products/route";
import { PATCH as updateProduct } from "../app/api/admin/products/[productId]/route";
import { POST as createOrder } from "../app/api/orders/route";
import { GET as getAdminOrders } from "../app/api/admin/orders/route";
import { PATCH as updateOrder } from "../app/api/admin/orders/[orderId]/route";
import { POST as uploadProductImage } from "../app/api/admin/products/[productId]/image/route";
import { POST as generate3d } from "../app/api/admin/products/[productId]/generate-3d/route";
import { POST as adminLogin } from "../app/api/admin/login/route";
import { AdminOrderStatus } from "../components/AdminOrderStatus";
import { ORDER_RESERVATION_MS } from "../lib/orders/expire-pending";
import { enforceRateLimit, RATE_LIMIT_POLICIES, setRateLimitStoreForTests } from "../lib/security/rate-limit";
import { proxy as catalogProxy } from "../proxy";

Reflect.set(process.env, "NODE_ENV", "test");

const testAuthSecret = "automated-tests-only-auth-secret-32-chars";

function setEnv(t: TestContext, key: string, value: string | undefined) {
  const previous = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  t.after(() => {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  });
}

function replace(t: TestContext, target: object, key: string, value: unknown) {
  const mutable = target as unknown as Record<string, unknown>;
  const previous = mutable[key];
  mutable[key] = value;
  t.after(() => { mutable[key] = previous; });
}

function adminCookie(t: TestContext) {
  setEnv(t, "AUTH_SECRET", testAuthSecret);
  return `sms_admin=${createAdminSession()}`;
}

function jsonRequest(path: string, method: string, body?: unknown, headers: Record<string, string> = {}) {
  const requestHeaders = new Headers({ host: "localhost", ...headers });
  const requestInit: ConstructorParameters<typeof NextRequest>[1] = { method, headers: requestHeaders };
  if (body !== undefined) {
    requestHeaders.set("content-type", "application/json");
    requestInit.body = JSON.stringify(body);
  }
  return new NextRequest(`http://localhost${path}`, requestInit);
}

type TestProduct = { id: string; slug: string; name: string; priceIqd: number; inventory: number; isPublished: boolean };

function installCheckoutDatabase(t: TestContext, initialProducts: TestProduct[]) {
  const products = new Map(initialProducts.map((product) => [product.id, { ...product }]));
  const orders = new Map<string, Record<string, unknown>>();
  let nextOrderId = 1;
  let transactionTail = Promise.resolve();

  replace(t, db.order, "findUnique", async (args: { where: { idempotencyKey: string } }) => orders.get(args.where.idempotencyKey) || null);
  replace(t, db, "$transaction", async (callback: (transaction: unknown) => Promise<unknown>) => {
    const previous = transactionTail;
    let release = () => {};
    transactionTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    const originalInventory = new Map([...products].map(([id, product]) => [id, product.inventory]));
    const originalOrderKeys = new Set(orders.keys());
    const transaction = {
      product: {
        findMany: async (args: { where: { id: { in: string[] }; isPublished: boolean } }) =>
          args.where.id.in.map((id) => products.get(id)).filter((product): product is TestProduct => !!product && product.isPublished === args.where.isPublished),
        updateMany: async (args: { where: { id: string; isPublished: boolean; inventory: { gte: number } }; data: { inventory: { decrement: number } } }) => {
          const product = products.get(args.where.id);
          if (!product || product.isPublished !== args.where.isPublished || product.inventory < args.where.inventory.gte) return { count: 0 };
          product.inventory -= args.data.inventory.decrement;
          return { count: 1 };
        },
      },
      order: {
        create: async (args: { data: Record<string, unknown> }) => {
          const key = String(args.data.idempotencyKey);
          if (orders.has(key)) throw Object.assign(new Error("Unique idempotency key"), { code: "P2002" });
          const order: { id: string; [field: string]: unknown } = { id: `order-${nextOrderId++}`, ...args.data };
          orders.set(key, order);
          return { id: order.id, totalIqd: order.totalIqd };
        },
      },
    };

    try {
      return await callback(transaction);
    } catch (error) {
      for (const [id, inventory] of originalInventory) {
        const product = products.get(id);
        if (product) product.inventory = inventory;
      }
      for (const key of orders.keys()) if (!originalOrderKeys.has(key)) orders.delete(key);
      throw error;
    } finally {
      release();
    }
  });
  return { products, orders };
}

const baseCheckout = {
  customerName: "Customer", phone: "07701234567", city: "Baghdad", address: "Street 1",
  items: [{ productId: "p1", quantity: 1 }],
};
const checkoutKey1 = "00000000-0000-4000-8000-000000000001";
const checkoutKey2 = "00000000-0000-4000-8000-000000000002";

function checkoutRequest(body: unknown = baseCheckout, key = checkoutKey1) {
  return jsonRequest("/api/orders", "POST", body, { origin: "http://localhost", "idempotency-key": key });
}

test("public catalog only requests published products and excludes storage keys", async (t) => {
  let query: Record<string, unknown> | undefined;
  replace(t, db.product, "findMany", async (args: Record<string, unknown>) => {
    query = args;
    return [{ id: "p1", name: "Item", imageUrl: "https://cdn.example/item.webp" }];
  });

  const response = await getPublicProducts(new NextRequest("http://localhost/api/products"));
  assert.equal(response.status, 200);
  assert.deepEqual(query?.where, { isPublished: true });
  assert.equal(query?.take, 100);
  assert.equal("imageKey" in (query?.select as object), false);
  assert.equal("modelKey" in (query?.select as object), false);
  assert.match(response.headers.get("cache-control") || "", /s-maxage=30/);
});

test("admin product and order lists reject unauthenticated requests before querying", async (t) => {
  let queries = 0;
  replace(t, db.product, "findMany", async () => { queries += 1; return []; });
  replace(t, db.order, "findMany", async () => { queries += 1; return []; });

  const productsResponse = await getAdminProducts(jsonRequest("/api/admin/products", "GET"));
  const ordersResponse = await getAdminOrders(jsonRequest("/api/admin/orders", "GET"));
  assert.equal(productsResponse.status, 401);
  assert.equal(ordersResponse.status, 401);
  assert.equal(queries, 0);
});

test("admin product list is private and selects no object-storage credentials or keys", async (t) => {
  let query: Record<string, unknown> | undefined;
  replace(t, db.product, "findMany", async (args: Record<string, unknown>) => {
    query = args;
    return [{ id: "p1", name: "Item", inventory: 3 }];
  });

  const response = await getAdminProducts(jsonRequest("/api/admin/products", "GET", undefined, { cookie: adminCookie(t) }));
  assert.equal(response.status, 200);
  assert.equal((await response.json() as unknown[]).length, 1);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal("imageKey" in (query?.select as object), false);
  assert.equal("modelKey" in (query?.select as object), false);
});

test("authenticated admin order list is limited and marked no-store", async (t) => {
  const cookie = adminCookie(t);
  let query: Record<string, unknown> | undefined;
  replace(t, db.order, "findMany", async (args: Record<string, unknown>) => {
    query = args;
    return [{ id: "order-1", customerName: "Customer" }];
  });

  const response = await getAdminOrders(jsonRequest("/api/admin/orders", "GET", undefined, { cookie }));
  assert.equal(response.status, 200);
  assert.equal(query?.take, 100);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal("idempotencyKey" in (query?.select as object), false);
  assert.equal("idempotencyFingerprint" in (query?.select as object), false);
});

test("admin login verifies a scrypt hash and issues an HTTP-only strict cookie", async (t) => {
  setEnv(t, "AUTH_SECRET", testAuthSecret);
  const salt = "automated-test-salt";
  setEnv(t, "ADMIN_PASSWORD_SALT", salt);
  setEnv(t, "ADMIN_PASSWORD_HASH", scryptSync("correct-test-password", salt, 64).toString("hex"));

  const accepted = await adminLogin(jsonRequest("/api/admin/login", "POST", { password: "correct-test-password" }, { origin: "http://localhost" }));
  const rejected = await adminLogin(jsonRequest("/api/admin/login", "POST", { password: "wrong" }, { origin: "http://localhost" }));
  assert.equal(accepted.status, 200);
  assert.equal(rejected.status, 401);
  assert.match(accepted.headers.get("set-cookie") || "", /sms_admin=.*HttpOnly.*SameSite=strict/i);
});

test("admin product creation validates inputs and normalizes a Unicode slug", async (t) => {
  const cookie = adminCookie(t);
  let created: Record<string, unknown> | undefined;
  replace(t, db.product, "create", async (args: { data: Record<string, unknown> }) => {
    created = args.data;
    return { id: "p1", ...args.data };
  });

  const response = await createProduct(jsonRequest("/api/admin/products", "POST", {
    name: "منتج تجريبي", priceIqd: 12500, inventory: 4,
  }, { cookie }));
  assert.equal(response.status, 201);
  assert.equal(created?.slug, "منتج-تجريبي");
  assert.equal(created?.inventory, 4);
  assert.equal(created?.isPublished, true);
});

test("admin product update rejects invalid inventory and accepts a valid patch", async (t) => {
  const cookie = adminCookie(t);
  const updates: Record<string, unknown>[] = [];
  replace(t, db.product, "update", async (args: { data: Record<string, unknown> }) => {
    updates.push(args.data);
    return { id: "p1", ...args.data };
  });

  const invalid = await updateProduct(jsonRequest("/api/admin/products/p1", "PATCH", { inventory: -1 }, { cookie }), { params: Promise.resolve({ productId: "p1" }) });
  assert.equal(invalid.status, 400);
  assert.equal(updates.length, 0);

  const valid = await updateProduct(jsonRequest("/api/admin/products/p1", "PATCH", { inventory: 9 }, { cookie }), { params: Promise.resolve({ productId: "p1" }) });
  assert.equal(valid.status, 200);
  assert.deepEqual(updates, [{ inventory: 9 }]);
});

test("checkout rejects cross-origin and invalid payloads before database access", async (t) => {
  setEnv(t, "NODE_ENV", "test");
  setEnv(t, "NEXT_PUBLIC_STORE_WHATSAPP", "9647000000000");
  let transactions = 0;
  let lookups = 0;
  replace(t, db, "$transaction", async () => { transactions += 1; throw new Error("Database should not be called"); });
  replace(t, db.order, "findUnique", async () => { lookups += 1; return null; });

  const crossOrigin = await createOrder(jsonRequest("/api/orders", "POST", {}, { origin: "https://attacker.example" }));
  const missingKey = await createOrder(jsonRequest("/api/orders", "POST", baseCheckout, { origin: "http://localhost" }));
  const invalid = await createOrder(checkoutRequest({ customerName: "", items: [] }));
  assert.equal(crossOrigin.status, 403);
  assert.equal(missingKey.status, 400);
  assert.equal(invalid.status, 400);
  assert.equal(transactions, 0);
  assert.equal(lookups, 0);
});

test("checkout enforces its shared Redis rate limit before database access", async (t) => {
  setEnv(t, "NODE_ENV", "test");
  const keys: string[] = [];
  setRateLimitStoreForTests({ consume: async (key) => { keys.push(key); return { count: 6, ttlMs: 90_000 }; } });
  t.after(() => setRateLimitStoreForTests(undefined));
  let databaseCalls = 0;
  replace(t, db.order, "findUnique", async () => { databaseCalls += 1; return null; });

  const request = jsonRequest("/api/orders", "POST", baseCheckout, {
    origin: "http://localhost", "idempotency-key": checkoutKey1, "x-real-ip": "203.0.113.8",
  });
  const response = await createOrder(request);
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "90");
  assert.equal(databaseCalls, 0);
  assert.equal(keys.length, 1);
  assert.match(keys[0], /^1sms:ratelimit:v1:checkout:[0-9a-f]{64}$/);
  assert.equal(keys[0].includes("203.0.113.8"), false);
});

test("storefront page is throttled before its server component queries the catalog", async (t) => {
  setEnv(t, "NODE_ENV", "test");
  setRateLimitStoreForTests({ consume: async (key) => {
    assert.match(key, /^1sms:ratelimit:v1:catalog:/);
    return { count: 121, ttlMs: 20_000 };
  } });
  t.after(() => setRateLimitStoreForTests(undefined));

  const response = await catalogProxy(new NextRequest("http://localhost/", { headers: { "x-real-ip": "203.0.113.12" } }));
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "20");
});

test("admin login limits password attempts before scrypt verification", async (t) => {
  setEnv(t, "NODE_ENV", "test");
  let calls = 0;
  setRateLimitStoreForTests({ consume: async (key) => {
    calls += 1;
    assert.match(key, /^1sms:ratelimit:v1:admin-login:/);
    return { count: 6, ttlMs: 5 * 60_000 };
  } });
  t.after(() => setRateLimitStoreForTests(undefined));

  const response = await adminLogin(jsonRequest("/api/admin/login", "POST", { password: "not-a-real-password" }, {
    origin: "http://localhost", "x-real-ip": "203.0.113.9",
  }));
  assert.equal(response.status, 429);
  assert.equal(calls, 1);
});

test("authenticated admin API requests share a Redis limit before reading private data", async (t) => {
  setEnv(t, "NODE_ENV", "test");
  const cookie = adminCookie(t);
  setRateLimitStoreForTests({ consume: async () => ({ count: 121, ttlMs: 30_000 }) });
  t.after(() => setRateLimitStoreForTests(undefined));
  let queries = 0;
  replace(t, db.order, "findMany", async () => { queries += 1; return []; });

  const response = await getAdminOrders(jsonRequest("/api/admin/orders", "GET", undefined, { cookie, "x-real-ip": "203.0.113.10" }));
  assert.equal(response.status, 429);
  assert.equal(queries, 0);
});

test("production rate limiting fails closed when shared Redis is not configured", async (t) => {
  setEnv(t, "NODE_ENV", "production");
  setEnv(t, "REDIS_URL", undefined);
  const response = await enforceRateLimit(new NextRequest("http://localhost/api/products"), RATE_LIMIT_POLICIES.catalog);
  assert.equal(response?.status, 503);
  assert.equal(response?.headers.get("cache-control"), "no-store");
});

test("production rate limiting fails closed when the shared store errors", async (t) => {
  setEnv(t, "NODE_ENV", "production");
  setEnv(t, "AUTH_SECRET", testAuthSecret);
  setEnv(t, "RATE_LIMIT_TRUSTED_IP_HEADER", "x-real-ip");
  setRateLimitStoreForTests({ consume: async () => { throw new Error("simulated Redis outage"); } });
  t.after(() => setRateLimitStoreForTests(undefined));
  const response = await enforceRateLimit(new NextRequest("http://localhost/api/products", { headers: { "x-real-ip": "203.0.113.11" } }), RATE_LIMIT_POLICIES.catalog);
  assert.equal(response?.status, 503);
});

test("checkout rejects oversized JSON before parsing or database access", async (t) => {
  setEnv(t, "NODE_ENV", "test");
  setEnv(t, "NEXT_PUBLIC_STORE_WHATSAPP", "9647000000000");
  let databaseCalls = 0;
  replace(t, db.order, "findUnique", async () => { databaseCalls += 1; return null; });
  const request = jsonRequest("/api/orders", "POST", baseCheckout, {
    origin: "http://localhost", "idempotency-key": checkoutKey1, "content-length": String(16 * 1024 + 1),
  });
  const response = await createOrder(request);
  assert.equal(response.status, 413);
  assert.equal(databaseCalls, 0);
});

test("checkout rejects a streamed JSON body that exceeds its byte limit", async (t) => {
  setEnv(t, "NODE_ENV", "test");
  setEnv(t, "NEXT_PUBLIC_STORE_WHATSAPP", "9647000000000");
  let databaseCalls = 0;
  replace(t, db.order, "findUnique", async () => { databaseCalls += 1; return null; });
  const request = jsonRequest("/api/orders", "POST", { ...baseCheckout, unexpected: "x".repeat(17 * 1024) }, {
    origin: "http://localhost", "idempotency-key": checkoutKey1,
  });
  const response = await createOrder(request);
  assert.equal(response.status, 413);
  assert.equal(databaseCalls, 0);
});

test("checkout aggregates duplicate items and uses database prices", async (t) => {
  setEnv(t, "NEXT_PUBLIC_STORE_WHATSAPP", "9647000000000");
  const state = installCheckoutDatabase(t, [{ id: "p1", slug: "item", name: "Item", priceIqd: 2500, inventory: 5, isPublished: true }]);
  const response = await createOrder(checkoutRequest({
    customerName: "Customer", phone: "٠٧٧٠١٢٣٤٥٦٧", city: "Baghdad", address: "Street 1",
    items: [{ productId: "p1", quantity: 1, priceIqd: 1 }, { productId: "p1", quantity: 2 }],
  }));
  const body = await response.json() as { orderId: string; totalIqd: number; whatsappUrl: string };
  assert.equal(response.status, 201);
  assert.equal(body.totalIqd, 7500);
  const createdOrder = [...state.orders.values()][0];
  assert.equal(createdOrder.totalIqd, 7500);
  assert.deepEqual(createdOrder.lines, [{ productId: "p1", slug: "item", name: "Item", priceIqd: 2500, quantity: 3 }]);
  assert.equal(createdOrder.phone, "07701234567");
  assert.equal(createdOrder.idempotencyKey, checkoutKey1);
  assert.equal(state.products.get("p1")?.inventory, 2);
  assert.equal(new URL(body.whatsappUrl).hostname, "wa.me");
  assert.match(new URL(body.whatsappUrl).searchParams.get("text") || "", /order-1/);
});

test("checkout reports stale stock without creating an order", async (t) => {
  setEnv(t, "NEXT_PUBLIC_STORE_WHATSAPP", "9647000000000");
  const state = installCheckoutDatabase(t, [{ id: "p1", slug: "item", name: "Item", priceIqd: 2500, inventory: 0, isPublished: true }]);
  const response = await createOrder(checkoutRequest());
  assert.equal(response.status, 409);
  assert.equal(state.orders.size, 0);
});

test("retrying the same idempotency key returns the previous order and reserves once", async (t) => {
  setEnv(t, "NEXT_PUBLIC_STORE_WHATSAPP", "9647000000000");
  const state = installCheckoutDatabase(t, [{ id: "p1", slug: "item", name: "Item", priceIqd: 2500, inventory: 4, isPublished: true }]);
  const first = await createOrder(checkoutRequest());
  const second = await createOrder(checkoutRequest());
  const firstBody = await first.json() as { orderId: string; totalIqd: number; whatsappUrl: string };
  const secondBody = await second.json() as { orderId: string; totalIqd: number; whatsappUrl: string };

  assert.equal(first.status, 201);
  assert.equal(second.status, 200);
  assert.equal(second.headers.get("idempotency-replayed"), "true");
  assert.deepEqual(secondBody, firstBody);
  assert.equal(state.orders.size, 1);
  assert.equal(state.products.get("p1")?.inventory, 3);
});

test("the same idempotency key with different data is rejected", async (t) => {
  setEnv(t, "NEXT_PUBLIC_STORE_WHATSAPP", "9647000000000");
  const state = installCheckoutDatabase(t, [{ id: "p1", slug: "item", name: "Item", priceIqd: 2500, inventory: 4, isPublished: true }]);
  await createOrder(checkoutRequest());
  const response = await createOrder(checkoutRequest({ ...baseCheckout, address: "Different street" }));
  const body = await response.json() as { code: string };

  assert.equal(response.status, 409);
  assert.equal(body.code, "IDEMPOTENCY_KEY_REUSED");
  assert.equal(state.orders.size, 1);
  assert.equal(state.products.get("p1")?.inventory, 3);
});

test("different idempotency keys create independent orders when stock is available", async (t) => {
  setEnv(t, "NEXT_PUBLIC_STORE_WHATSAPP", "9647000000000");
  const state = installCheckoutDatabase(t, [{ id: "p1", slug: "item", name: "Item", priceIqd: 2500, inventory: 2, isPublished: true }]);
  const first = await createOrder(checkoutRequest(baseCheckout, checkoutKey1));
  const second = await createOrder(checkoutRequest(baseCheckout, checkoutKey2));

  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.equal(state.orders.size, 2);
  assert.equal(state.products.get("p1")?.inventory, 0);
});

test("concurrent requests with one key create one order and roll back the losing reservation", async (t) => {
  setEnv(t, "NEXT_PUBLIC_STORE_WHATSAPP", "9647000000000");
  const state = installCheckoutDatabase(t, [{ id: "p1", slug: "item", name: "Item", priceIqd: 2500, inventory: 3, isPublished: true }]);
  const [first, second] = await Promise.all([createOrder(checkoutRequest()), createOrder(checkoutRequest())]);
  const bodies = await Promise.all([first.json(), second.json()]) as { orderId: string }[];

  assert.deepEqual([first.status, second.status].sort(), [200, 201]);
  assert.equal(bodies[0].orderId, bodies[1].orderId);
  assert.equal(state.orders.size, 1);
  assert.equal(state.products.get("p1")?.inventory, 2);
});

test("failed multi-product reservation rolls back earlier inventory decrements", async (t) => {
  setEnv(t, "NEXT_PUBLIC_STORE_WHATSAPP", "9647000000000");
  const state = installCheckoutDatabase(t, [
    { id: "p1", slug: "one", name: "One", priceIqd: 1000, inventory: 1, isPublished: true },
    { id: "p2", slug: "two", name: "Two", priceIqd: 1000, inventory: 0, isPublished: true },
  ]);
  const response = await createOrder(checkoutRequest({
    ...baseCheckout,
    items: [{ productId: "p1", quantity: 1 }, { productId: "p2", quantity: 1 }],
  }));

  assert.equal(response.status, 409);
  assert.equal(state.products.get("p1")?.inventory, 1);
  assert.equal(state.products.get("p2")?.inventory, 0);
  assert.equal(state.orders.size, 0);
});

test("order cancellation restores inventory once and does not reopen cancelled orders", async (t) => {
  const cookie = adminCookie(t);
  const order = {
    id: "order-1", status: "PENDING_WHATSAPP",
    lines: [{ productId: "p1", quantity: 2 }, { productId: "p2", quantity: 1 }],
  };
  const restocks: { where: { id: string }; data: { inventory: { increment: number } } }[] = [];
  const tx = {
    order: {
      findUnique: async () => ({ ...order, lines: order.lines }),
      updateMany: async (args: { where: { status: string }; data: { status: string } }) => {
        if (args.where.status !== order.status) return { count: 0 };
        order.status = args.data.status;
        return { count: 1 };
      },
      findUniqueOrThrow: async () => ({ ...order }),
    },
    product: {
      update: async (args: typeof restocks[number]) => { restocks.push(args); return {}; },
    },
  };
  replace(t, db, "$transaction", async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx));

  const first = await updateOrder(jsonRequest("/api/admin/orders/order-1", "PATCH", { status: "CANCELLED" }, { cookie }), { params: Promise.resolve({ orderId: "order-1" }) });
  assert.equal(first.status, 200);
  assert.equal(order.status, "CANCELLED");
  assert.deepEqual(restocks.map((item) => item.data.inventory.increment), [2, 1]);

  const repeated = await updateOrder(jsonRequest("/api/admin/orders/order-1", "PATCH", { status: "CANCELLED" }, { cookie }), { params: Promise.resolve({ orderId: "order-1" }) });
  assert.equal(repeated.status, 200);
  assert.equal(restocks.length, 2);
});

test("order status transitions cannot skip directly from pending to shipped", async (t) => {
  const cookie = adminCookie(t);
  let writes = 0;
  const tx = {
    order: {
      findUnique: async () => ({ id: "order-1", status: "PENDING_WHATSAPP", lines: [] }),
      updateMany: async () => { writes += 1; return { count: 1 }; },
      findUniqueOrThrow: async () => ({ id: "order-1", status: "SHIPPED" }),
    },
    product: { update: async () => ({}) },
  };
  replace(t, db, "$transaction", async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx));

  const response = await updateOrder(jsonRequest("/api/admin/orders/order-1", "PATCH", { status: "SHIPPED" }, { cookie }), { params: Promise.resolve({ orderId: "order-1" }) });
  assert.equal(response.status, 409);
  assert.equal(writes, 0);
});

test("expired orders cannot be manually reopened", async (t) => {
  const cookie = adminCookie(t);
  let writes = 0;
  const tx = {
    order: {
      findUnique: async () => ({ id: "order-1", status: "EXPIRED", lines: [{ productId: "p1", quantity: 1 }] }),
      updateMany: async () => { writes += 1; return { count: 1 }; },
      findUniqueOrThrow: async () => ({ id: "order-1", status: "CONFIRMED" }),
    },
    product: { update: async () => ({}) },
  };
  replace(t, db, "$transaction", async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx));

  const response = await updateOrder(jsonRequest("/api/admin/orders/order-1", "PATCH", { status: "CONFIRMED" }, { cookie }), { params: Promise.resolve({ orderId: "order-1" }) });
  assert.equal(response.status, 409);
  assert.equal(writes, 0);
});

test("admin action after the reservation deadline expires and restores a still-pending order", async (t) => {
  const cookie = adminCookie(t);
  const order = {
    id: "order-expired-by-admin", status: "PENDING_WHATSAPP",
    createdAt: new Date(Date.now() - ORDER_RESERVATION_MS - 1),
    lines: [{ productId: "p1", quantity: 2 }],
  };
  let inventory = 0;
  const tx = {
    order: {
      findUnique: async () => ({ ...order }),
      updateMany: async (args: { where: { id: string; status: string; createdAt: { lt: Date } }; data: { status: string } }) => {
        if (args.where.id !== order.id || args.where.status !== order.status || order.createdAt >= args.where.createdAt.lt) return { count: 0 };
        order.status = args.data.status;
        return { count: 1 };
      },
      findUniqueOrThrow: async () => ({ ...order }),
    },
    product: {
      update: async (args: { where: { id: string }; data: { inventory: { increment: number } } }) => {
        inventory += args.data.inventory.increment;
        return {};
      },
    },
  };
  replace(t, db, "$transaction", async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx));

  const response = await updateOrder(jsonRequest("/api/admin/orders/order-expired-by-admin", "PATCH", { status: "CONFIRMED" }, { cookie }), { params: Promise.resolve({ orderId: order.id }) });
  assert.equal(response.status, 409);
  assert.equal((await response.json() as { code: string }).code, "ORDER_RESERVATION_EXPIRED");
  assert.equal(order.status, "EXPIRED");
  assert.equal(inventory, 2);
});

test("admin status control renders expired as a terminal, inventory-restored state", () => {
  const markup = renderToStaticMarkup(createElement(AdminOrderStatus, { status: "EXPIRED", onChange: () => undefined }));
  assert.match(markup, /انتهى حجز المخزون/);
  assert.match(markup, /<select[^>]*disabled/);
});

test("image upload rejects a false PNG signature before object storage", async (t) => {
  const cookie = adminCookie(t);
  replace(t, db.product, "findUnique", async () => ({ id: "p1" }));
  const form = new FormData();
  form.append("image", new File([new Uint8Array(64)], "fake.png", { type: "image/png" }));
  const request = new NextRequest("http://localhost/api/admin/products/p1/image", {
    method: "POST", headers: { cookie }, body: form,
  });

  const response = await uploadProductImage(request, { params: Promise.resolve({ productId: "p1" }) });
  assert.equal(response.status, 400);
});

test("3D generation fails closed when Redis is not configured", async (t) => {
  const cookie = adminCookie(t);
  setEnv(t, "REDIS_URL", undefined);
  let databaseCalls = 0;
  replace(t, db.product, "findUnique", async () => { databaseCalls += 1; return null; });
  const response = await generate3d(jsonRequest("/api/admin/products/p1/generate-3d", "POST", undefined, { cookie }), { params: Promise.resolve({ productId: "p1" }) });
  assert.equal(response.status, 503);
  assert.equal(databaseCalls, 0);
});

test("3D generation fails closed when S3 settings are absent", async (t) => {
  const cookie = adminCookie(t);
  setEnv(t, "REDIS_URL", "redis://127.0.0.1:1/test-only");
  setRateLimitStoreForTests({ consume: async () => ({ count: 1, ttlMs: 60_000 }) });
  t.after(() => setRateLimitStoreForTests(undefined));
  for (const key of ["S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "S3_ENDPOINT"]) setEnv(t, key, undefined);
  let databaseCalls = 0;
  replace(t, db.product, "findUnique", async () => { databaseCalls += 1; return null; });
  const response = await generate3d(jsonRequest("/api/admin/products/p1/generate-3d", "POST", undefined, { cookie }), { params: Promise.resolve({ productId: "p1" }) });
  assert.equal(response.status, 503);
  assert.equal(databaseCalls, 0);
});

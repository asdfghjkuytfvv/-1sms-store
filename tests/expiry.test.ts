import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { NextRequest } from "next/server";
import { db } from "../lib/db";
import { expirePendingOrders, ORDER_RESERVATION_MS } from "../lib/orders/expire-pending";
import { GET as runExpiryGet, POST as runExpiry } from "../app/api/cron/expire-orders/route";

type FakeOrder = { id: string; status: string; createdAt: Date; lines: unknown };
type FakeProduct = { id: string; inventory: number };

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

function installExpiryDatabase(t: TestContext, seed: { orders: FakeOrder[]; products: FakeProduct[]; failProductId?: string }) {
  const orders = new Map(seed.orders.map((order) => [order.id, { ...order }]));
  const products = new Map(seed.products.map((product) => [product.id, { ...product }]));
  let transactionTail = Promise.resolve();
  let transactionCount = 0;

  replace(t, db.order, "findMany", async (args: { where: { status: string; createdAt: { lt: Date } }; take: number }) =>
    [...orders.values()]
      .filter((order) => order.status === args.where.status && order.createdAt < args.where.createdAt.lt)
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())
      .slice(0, args.take)
      .map(({ id, lines }) => ({ id, lines })));

  replace(t, db, "$transaction", async (callback: (transaction: unknown) => Promise<unknown>) => {
    const previous = transactionTail;
    let release = () => {};
    transactionTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    transactionCount += 1;
    const originalStatuses = new Map([...orders].map(([id, order]) => [id, order.status]));
    const originalInventory = new Map([...products].map(([id, product]) => [id, product.inventory]));
    const tx = {
      order: {
        updateMany: async (args: { where: { id: string; status: string; createdAt: { lt: Date } }; data: { status: string } }) => {
          const order = orders.get(args.where.id);
          if (!order || order.status !== args.where.status || order.createdAt >= args.where.createdAt.lt) return { count: 0 };
          order.status = args.data.status;
          return { count: 1 };
        },
      },
      product: {
        update: async (args: { where: { id: string }; data: { inventory: { increment: number } } }) => {
          if (args.where.id === seed.failProductId) throw new Error("Simulated inventory write failure");
          const product = products.get(args.where.id);
          if (!product) throw new Error("Product is missing");
          product.inventory += args.data.inventory.increment;
          return product;
        },
      },
    };

    try {
      return await callback(tx);
    } catch (error) {
      for (const [id, status] of originalStatuses) {
        const order = orders.get(id);
        if (order) order.status = status;
      }
      for (const [id, inventory] of originalInventory) {
        const product = products.get(id);
        if (product) product.inventory = inventory;
      }
      throw error;
    } finally {
      release();
    }
  });

  return { orders, products, get transactionCount() { return transactionCount; } };
}

function pendingOrder(now: Date, ageMs = ORDER_RESERVATION_MS + 1): FakeOrder {
  return {
    id: "order-expire-1",
    status: "PENDING_WHATSAPP",
    createdAt: new Date(now.getTime() - ageMs),
    lines: [{ productId: "p1", quantity: 2 }],
  };
}

test("pending order older than 30 minutes expires and restores stock once", async (t) => {
  const now = new Date("2026-11-11T12:00:00.000Z");
  const state = installExpiryDatabase(t, { orders: [pendingOrder(now)], products: [{ id: "p1", inventory: 0 }] });

  const first = await expirePendingOrders(now);
  const second = await expirePendingOrders(now);
  assert.equal(first.expired, 1);
  assert.equal(second.expired, 0);
  assert.equal(state.orders.get("order-expire-1")?.status, "EXPIRED");
  assert.equal(state.products.get("p1")?.inventory, 2);
});

test("pending order younger than 30 minutes does not expire", async (t) => {
  const now = new Date("2026-11-11T12:00:00.000Z");
  const state = installExpiryDatabase(t, {
    orders: [pendingOrder(now, ORDER_RESERVATION_MS - 1)],
    products: [{ id: "p1", inventory: 0 }],
  });
  const result = await expirePendingOrders(now);
  assert.equal(result.checked, 0);
  assert.equal(state.orders.get("order-expire-1")?.status, "PENDING_WHATSAPP");
  assert.equal(state.products.get("p1")?.inventory, 0);
});

test("confirmed orders do not expire or restore inventory", async (t) => {
  const now = new Date("2026-11-11T12:00:00.000Z");
  const state = installExpiryDatabase(t, {
    orders: [{ ...pendingOrder(now), status: "CONFIRMED" }],
    products: [{ id: "p1", inventory: 0 }],
  });
  const result = await expirePendingOrders(now);
  assert.equal(result.checked, 0);
  assert.equal(state.orders.get("order-expire-1")?.status, "CONFIRMED");
  assert.equal(state.products.get("p1")?.inventory, 0);
});

test("cancelled orders are ignored and an expired order is never restocked twice", async (t) => {
  const now = new Date("2026-11-11T12:00:00.000Z");
  const state = installExpiryDatabase(t, {
    orders: [
      { ...pendingOrder(now), id: "order-cancelled", status: "CANCELLED" },
      { ...pendingOrder(now), id: "order-already-expired", status: "EXPIRED" },
    ],
    products: [{ id: "p1", inventory: 2 }],
  });
  const result = await expirePendingOrders(now);
  assert.equal(result.checked, 0);
  assert.equal(state.products.get("p1")?.inventory, 2);
});

test("exactly 30 minutes is not expired because expiry requires older than the cutoff", async (t) => {
  const now = new Date("2026-11-11T12:00:00.000Z");
  const state = installExpiryDatabase(t, {
    orders: [pendingOrder(now, ORDER_RESERVATION_MS)],
    products: [{ id: "p1", inventory: 0 }],
  });
  const result = await expirePendingOrders(now);
  assert.equal(result.checked, 0);
  assert.equal(state.orders.get("order-expire-1")?.status, "PENDING_WHATSAPP");
});

test("concurrent expiry calls claim a pending order once and restore stock once", async (t) => {
  const now = new Date("2026-11-11T12:00:00.000Z");
  const state = installExpiryDatabase(t, { orders: [pendingOrder(now)], products: [{ id: "p1", inventory: 0 }] });
  const [first, second] = await Promise.all([expirePendingOrders(now), expirePendingOrders(now)]);

  assert.equal(first.expired + second.expired, 1);
  assert.equal(first.skipped + second.skipped, 1);
  assert.equal(state.orders.get("order-expire-1")?.status, "EXPIRED");
  assert.equal(state.products.get("p1")?.inventory, 2);
  assert.equal(state.transactionCount, 2);
});

test("a failed stock restoration rolls back the status change and prior increments", async (t) => {
  const now = new Date("2026-11-11T12:00:00.000Z");
  const order = pendingOrder(now);
  order.lines = [{ productId: "p1", quantity: 2 }, { productId: "missing", quantity: 1 }];
  const state = installExpiryDatabase(t, {
    orders: [order],
    products: [{ id: "p1", inventory: 0 }],
    failProductId: "missing",
  });
  replace(t, console, "error", () => undefined);

  const result = await expirePendingOrders(now);
  assert.equal(result.failed, 1);
  assert.equal(state.orders.get("order-expire-1")?.status, "PENDING_WHATSAPP");
  assert.equal(state.products.get("p1")?.inventory, 0);
});

test("scheduled expiry endpoint requires its bearer secret before querying orders", async (t) => {
  setEnv(t, "ORDER_EXPIRY_CRON_SECRET", undefined);
  let queries = 0;
  replace(t, db.order, "findMany", async () => { queries += 1; return []; });

  const request = new NextRequest("http://localhost/api/cron/expire-orders", { method: "POST" });
  const response = await runExpiry(request);
  assert.equal(response.status, 503);
  assert.equal(queries, 0);
});

test("scheduled expiry endpoint rejects request bodies before querying orders", async (t) => {
  setEnv(t, "ORDER_EXPIRY_CRON_SECRET", "test-expiry-secret-that-is-at-least-32-chars");
  let queries = 0;
  replace(t, db.order, "findMany", async () => { queries += 1; return []; });
  const request = new NextRequest("http://localhost/api/cron/expire-orders", {
    method: "POST", headers: { authorization: "Bearer test-expiry-secret-that-is-at-least-32-chars" }, body: "unexpected",
  });
  const response = await runExpiry(request);
  assert.equal(response.status, 413);
  assert.equal(queries, 0);
});

test("scheduled expiry endpoint rejects a wrong bearer secret", async (t) => {
  setEnv(t, "ORDER_EXPIRY_CRON_SECRET", "test-expiry-secret-that-is-at-least-32-chars");
  let queries = 0;
  replace(t, db.order, "findMany", async () => { queries += 1; return []; });

  const request = new NextRequest("http://localhost/api/cron/expire-orders", {
    method: "POST", headers: { authorization: "Bearer wrong-secret" },
  });
  const response = await runExpiry(request);
  assert.equal(response.status, 401);
  assert.equal(queries, 0);
});

test("scheduled expiry endpoint runs with a valid server-side bearer secret", async (t) => {
  setEnv(t, "ORDER_EXPIRY_CRON_SECRET", "test-expiry-secret-that-is-at-least-32-chars");
  replace(t, db.order, "findMany", async () => []);
  const request = new NextRequest("http://localhost/api/cron/expire-orders", {
    method: "POST", headers: { authorization: "Bearer test-expiry-secret-that-is-at-least-32-chars" },
  });

  const response = await runExpiry(request);
  assert.equal(response.status, 200);
  assert.equal((await response.json() as { checked: number }).checked, 0);
});

test("scheduled expiry GET rejects an invalid bearer secret before querying orders", async (t) => {
  setEnv(t, "ORDER_EXPIRY_CRON_SECRET", "test-expiry-secret-that-is-at-least-32-chars");
  setEnv(t, "CRON_SECRET", undefined);
  let queries = 0;
  replace(t, db.order, "findMany", async () => { queries += 1; return []; });

  const request = new NextRequest("http://localhost/api/cron/expire-orders", {
    method: "GET", headers: { authorization: "Bearer wrong-secret" },
  });
  const response = await runExpiryGet(request);
  assert.equal(response.status, 401);
  assert.equal(queries, 0);
});

test("scheduled expiry GET accepts Vercel CRON_SECRET and runs the expiry check", async (t) => {
  setEnv(t, "ORDER_EXPIRY_CRON_SECRET", undefined);
  setEnv(t, "CRON_SECRET", "vercel-expiry-secret-that-is-at-least-32-chars");
  let queries = 0;
  replace(t, db.order, "findMany", async () => { queries += 1; return []; });

  const request = new NextRequest("http://localhost/api/cron/expire-orders", {
    method: "GET", headers: { authorization: "Bearer vercel-expiry-secret-that-is-at-least-32-chars" },
  });
  const response = await runExpiryGet(request);
  assert.equal(response.status, 200);
  assert.equal(queries, 1);
});

test("scheduled expiry fails closed when Vercel and scheduler secrets disagree", async (t) => {
  setEnv(t, "ORDER_EXPIRY_CRON_SECRET", "scheduler-expiry-secret-that-is-at-least-32-chars");
  setEnv(t, "CRON_SECRET", "vercel-expiry-secret-that-is-at-least-32-chars");
  let queries = 0;
  replace(t, db.order, "findMany", async () => { queries += 1; return []; });

  const request = new NextRequest("http://localhost/api/cron/expire-orders", {
    method: "GET", headers: { authorization: "Bearer vercel-expiry-secret-that-is-at-least-32-chars" },
  });
  const response = await runExpiryGet(request);
  assert.equal(response.status, 503);
  assert.equal(queries, 0);
});

import { createHmac } from "node:crypto";
import { isIP } from "node:net";
import { NextRequest, NextResponse } from "next/server";
import Redis from "ioredis";
import { requireAdminRequest } from "@/lib/auth/admin";

export type RateLimitPolicy = { name: string; limit: number; windowMs: number };
export type RateLimitStore = { consume(key: string, windowMs: number): Promise<{ count: number; ttlMs: number }> };

export const RATE_LIMIT_POLICIES = {
  catalog: { name: "catalog", limit: 120, windowMs: 60_000 },
  checkout: { name: "checkout", limit: 5, windowMs: 10 * 60_000 },
  adminLogin: { name: "admin-login", limit: 5, windowMs: 15 * 60_000 },
  adminApi: { name: "admin-api", limit: 120, windowMs: 60_000 },
  adminImageUpload: { name: "admin-image-upload", limit: 15, windowMs: 60 * 60_000 },
  admin3d: { name: "admin-3d", limit: 3, windowMs: 60 * 60_000 },
} satisfies Record<string, RateLimitPolicy>;

const trustedIpHeaders = new Set(["x-real-ip", "cf-connecting-ip", "x-forwarded-for"]);
const incrementWindowScript = `
local count = redis.call('INCR', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if count == 1 or ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
ttl = redis.call('PTTL', KEYS[1])
return { count, ttl }
`;

let redisStore: RateLimitStore | undefined;
let testStore: RateLimitStore | null | undefined;

class RedisRateLimitStore implements RateLimitStore {
  private readonly client: Redis;

  constructor(url: string) {
    this.client = new Redis(url, {
      lazyConnect: true,
      connectTimeout: 1500,
      maxRetriesPerRequest: 1,
      // Queue the first atomic command while lazyConnect establishes the shared Redis connection.
      enableOfflineQueue: true,
      retryStrategy: () => null,
    });
    this.client.on("error", () => {
      // Command failures are returned to the caller, which fails closed; avoid logging Redis URLs.
    });
  }

  async consume(key: string, windowMs: number) {
    const result = await this.client.eval(incrementWindowScript, 1, key, String(windowMs)) as number[];
    return { count: Number(result[0]), ttlMs: Math.max(0, Number(result[1])) };
  }
}

async function consumeWithTimeout(store: RateLimitStore, key: string, windowMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      store.consume(key, windowMs),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Rate-limit store timeout.")), 2500);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function setRateLimitStoreForTests(store: RateLimitStore | null | undefined) {
  testStore = store;
}

function getClientAddress(request: NextRequest) {
  const configuredHeader = process.env.RATE_LIMIT_TRUSTED_IP_HEADER?.toLowerCase();
  if (process.env.NODE_ENV === "production") {
    if (!configuredHeader || !trustedIpHeaders.has(configuredHeader)) throw new Error("RATE_LIMIT_TRUSTED_IP_HEADER is not configured.");
    const address = request.headers.get(configuredHeader)?.trim() || "";
    if (!isIP(address)) throw new Error("Trusted client IP is missing or invalid.");
    return address;
  }

  if (configuredHeader && trustedIpHeaders.has(configuredHeader)) {
    const address = request.headers.get(configuredHeader)?.trim() || "";
    if (isIP(address)) return address;
  }
  for (const header of ["x-real-ip", "cf-connecting-ip", "x-forwarded-for"]) {
    const address = request.headers.get(header)?.trim() || "";
    if (isIP(address)) return address;
  }
  return "local-development";
}

function getStore() {
  if (testStore !== undefined) return testStore;
  const url = process.env.REDIS_URL;
  if (!url) return null;
  redisStore ??= new RedisRateLimitStore(url);
  return redisStore;
}

function unavailable() {
  return NextResponse.json({ error: "الحماية من تكرار الطلبات غير متاحة مؤقتاً. حاول بعد قليل." }, {
    status: 503,
    headers: { "Cache-Control": "no-store", "Retry-After": "5" },
  });
}

export async function enforceRateLimit(request: NextRequest, policy: RateLimitPolicy): Promise<NextResponse | null> {
  let store: RateLimitStore | null;
  try {
    store = getStore();
  } catch {
    return unavailable();
  }
  if (!store) return process.env.NODE_ENV === "production" ? unavailable() : null;

  const secret = process.env.AUTH_SECRET;
  if (process.env.NODE_ENV === "production" && (!secret || secret.length < 32)) return unavailable();

  try {
    const address = getClientAddress(request);
    const keySecret = secret && secret.length >= 32 ? secret : "development-only-rate-limit-key";
    const addressHash = createHmac("sha256", keySecret).update(address).digest("hex");
    const key = `1sms:ratelimit:v1:${policy.name}:${addressHash}`;
    const { count, ttlMs } = await consumeWithTimeout(store, key, policy.windowMs);
    if (count <= policy.limit) return null;
    return NextResponse.json({ error: "تجاوزت عدد المحاولات المسموح. انتظر قليلاً ثم أعد المحاولة." }, {
      status: 429,
      headers: {
        "Cache-Control": "no-store",
        "Retry-After": String(Math.max(1, Math.ceil(ttlMs / 1000))),
        "RateLimit-Limit": String(policy.limit),
        "RateLimit-Remaining": "0",
      },
    });
  } catch {
    // The production path fails closed if the shared limiter cannot run.
    return unavailable();
  }
}

export async function authorizeAdminRequest(request: NextRequest, policy = RATE_LIMIT_POLICIES.adminApi) {
  if (!requireAdminRequest(request)) {
    return NextResponse.json({ error: "غير مصرح بالدخول." }, { status: 401, headers: { "Cache-Control": "no-store" } });
  }
  return enforceRateLimit(request, policy);
}

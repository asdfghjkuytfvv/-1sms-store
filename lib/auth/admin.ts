import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import type { NextRequest } from "next/server";

const COOKIE = "sms_admin";
const ttlSeconds = 60 * 60 * 8;

function signature(expires: string) {
  const secret = process.env.AUTH_SECRET;
  if (!secret || secret.length < 32) throw new Error("AUTH_SECRET must be at least 32 characters.");
  return createHmac("sha256", secret).update(`1sms-admin:${expires}`).digest("hex");
}

export function createAdminSession() {
  const expires = String(Math.floor(Date.now() / 1000) + ttlSeconds);
  return `${expires}.${signature(expires)}`;
}

export function isValidAdminSession(value?: string) {
  if (!value) return false;
  const [expires, supplied] = value.split(".");
  if (!expires || !supplied || Number(expires) < Math.floor(Date.now() / 1000)) return false;
  const expected = signature(expires);
  const a = Buffer.from(supplied, "hex");
  const b = Buffer.from(expected, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function requireAdminPage() {
  const jar = await cookies();
  if (!isValidAdminSession(jar.get(COOKIE)?.value)) {
    return false;
  }
  return true;
}

export function requireAdminRequest(request: NextRequest) {
  return isValidAdminSession(request.cookies.get(COOKIE)?.value);
}

export const adminCookieName = COOKIE;
export const adminCookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "strict" as const,
  path: "/",
  maxAge: ttlSeconds,
};

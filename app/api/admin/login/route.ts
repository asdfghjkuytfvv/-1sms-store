import { NextRequest, NextResponse } from "next/server";
import { scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { z } from "zod";
import { createAdminSession, adminCookieName, adminCookieOptions } from "@/lib/auth/admin";
import { enforceRateLimit, RATE_LIMIT_POLICIES } from "@/lib/security/rate-limit";
import { hasSameOrigin, readJsonBody } from "@/lib/http/request-body";

export const runtime = "nodejs";
const scrypt = promisify(scryptCb);

export async function POST(request: NextRequest) {
  if (!hasSameOrigin(request)) return NextResponse.json({ error: "Invalid origin." }, { status: 403, headers: { "Cache-Control": "no-store" } });
  const limited = await enforceRateLimit(request, RATE_LIMIT_POLICIES.adminLogin);
  if (limited) return limited;
  const body = await readJsonBody(request, 2 * 1024);
  if (!body.ok) return NextResponse.json({ error: body.error }, { status: body.status, headers: { "Cache-Control": "no-store" } });
  const parsed = z.object({ password: z.string().min(1).max(256) }).strict().safeParse(body.value);
  if (!parsed.success) return NextResponse.json({ error: "بيانات الدخول غير صالحة." }, { status: 400, headers: { "Cache-Control": "no-store" } });
  const { password } = parsed.data;
  const salt = process.env.ADMIN_PASSWORD_SALT;
  const expectedHex = process.env.ADMIN_PASSWORD_HASH;
  if (!salt || !expectedHex || !process.env.AUTH_SECRET || process.env.AUTH_SECRET.length < 32 || typeof password !== "string" || password.length < 1) {
    return NextResponse.json({ error: "Admin login is not configured." }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  const actual = Buffer.from(await scrypt(password, salt, 64) as Buffer);
  const expected = Buffer.from(expectedHex, "hex");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return NextResponse.json({ error: "كلمة المرور غير صحيحة." }, { status: 401, headers: { "Cache-Control": "no-store" } });
  }
  const response = NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  response.cookies.set(adminCookieName, createAdminSession(), adminCookieOptions);
  return response;
}

export async function DELETE(request: NextRequest) {
  if (!hasSameOrigin(request)) return NextResponse.json({ error: "Invalid origin." }, { status: 403, headers: { "Cache-Control": "no-store" } });
  const response = NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  response.cookies.set(adminCookieName, "", { ...adminCookieOptions, maxAge: 0 });
  return response;
}

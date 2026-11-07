import { NextRequest, NextResponse } from "next/server";
import { scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { createAdminSession, adminCookieName, adminCookieOptions } from "@/lib/auth/admin";

export const runtime = "nodejs";
const scrypt = promisify(scryptCb);

export async function POST(request: NextRequest) {
  const origin = request.headers.get("origin");
  if (origin && new URL(origin).host !== request.headers.get("host")) {
    return NextResponse.json({ error: "Invalid origin." }, { status: 403 });
  }
  const { password } = await request.json().catch(() => ({ password: "" }));
  const salt = process.env.ADMIN_PASSWORD_SALT;
  const expectedHex = process.env.ADMIN_PASSWORD_HASH;
  if (!salt || !expectedHex || typeof password !== "string" || password.length < 1) {
    return NextResponse.json({ error: "Admin login is not configured." }, { status: 503 });
  }
  const actual = Buffer.from(await scrypt(password, salt, 64) as Buffer);
  const expected = Buffer.from(expectedHex, "hex");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return NextResponse.json({ error: "كلمة المرور غير صحيحة." }, { status: 401 });
  }
  const response = NextResponse.json({ ok: true });
  response.cookies.set(adminCookieName, createAdminSession(), adminCookieOptions);
  return response;
}

export async function DELETE() {
  const response = NextResponse.json({ ok: true });
  response.cookies.set(adminCookieName, "", { ...adminCookieOptions, maxAge: 0 });
  return response;
}

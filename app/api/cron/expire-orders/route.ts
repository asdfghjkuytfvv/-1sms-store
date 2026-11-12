import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { expirePendingOrders } from "@/lib/orders/expire-pending";
import { rejectUnexpectedRequestBody } from "@/lib/http/request-body";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function hasValidBearerToken(header: string | null, expected: string) {
  if (!header) return false;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return false;
  const supplied = Buffer.from(match[1]);
  const configured = Buffer.from(expected);
  return supplied.length === configured.length && timingSafeEqual(supplied, configured);
}

function configuredCronSecret() {
  const schedulerSecret = process.env.ORDER_EXPIRY_CRON_SECRET;
  const vercelSecret = process.env.CRON_SECRET;
  if (schedulerSecret && vercelSecret && schedulerSecret !== vercelSecret) return null;

  const secret = vercelSecret || schedulerSecret;
  if (!secret || Buffer.byteLength(secret) < 32) return null;
  return secret;
}

async function handleExpiryRequest(request: NextRequest) {
  const bodyError = await rejectUnexpectedRequestBody(request);
  if (bodyError) return NextResponse.json({ error: bodyError.error }, { status: bodyError.status, headers: { "Cache-Control": "no-store" } });
  const secret = configuredCronSecret();
  if (!secret) {
    return NextResponse.json({ error: "خدمة انتهاء حجوزات الطلبات غير مهيأة." }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  if (!hasValidBearerToken(request.headers.get("authorization"), secret)) {
    return NextResponse.json({ error: "غير مصرح بالدخول." }, { status: 401, headers: { "Cache-Control": "no-store" } });
  }

  const result = await expirePendingOrders();
  return NextResponse.json(result, {
    status: result.failed > 0 ? 500 : 200,
    headers: { "Cache-Control": "no-store" },
  });
}

export async function GET(request: NextRequest) {
  return handleExpiryRequest(request);
}

export async function POST(request: NextRequest) {
  return handleExpiryRequest(request);
}

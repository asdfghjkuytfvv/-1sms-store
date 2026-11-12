import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { authorizeAdminRequest } from "@/lib/security/rate-limit";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const denied = await authorizeAdminRequest(request);
  if (denied) return denied;
  const orders = await db.order.findMany({
    orderBy: { createdAt: "desc" },
    take: 100,
    select: { id: true, customerName: true, phone: true, address: true, city: true, totalIqd: true, lines: true, status: true, createdAt: true },
  });
  return NextResponse.json(orders, { headers: { "Cache-Control": "no-store" } });
}

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { enforceRateLimit, RATE_LIMIT_POLICIES } from "@/lib/security/rate-limit";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const limited = await enforceRateLimit(request, RATE_LIMIT_POLICIES.catalog);
  if (limited) return limited;
  const products = await db.product.findMany({
    where: { isPublished: true },
    orderBy: { createdAt: "desc" },
    take: 100,
    select: {
      id: true, slug: true, name: true, description: true, category: true,
      priceIqd: true, inventory: true, imageUrl: true, modelUrl: true, modelStatus: true,
    },
  });
  return NextResponse.json(products, {
    headers: { "Cache-Control": "public, s-maxage=30, stale-while-revalidate=120" },
  });
}

import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  const products = await db.product.findMany({
    where: { isPublished: true },
    orderBy: { createdAt: "desc" },
    select: {
      id: true, slug: true, name: true, description: true, category: true,
      priceIqd: true, inventory: true, imageUrl: true, modelUrl: true, modelStatus: true,
    },
  });
  return NextResponse.json(products, {
    headers: { "Cache-Control": "public, s-maxage=30, stale-while-revalidate=120" },
  });
}

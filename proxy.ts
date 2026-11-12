import { NextRequest, NextResponse } from "next/server";
import { enforceRateLimit, RATE_LIMIT_POLICIES } from "@/lib/security/rate-limit";

export async function proxy(request: NextRequest) {
  const limited = await enforceRateLimit(request, RATE_LIMIT_POLICIES.catalog);
  return limited || NextResponse.next();
}

export const config = { matcher: ["/"] };

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { authorizeAdminRequest } from "@/lib/security/rate-limit";

export const dynamic = "force-dynamic";

function safeErrorMessage(value: string | null) {
  if (!value) return null;
  return value
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/(?:postgres|postgresql|redis|rediss):\/\/\S+/gi, "[service URL]")
    .replace(/https?:\/\/\S+/gi, "[remote URL]")
    .slice(0, 500);
}

export async function GET(request: NextRequest, context: { params: Promise<{ jobId: string }> }) {
  const denied = await authorizeAdminRequest(request);
  if (denied) return denied;
  const { jobId } = await context.params;
  if (!jobId || jobId.length > 160) return NextResponse.json({ error: "Invalid job ID." }, { status: 400, headers: { "Cache-Control": "no-store" } });
  const job = await db.generationJob.findUnique({
    where: { id: jobId },
    select: { id: true, status: true, progress: true, errorMessage: true, updatedAt: true },
  });
  if (!job) return NextResponse.json({ error: "Job not found." }, { status: 404, headers: { "Cache-Control": "no-store" } });
  return NextResponse.json({ ...job, errorMessage: safeErrorMessage(job.errorMessage) }, { headers: { "Cache-Control": "no-store" } });
}

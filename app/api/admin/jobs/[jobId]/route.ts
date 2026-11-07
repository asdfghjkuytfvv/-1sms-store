import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAdminRequest } from "@/lib/auth/admin";

export async function GET(request: NextRequest, context: { params: Promise<{ jobId: string }> }) {
  if (!requireAdminRequest(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { jobId } = await context.params;
  const job = await db.generationJob.findUnique({
    where: { id: jobId },
    select: { id: true, status: true, progress: true, errorMessage: true, outputModelKey: true, updatedAt: true },
  });
  if (!job) return NextResponse.json({ error: "Job not found." }, { status: 404 });
  return NextResponse.json(job);
}

const BASE = "https://api.meshy.ai/openapi/v1";

type MeshyTask = {
  id: string;
  status: "PENDING" | "IN_PROGRESS" | "SUCCEEDED" | "FAILED" | "CANCELED";
  progress?: number;
  model_urls?: { glb?: string };
  task_error?: { message?: string; [key: string]: unknown } | null;
};

function headers() {
  const key = process.env.MESHY_API_KEY;
  if (!key) throw new Error("MESHY_API_KEY is not configured.");
  return { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
}

export async function createImageTo3DTask(imageUrl: string) {
  const response = await fetch(`${BASE}/image-to-3d`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      image_url: imageUrl,
      ai_model: process.env.MESHY_MODEL || "latest",
      should_texture: true,
      enable_pbr: true,
      should_remesh: true,
      target_formats: ["glb"],
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`Meshy create task failed (${response.status}).`);
  const data = await response.json() as { result?: string };
  if (!data.result) throw new Error("Meshy response did not include a task ID.");
  return data.result;
}

export async function getImageTo3DTask(taskId: string) {
  const response = await fetch(`${BASE}/image-to-3d/${encodeURIComponent(taskId)}`, {
    headers: headers(),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Meshy task lookup failed (${response.status}).`);
  return {
    task: await response.json() as MeshyTask,
    retryAfterSeconds: Number(response.headers.get("retry-after") || 5),
  };
}

import { Worker } from "bullmq";
import { redisConnection } from "../lib/queue";
import { processGeneration } from "./process-3d";

const connection = redisConnection;

if (!connection) {
  throw new Error(
    "REDIS_URL is required to start the 3D worker."
  );
}

const worker = new Worker(
  "product-3d-generation",
  async (job) => {
    return processGeneration(
      job.data.generationJobId as string
    );
  },
  {
    connection,
    concurrency: 2,
    lockDuration: 60_000,
  }
);

worker.on("completed", (job) => {
  console.info(`[3D Worker] Completed: ${job.id}`);
});

worker.on("failed", (job, error) => {
  console.error(
    `[3D Worker] Failed: ${job?.id}`,
    error
  );
});

worker.on("error", (error) => {
  console.error("[3D Worker] Error:", error);
});

let shuttingDown = false;

async function shutdown() {
  if (shuttingDown) return;

  shuttingDown = true;

  try {
    await worker.close();
    await connection.quit();
    console.info("[3D Worker] Shutdown complete.");
  } catch (error) {
    console.error("[3D Worker] Shutdown error:", error);
  } finally {
    process.exit(0);
  }
}

process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);

console.info("[3D Worker] Listening...");

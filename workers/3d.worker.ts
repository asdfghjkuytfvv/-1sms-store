import { Worker } from "bullmq";
import { getRedisConnection } from "../lib/queue";
import { processGeneration } from "./process-3d";

const connection = getRedisConnection();

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
    lockDuration: 60000,
  }
);

worker.on("completed", (job) => {
  console.log("Completed:", job.id);
});

worker.on("failed", (job, error) => {
  console.error("3D job failed:", job?.id, error.name);
});

worker.on("error", (error) => {
  console.error("Worker error:", error);
});

let shuttingDown = false;

async function shutdown() {
  if (shuttingDown) return;

  shuttingDown = true;

  try {
    await worker.close();
    await connection.quit();
    console.log("Worker stopped.");
  } catch (error) {
    console.error("Shutdown error:", error);
    process.exitCode = 1;
    await connection.quit().catch((closeError) => {
      console.error("Redis shutdown error:", closeError);
    });
  }
}

process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);

console.log("3D Worker started.");

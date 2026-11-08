import { Worker } from "bullmq";
import { redisConnection } from "../lib/queue";
import { processGeneration } from "./process-3d";

if (!redisConnection) {
  throw new Error("REDIS_URL is required.");
}

const connection = redisConnection as NonNullable<
  typeof redisConnection
>;

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
  console.error("Failed:", job?.id, error);
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
  }
}

process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);

console.log("3D Worker started.");

import { Worker } from "bullmq";
import { redisConnection } from "../lib/queue";
import { processGeneration } from "./process-3d";

if (!redisConnection) {
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
    connection: redisConnection,
    concurrency: 2,
    lockDuration: 60_000,
  }
);

worker.on("completed", (job) => {
  console.info(`[3d-worker] completed ${job.id}`);
});

worker.on("failed", (job, error) => {
  console.error(
    `[3d-worker] failed ${job?.id}`,
    error
  );
});

worker.on("error", (error) => {
  console.error("[3d-worker] error", error);
});

const shutdown = async () => {
  await worker.close();
  await redisConnection.quit();
  process.exit(0);
};

process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);

console.info("[3d-worker] listening on product-3d-generation");

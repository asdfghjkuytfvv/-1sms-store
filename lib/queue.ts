import { Queue } from "bullmq";
import IORedis from "ioredis";

let connection: IORedis | undefined;
let queue: Queue | undefined;

export function isRedisConfigured() {
  return Boolean(process.env.REDIS_URL);
}

export function getRedisConnection() {
  const url = process.env.REDIS_URL;
  if (!url) throw new Error("REDIS_URL is required for the 3D generation queue.");
  if (!connection) {
    connection = new IORedis(url, { maxRetriesPerRequest: null, enableReadyCheck: true, lazyConnect: true });
    connection.on("error", (error) => {
      console.error("[redis] 3D queue connection error:", error.name);
    });
  }
  return connection;
}

export function getGenerationQueue() {
  queue ??= new Queue("product-3d-generation", {
    connection: getRedisConnection(),
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 5000 },
      removeOnComplete: { age: 60 * 60 * 24 * 7, count: 2000 },
      removeOnFail: { age: 60 * 60 * 24 * 30, count: 5000 },
    },
  });
  return queue;
}

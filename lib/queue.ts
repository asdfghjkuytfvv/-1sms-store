import { Queue } from "bullmq";
import IORedis from "ioredis";

const url = process.env.REDIS_URL;
if (!url) throw new Error("REDIS_URL is required for the 3D generation queue.");

export const redisConnection = new IORedis(url, {
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
});
export const generationQueue = new Queue("product-3d-generation", {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 5000 },
    removeOnComplete: { age: 60 * 60 * 24 * 7, count: 2000 },
    removeOnFail: { age: 60 * 60 * 24 * 30, count: 5000 },
  },
});

import { Queue } from "bullmq";
import IORedis from "ioredis";

const redisUrl = process.env.REDIS_URL;

export const redisConnection: IORedis | null = redisUrl
  ? new IORedis(redisUrl, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
      lazyConnect: true,
    })
  : null;

export const generationQueue: Queue | null = redisConnection
  ? new Queue("product-3d-generation", {
      connection: redisConnection,
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: "exponential",
          delay: 5000,
        },
        removeOnComplete: {
          age: 604800,
          count: 2000,
        },
        removeOnFail: {
          age: 2592000,
          count: 5000,
        },
      },
    })
  : null;

import { Queue, ConnectionOptions } from 'bullmq';
import dotenv from 'dotenv';

dotenv.config();

export const redisConnection: ConnectionOptions = {
  host: process.env.REDIS_HOST || 'redis',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
  password: process.env.REDIS_PASSWORD || undefined,
  maxRetriesPerRequest: null, // Critical requirement for BullMQ
};

export const QUEUE_NAME = 'audio-processing';

// Initialize the queue to add jobs
export const audioQueue = new Queue(QUEUE_NAME, {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 5000, // Wait 5s, then 10s, then 20s
    },
    removeOnComplete: true, // Keep clean
    removeOnFail: false, // Keep for inspection
  },
});

import { config as loadEnv } from 'dotenv';
import { z } from 'zod';
import path from 'path';

loadEnv({ path: path.resolve(process.cwd(), '.env') });

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(8001),
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'http', 'verbose', 'debug', 'silly']).default('info'),

  DATABASE_URL: z.string().min(1),

  REDIS_HOST: z.string().default('127.0.0.1'),
  REDIS_PORT: z.coerce.number().int().positive().default(6379),
  REDIS_PASSWORD: z.string().optional().default(''),

  BULK_CONCURRENCY: z.coerce.number().int().positive().default(5),
  BULK_MAX_ORDERS: z.coerce.number().int().positive().default(100),

  RETRY_MAX_ATTEMPTS: z.coerce.number().int().positive().default(3),
  RETRY_INITIAL_DELAY_MS: z.coerce.number().int().nonnegative().default(200),
  RETRY_MAX_DELAY_MS: z.coerce.number().int().positive().default(3000),
  RETRY_BACKOFF_FACTOR: z.coerce.number().positive().default(2),

  URBANEBOLT_BASE_URL: z.string().url().default('https://uat.urbanebolt.in'),
  URBANEBOLT_USERNAME: z.string().default(''),
  URBANEBOLT_PASSWORD: z.string().default(''),

  MOCK_COURIER_BASE_URL: z.string().default('https://mock-courier.local'),
  MOCK_COURIER_API_KEY: z.string().default('mock-test-key'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error('❌ Invalid environment configuration:', parsed.error.format());
  throw new Error('Invalid environment configuration');
}

export const env = parsed.data;
export type Env = z.infer<typeof envSchema>;

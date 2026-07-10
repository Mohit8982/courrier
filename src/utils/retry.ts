import { logger } from '../config/logger';

export interface RetryOptions {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffFactor: number;
  shouldRetry?: (err: unknown, attempt: number) => boolean;
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
}

const DEFAULT_OPTIONS: RetryOptions = {
  maxAttempts: 3,
  initialDelayMs: 200,
  maxDelayMs: 3000,
  backoffFactor: 2,
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Execute an async function with exponential-backoff retry.
 * By default retries all thrown errors; pass `shouldRetry` to filter.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  overrides: Partial<RetryOptions> = {},
): Promise<T> {
  const opts: RetryOptions = { ...DEFAULT_OPTIONS, ...overrides };

  let attempt = 0;
  let lastError: unknown;

  while (attempt < opts.maxAttempts) {
    attempt += 1;
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const shouldRetry = opts.shouldRetry ? opts.shouldRetry(err, attempt) : true;
      if (!shouldRetry || attempt >= opts.maxAttempts) {
        throw err;
      }

      const rawDelay =
        opts.initialDelayMs * Math.pow(opts.backoffFactor, attempt - 1);
      const delayMs = Math.min(rawDelay, opts.maxDelayMs);

      opts.onRetry?.(err, attempt, delayMs);
      logger.debug('Retrying after failure', {
        attempt,
        maxAttempts: opts.maxAttempts,
        delayMs,
        error: err instanceof Error ? err.message : String(err),
      });

      await sleep(delayMs);
    }
  }

  throw lastError;
}

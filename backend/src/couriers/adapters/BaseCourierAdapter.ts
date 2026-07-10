import { AxiosResponse } from 'axios';
import { HttpClient } from '../../utils/httpClient';
import { withRetry } from '../../utils/retry';
import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { AuthenticationError, CourierAPIError } from '../../errors/AppError';
import { ICourierAdapter } from '../interfaces/ICourierAdapter';

/**
 * BaseCourierAdapter: provides shared behavior
 *  - retry with exponential backoff
 *  - one-time 401 → authenticate() → retry
 *  - auth token caching
 * Subclasses implement courier-specific create/track/cancel + authenticate().
 */
export abstract class BaseCourierAdapter implements ICourierAdapter {
  public abstract readonly courierName: string;
  protected readonly http: HttpClient;

  private cachedToken: string | null = null;

  constructor(http: HttpClient) {
    this.http = http;
  }

  abstract createShipment(input: any): Promise<any>;
  abstract trackShipment(trackingNumber: string, courierOrderId?: string): Promise<any>;
  abstract cancelShipment(input: any): Promise<any>;

  /**
   * Return existing token or fetch a new one via `authenticate()`.
   * Individual couriers override `authenticate()`.
   */
  protected async getAuthToken(forceRefresh = false): Promise<string> {
    if (this.cachedToken && !forceRefresh) return this.cachedToken;
    const token = await this.authenticate();
    this.cachedToken = token;
    return token;
  }

  /**
   * Called on cache miss and on 401. Must return a fresh auth token.
   * MockCourierAdapter can return a static string.
   */
  protected abstract authenticate(): Promise<string>;

  /**
   * Wrap a single courier call with:
   *  - configurable retry+backoff
   *  - single automatic 401 refresh + retry
   * The inner function receives the current auth token.
   */
  protected async executeAuthed<T>(
    operation: string,
    fn: (token: string) => Promise<AxiosResponse<T>>,
  ): Promise<AxiosResponse<T>> {
    const attempt = async (forceRefresh: boolean): Promise<AxiosResponse<T>> => {
      const token = await this.getAuthToken(forceRefresh);
      return fn(token);
    };

    // 1) primary + retry (network/5xx)
    let response: AxiosResponse<T>;
    try {
      response = await withRetry(
        async () => {
          const res = await attempt(false);
          // Treat 5xx as transient so withRetry retries automatically.
          if (res.status >= 500) {
            const err = new Error(`upstream ${res.status}`) as Error & {
              response: { status: number; data: unknown };
            };
            err.response = { status: res.status, data: res.data };
            throw err;
          }
          return res;
        },
        {
          maxAttempts: env.RETRY_MAX_ATTEMPTS,
          initialDelayMs: env.RETRY_INITIAL_DELAY_MS,
          maxDelayMs: env.RETRY_MAX_DELAY_MS,
          backoffFactor: env.RETRY_BACKOFF_FACTOR,
          shouldRetry: (err) => this.isRetryableError(err),
          onRetry: (err, at, delay) =>
            logger.warn('Courier call retrying', {
              courier: this.courierName,
              operation,
              attempt: at,
              delayMs: delay,
              message: (err as Error)?.message,
            }),
        },
      );
    } catch (err) {
      // Distinguish HTTP 5xx exhaustion from real network errors.
      const e = err as { response?: { status?: number; data?: unknown } };
      if (e?.response?.status && e.response.status >= 500) {
        throw new CourierAPIError(
          this.courierName,
          `${operation} failed with status ${e.response.status}`,
          e.response.status,
          e.response.data,
        );
      }
      throw new CourierAPIError(
        this.courierName,
        `Network failure during ${operation}: ${(err as Error).message}`,
      );
    }

    // 2) 401 handling: refresh token once and retry
    if (response.status === 401) {
      logger.info('Courier returned 401; refreshing token and retrying once', {
        courier: this.courierName,
        operation,
      });
      this.cachedToken = null;
      try {
        response = await attempt(true);
      } catch (err) {
        throw new CourierAPIError(
          this.courierName,
          `Retry after 401 failed for ${operation}: ${(err as Error).message}`,
        );
      }
      if (response.status === 401) {
        throw new AuthenticationError(this.courierName, `401 after refresh on ${operation}`);
      }
    }

    return response;
  }

  protected isRetryableError(err: unknown): boolean {
    // Network-level errors from axios: retry.
    // 5xx handled by inspecting response.status in executeAuthed → not here.
    const e = err as { code?: string; response?: { status?: number } };
    if (e?.response?.status && e.response.status >= 500) return true;
    return !e?.response; // no response = network error → retry
  }

  protected ensureOk<T>(res: AxiosResponse<T>, operation: string): T {
    if (res.status >= 200 && res.status < 300) return res.data;
    if (res.status === 401) {
      throw new AuthenticationError(this.courierName, `Unauthorized on ${operation}`);
    }
    throw new CourierAPIError(
      this.courierName,
      `${operation} failed with status ${res.status}`,
      res.status,
      res.data,
    );
  }

  /** For tests. */
  public _clearAuthCache(): void {
    this.cachedToken = null;
  }
}

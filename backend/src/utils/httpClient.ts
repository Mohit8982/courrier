import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse, AxiosError } from 'axios';
import { logger } from '../config/logger';

export interface HttpClientOptions {
  baseURL: string;
  timeoutMs?: number;
  defaultHeaders?: Record<string, string>;
}

/**
 * Thin Axios wrapper. Provides consistent logging and lets callers
 * plug in retry logic (see utils/retry.ts) at a higher layer.
 */
export class HttpClient {
  private readonly instance: AxiosInstance;

  constructor(opts: HttpClientOptions) {
    this.instance = axios.create({
      baseURL: opts.baseURL,
      timeout: opts.timeoutMs ?? 15000,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(opts.defaultHeaders ?? {}),
      },
      validateStatus: () => true, // never throw on non-2xx; we inspect ourselves
    });
  }

  async request<T = unknown>(config: AxiosRequestConfig): Promise<AxiosResponse<T>> {
    const started = Date.now();
    try {
      const res = await this.instance.request<T>(config);
      logger.debug('HTTP request completed', {
        method: config.method,
        url: config.url,
        status: res.status,
        durationMs: Date.now() - started,
      });
      return res;
    } catch (err) {
      const axErr = err as AxiosError;
      logger.warn('HTTP request errored', {
        method: config.method,
        url: config.url,
        message: axErr.message,
        durationMs: Date.now() - started,
      });
      throw err;
    }
  }

  get<T = unknown>(url: string, config?: AxiosRequestConfig) {
    return this.request<T>({ ...config, method: 'GET', url });
  }

  post<T = unknown>(url: string, data?: unknown, config?: AxiosRequestConfig) {
    return this.request<T>({ ...config, method: 'POST', url, data });
  }

  put<T = unknown>(url: string, data?: unknown, config?: AxiosRequestConfig) {
    return this.request<T>({ ...config, method: 'PUT', url, data });
  }

  delete<T = unknown>(url: string, config?: AxiosRequestConfig) {
    return this.request<T>({ ...config, method: 'DELETE', url });
  }
}

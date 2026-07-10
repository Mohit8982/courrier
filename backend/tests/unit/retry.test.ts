import { withRetry } from '../../src/utils/retry';

describe('withRetry', () => {
  it('succeeds on first attempt without retrying', async () => {
    const fn = jest.fn().mockResolvedValue('ok');
    await expect(withRetry(fn, { maxAttempts: 3, initialDelayMs: 1, maxDelayMs: 5, backoffFactor: 2 }))
      .resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries transient failures with exponential backoff and eventually succeeds', async () => {
    let count = 0;
    const fn = jest.fn().mockImplementation(async () => {
      count += 1;
      if (count < 3) throw new Error('boom');
      return 'done';
    });
    const started = Date.now();
    const out = await withRetry(fn, {
      maxAttempts: 5,
      initialDelayMs: 10,
      maxDelayMs: 100,
      backoffFactor: 2,
    });
    expect(out).toBe('done');
    expect(fn).toHaveBeenCalledTimes(3);
    // 1st fail -> 10ms, 2nd fail -> 20ms => >= 30ms
    expect(Date.now() - started).toBeGreaterThanOrEqual(25);
  });

  it('gives up after maxAttempts and rethrows last error', async () => {
    const err = new Error('always');
    const fn = jest.fn().mockRejectedValue(err);
    await expect(
      withRetry(fn, { maxAttempts: 2, initialDelayMs: 1, maxDelayMs: 5, backoffFactor: 2 }),
    ).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('does not retry when shouldRetry returns false', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('nope'));
    await expect(
      withRetry(fn, {
        maxAttempts: 5,
        initialDelayMs: 1,
        maxDelayMs: 5,
        backoffFactor: 2,
        shouldRetry: () => false,
      }),
    ).rejects.toThrow('nope');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('caps delay at maxDelayMs', async () => {
    const delays: number[] = [];
    let count = 0;
    const fn = jest.fn().mockImplementation(async () => {
      count += 1;
      if (count < 4) throw new Error('x');
      return 'ok';
    });
    await withRetry(fn, {
      maxAttempts: 5,
      initialDelayMs: 100,
      maxDelayMs: 50, // cap smaller than initial
      backoffFactor: 3,
      onRetry: (_e, _a, delay) => delays.push(delay),
    });
    for (const d of delays) expect(d).toBeLessThanOrEqual(50);
  });
});

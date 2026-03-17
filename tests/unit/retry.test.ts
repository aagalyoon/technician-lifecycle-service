import { withRetry } from '../../src/utils/retry';

describe('Retry Logic', () => {
  it('returns immediately on success', async () => {
    const fn = jest.fn().mockResolvedValue('ok');
    const result = await withRetry(fn, 'test');
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on failure then succeeds', async () => {
    const fn = jest.fn()
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValue('ok');

    const result = await withRetry(fn, 'test', { baseDelayMs: 10 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('throws after max attempts', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('persistent fail'));

    await expect(
      withRetry(fn, 'test', { maxAttempts: 2, baseDelayMs: 10 })
    ).rejects.toThrow('persistent fail');

    expect(fn).toHaveBeenCalledTimes(2);
  });
});

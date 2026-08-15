import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { apiRequest, ApiError } from './client';

describe('apiRequest', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns JSON on ok', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    await expect(apiRequest<{ ok: boolean }>('/api/health')).resolves.toEqual({ ok: true });
  });

  it('throws ApiError with body text on failure', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('boom', { status: 500 }));
    await expect(apiRequest('/api/x')).rejects.toMatchObject({
      status: 500,
      message: 'boom',
    });
    await expect(apiRequest('/api/x')).rejects.toBeInstanceOf(ApiError);
  });
});

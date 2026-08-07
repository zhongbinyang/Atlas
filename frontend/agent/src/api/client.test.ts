import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { agentApi } from './agentApi';
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

describe('agentApi', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(new Response('{}', { status: 200 }))));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses legacy status and machine action endpoints', async () => {
    await agentApi.status();
    await agentApi.registerNow();
    await agentApi.forceRelease();

    expect(fetch).toHaveBeenNthCalledWith(
      1,
      '/api/status',
      expect.objectContaining({ headers: { Accept: 'application/json' } }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      '/api/register-now',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      3,
      '/api/slot/force-release',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('uses matching verbs for mutable legacy endpoints', async () => {
    await agentApi.putSettings({ units: [] });
    await agentApi.putChannels({ channels: [] });
    await agentApi.putRunQueue({ items: [] });
    await agentApi.saveSequenceTemplate({ name: 'smoke' });

    expect(fetch).toHaveBeenNthCalledWith(
      1,
      '/api/settings',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ units: [] }) }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      '/api/channels',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ channels: [] }) }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      3,
      '/api/sequence/run-queue',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ items: [] }) }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      4,
      '/api/sequence-templates',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ name: 'smoke' }) }),
    );
  });

  it('encodes dynamic sequence paths', async () => {
    await agentApi.loadSequenceTemplate('tpl/1');
    await agentApi.sequenceAbortChannel(3);

    expect(fetch).toHaveBeenNthCalledWith(
      1,
      '/api/sequence-templates/tpl%2F1/load',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      '/api/sequence/run/channels/3/abort',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});

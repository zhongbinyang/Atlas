import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { schedulerApi } from './schedulerApi';

describe('schedulerApi', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('lists agents from the scheduler agent endpoint', async () => {
    const agents = [{ id: 'a1', name: 'Agent 1' }];
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify(agents), { status: 200 }));

    await expect(schedulerApi.listAgents()).resolves.toEqual(agents);
    expect(fetch).toHaveBeenCalledWith('/api/agents', expect.objectContaining({ headers: expect.any(Object) }));
  });

  it('encodes optional template agent filters', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }));

    await schedulerApi.listViTemplates('agent 1');

    expect(fetch).toHaveBeenCalledWith(
      '/api/vi-templates?agent_id=agent%201',
      expect.objectContaining({ headers: expect.any(Object) }),
    );
  });

  it('unwraps units responses', async () => {
    const units = [{ symbol: 'kg', description: 'Kilogram' }];
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ units }), { status: 200 }));

    await expect(schedulerApi.listUnits()).resolves.toEqual(units);
  });

  it('saves units using the scheduler units envelope', async () => {
    const units = [{ symbol: 's', description: 'Second' }];
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ units }), { status: 200 }));

    await expect(schedulerApi.saveUnits(units)).resolves.toEqual({ units });
    expect(fetch).toHaveBeenCalledWith(
      '/api/units',
      expect.objectContaining({
        body: JSON.stringify({ units }),
        method: 'PUT',
      }),
    );
  });
});

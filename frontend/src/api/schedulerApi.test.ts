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
    expect(fetch).toHaveBeenCalledWith('/api/stations', expect.objectContaining({ headers: expect.any(Object) }));
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

  it('posts a device profile under the agent id', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ id: 'p1' }), { status: 200 }));
    await schedulerApi.createDeviceProfile('agent 1', {
      name: 'Device',
      setting: { A: { B: 1 } },
      source_filename: 'Device_CFG.ini',
      activate: true,
    });
    expect(fetch).toHaveBeenCalledWith(
      '/api/stations/agent%201/device-profiles',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('writes settings, channels, and deletes config profiles', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      clone() {
        return this;
      },
      text: async () => '{}',
    } as Response);

    await schedulerApi.putAgentSettings('agent 1', {
      variables: [{ name: 'A', value: '1', description: '' }],
      array_expand_mode: 'semicolon',
    });
    await schedulerApi.putAgentChannels('agent 1', {
      channels: [{ channel_index: 0, name: 'CH0', enabled: true, overlay: {} }],
    });
    await schedulerApi.deleteDeviceProfile('agent 1', 'p 2');
    await schedulerApi.deleteCalibrationProfile('agent 1', 'c 3');

    expect(fetch).toHaveBeenNthCalledWith(
      1,
      '/api/stations/agent%201/settings',
      expect.objectContaining({ method: 'PUT' }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      '/api/stations/agent%201/channels',
      expect.objectContaining({ method: 'PUT' }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      3,
      '/api/stations/agent%201/device-profiles/p%202',
      expect.objectContaining({ method: 'DELETE' }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      4,
      '/api/stations/agent%201/calibration-profiles/c%203',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('updates device and calibration profiles', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      clone() {
        return this;
      },
      text: async () => '{}',
    } as Response);
    await schedulerApi.updateDeviceProfile('agent 1', 'p 2', {
      name: 'Device',
      setting: { A: { B: 1 } },
      source_filename: 'Device_CFG.ini',
    });
    await schedulerApi.updateCalibrationProfile('agent 1', 'c 3', {
      name: 'Cal',
      setting: {},
      source_filename: '',
    });
    expect(fetch).toHaveBeenNthCalledWith(
      1,
      '/api/stations/agent%201/device-profiles/p%202',
      expect.objectContaining({ method: 'PUT' }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      '/api/stations/agent%201/calibration-profiles/c%203',
      expect.objectContaining({ method: 'PUT' }),
    );
  });

  it('updates a spec template', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      clone() {
        return this;
      },
      text: async () => '{}',
    } as Response);
    await schedulerApi.updateSpecTemplate(12, {
      name: 'Spec',
      spec: { version: 1, sections: {} },
    });
    expect(fetch).toHaveBeenCalledWith(
      '/api/spec-templates/12',
      expect.objectContaining({ method: 'PUT' }),
    );
  });

  it('lists test runs with query string', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ items: [], total: 0 }), { status: 200 }),
    );
    await schedulerApi.listTestRuns({ agent_id: 'a 1', overall: 'pass', sn: 'S N' });
    expect(fetch).toHaveBeenCalledWith(
      '/api/test-runs?agent_id=a%201&overall=pass&sn=S%20N',
      expect.objectContaining({ headers: expect.any(Object) }),
    );
  });
});


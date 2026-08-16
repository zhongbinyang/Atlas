// @vitest-environment jsdom
import { Modal } from 'antd';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { schedulerApi } from './api/schedulerApi';
import type { Agent, GeneralTemplate, SequenceTemplate, UnitRow, ViTemplate } from './api/types';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

vi.mock('./api/schedulerApi', () => ({
  schedulerApi: {
    buildVersion: vi.fn(),
    deleteGeneralTemplate: vi.fn(),
    deleteRestTemplate: vi.fn(),
    deleteCmdTemplate: vi.fn(),
    deleteSequenceTemplate: vi.fn(),
    deleteViTemplate: vi.fn(),
    listAgents: vi.fn(),
    listGeneralTemplates: vi.fn(),
    listRestTemplates: vi.fn(),
    listCmdTemplates: vi.fn(),
    listSequenceTemplates: vi.fn(),
    listUnits: vi.fn(),
    listViTemplates: vi.fn(),
    saveUnits: vi.fn(),
    listTestRuns: vi.fn(),
    getTestRun: vi.fn(),
    listAgentConfigSummaries: vi.fn(),
    listAgentConfigTemplates: vi.fn(),
    getAgentSettings: vi.fn(),
    getAgentChannels: vi.fn(),
    listDeviceProfiles: vi.fn(),
    listCalibrationProfiles: vi.fn(),
    listSpecTemplates: vi.fn(),
    getSpecTemplate: vi.fn(),
  },
}));

const agents: Agent[] = [
  {
    id: 'agent-1',
    name: 'Alpha',
    ip: '10.0.0.1',
    port: 26631,
    status: 'online',
    busy: false,
    cpu_percent: 12.3,
    memory_percent: 45.6,
    last_seen_at: '2026-08-07T01:00:00.000Z',
  },
  {
    id: 'agent-2',
    name: 'Beta',
    ip: '10.0.0.2',
    port: 26632,
    status: 'online',
    busy: true,
    cpu_percent: 78.9,
    memory_percent: 65.4,
    last_seen_at: '2026-08-07T01:01:00.000Z',
  },
  {
    id: 'agent-3',
    name: 'Gamma',
    ip: '10.0.0.3',
    port: 26633,
    status: 'offline',
    busy: false,
    cpu_percent: 0,
    memory_percent: 0,
    last_seen_at: '2026-08-07T00:59:00.000Z',
  },
];

const viTemplates: ViTemplate[] = [
  {
    id: 10,
    name: 'VoltageSweep',
    kind: 'labview',
    origin_agent_name: 'Alpha',
    vi_path: 'C:/vi/voltage.vi',
    timeout_secs: 30,
    inputs: [{ name: 'voltage', value: 3.3 }],
  },
];

const generalTemplates: GeneralTemplate[] = [
  {
    id: 'delay-1',
    name: 'Delay',
    kind: 'delay',
    origin_agent_name: 'Beta',
    inputs: [{ name: 'delay_ms', value: 1000 }],
  },
];

const restTemplates: GeneralTemplate[] = [
  {
    id: 'rest-1',
    name: 'HttpGet',
    kind: 'rest',
    origin_agent_name: 'Alpha',
    inputs: [{ name: 'url', value: 'http://x' }],
  },
];

const cmdTemplates: GeneralTemplate[] = [
  {
    id: 'cmd-1',
    name: 'EchoCmd',
    kind: 'cmd',
    origin_agent_name: 'Beta',
    inputs: [{ name: 'command', value: 'echo' }],
  },
];

const sequenceTemplates: SequenceTemplate[] = [
  {
    id: 'seq-1',
    name: 'PowerCycle',
    step_count: 2,
    created_by_agent_name: 'Alpha',
  },
];

const units: UnitRow[] = [{ symbol: 'dBm', description: '光功率，相对 1 mW' }];

function installBrowserStubs() {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
  Object.defineProperty(window, 'getComputedStyle', {
    writable: true,
    value: vi.fn().mockImplementation(() =>
      new Proxy(
        { getPropertyValue: vi.fn(() => '') },
        {
          get(target, prop: string) {
            return prop in target ? target[prop as keyof typeof target] : '';
          },
        },
      ),
    ),
  });
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  window.ResizeObserver = vi.fn().mockImplementation(() => ({
    observe: vi.fn(),
    unobserve: vi.fn(),
    disconnect: vi.fn(),
  }));
}

async function renderAt(hash: string) {
  window.location.hash = hash;
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);

  await act(async () => {
    root.render(<App />);
  });

  return { host, root };
}

async function waitFor(assertion: () => void) {
  let lastError: unknown;
  for (let i = 0; i < 20; i += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  }
  throw lastError;
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function buttonText(button: HTMLButtonElement): string {
  return (button.textContent || '').replace(/\s+/g, '');
}

function findTab(label: string): HTMLElement | undefined {
  return Array.from(document.querySelectorAll<HTMLElement>('[role="tab"]')).find((tab) =>
    (tab.textContent || '').includes(label),
  );
}

async function confirmDeleteModal(expectedText: string) {
  await waitFor(() => {
    expect(document.body.textContent).toContain(expectedText);
  });
  const confirmOk = Array.from(
    document.querySelectorAll<HTMLButtonElement>('.ant-modal-confirm button'),
  ).find((button) => buttonText(button) === '删除');
  expect(confirmOk).toBeTruthy();
  await act(async () => {
    confirmOk?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

describe('Scheduler App routes', () => {
  let rendered: { host: HTMLDivElement; root: Root } | undefined;

  beforeEach(() => {
    installBrowserStubs();
    vi.useRealTimers();
    vi.mocked(schedulerApi.buildVersion).mockResolvedValue({ version: 'test' });
    vi.mocked(schedulerApi.listAgents).mockResolvedValue(agents);
    vi.mocked(schedulerApi.listViTemplates).mockResolvedValue(viTemplates);
    vi.mocked(schedulerApi.listGeneralTemplates).mockResolvedValue(generalTemplates);
    vi.mocked(schedulerApi.listRestTemplates).mockResolvedValue(restTemplates);
    vi.mocked(schedulerApi.listCmdTemplates).mockResolvedValue(cmdTemplates);
    vi.mocked(schedulerApi.deleteViTemplate).mockResolvedValue(undefined);
    vi.mocked(schedulerApi.deleteGeneralTemplate).mockResolvedValue(undefined);
    vi.mocked(schedulerApi.deleteRestTemplate).mockResolvedValue(undefined);
    vi.mocked(schedulerApi.deleteCmdTemplate).mockResolvedValue(undefined);
    vi.mocked(schedulerApi.listSequenceTemplates).mockResolvedValue(sequenceTemplates);
    vi.mocked(schedulerApi.deleteSequenceTemplate).mockResolvedValue(undefined);
    vi.mocked(schedulerApi.listUnits).mockResolvedValue(units);
    vi.mocked(schedulerApi.saveUnits).mockResolvedValue({ units });
    vi.mocked(schedulerApi.listTestRuns).mockResolvedValue({
      items: [{
        id: 'run-1',
        agent_id: 'agent-1',
        channel_index: 0,
        channel_name: 'CH0',
        sequence_template_id: 12,
        overall: 'pass',
        elapsed_ms: 12,
        started_at: '2026-08-15T14:00:00+00:00',
        finished_at: '2026-08-15T14:01:00+00:00',
        sn: 'SN001',
        work_order: 'WO-1',
        hostname: 'ATE01',
      }],
      total: 1,
    });
    vi.mocked(schedulerApi.listAgentConfigSummaries).mockResolvedValue([
      {
        agent_id: 'agent-1',
        agent_name: 'Alpha',
        agent_status: 'online',
        agent_ip: '10.0.0.1',
        variable_count: 1,
        device_profile_count: 0,
        calibration_profile_count: 0,
        channel_count: 1,
      },
    ]);
    vi.mocked(schedulerApi.listAgentConfigTemplates).mockResolvedValue([]);
    vi.mocked(schedulerApi.getAgentSettings).mockResolvedValue({ variables: [], array_expand_mode: 'semicolon' });
    vi.mocked(schedulerApi.getAgentChannels).mockResolvedValue([]);
    vi.mocked(schedulerApi.listDeviceProfiles).mockResolvedValue([]);
    vi.mocked(schedulerApi.listCalibrationProfiles).mockResolvedValue([]);
    vi.mocked(schedulerApi.listSpecTemplates).mockResolvedValue([
      {
        id: 7,
        name: 'FMT',
        product_pn: 'PN1',
        source_filename: 'fmt.ini',
        section_count: 2,
        updated_at: '2026-08-16T00:00:00Z',
      },
    ]);
    vi.mocked(schedulerApi.getSpecTemplate).mockResolvedValue({
      id: 7,
      name: 'FMT',
      product_pn: 'PN1',
      note: '',
      source_filename: 'fmt.ini',
      section_count: 2,
      spec: { sections: {} },
      created_at: '2026-08-16T00:00:00Z',
      updated_at: '2026-08-16T00:00:00Z',
    });
    vi.mocked(schedulerApi.getTestRun).mockResolvedValue({
      id: 'run-1',
      agent_id: 'agent-1',
      channel_index: 0,
      channel_name: 'CH0',
      sequence_template_id: 12,
      run_generation: 1,
      overall: 'pass',
      stopped: false,
      failed_at: null,
      elapsed_ms: 12,
      started_at: '2026-08-15T14:00:00+00:00',
      finished_at: '2026-08-15T14:01:00+00:00',
      created_at: '2026-08-15T14:01:01+00:00',
      context: { sn: '', work_order: '', hostname: 'ATE01' },
      steps: [{
        position: 1, queue_item_id: 'q-1', template_id: '12', template_source: 'labview',
        name: 'TX_AP', kind: 'labview', ok: true, status: 'pass', elapsed_ms: 8,
        measured: { TX_AP: 1.2 }, limits: [], result: {}, error: null,
        spec_template_id: null, spec_section: 'FMT_HT',
      }],
    });
  });

  afterEach(async () => {
    if (rendered) {
      await act(async () => rendered?.root.unmount());
      rendered.host.remove();
      rendered = undefined;
    }
    document.body.innerHTML = '';
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    Modal.destroyAll();
  });

  it('renders the machines page with telemetry summary, cards, and filtering', async () => {
    rendered = await renderAt('#/machines');

    await waitFor(() => {
      expect(document.body.textContent).toContain('总数');
      expect(document.body.textContent).toContain('Alpha');
      expect(document.body.textContent).toContain('在线·忙碌');
      expect(document.body.textContent).toContain('自动刷新 · 2 秒');
    });

    const search = document.querySelector('input[type="search"]') as HTMLInputElement;
    await act(async () => {
      setInputValue(search, 'Gamma');
    });

    await waitFor(() => {
      expect(document.body.textContent).toContain('Gamma');
      expect(document.body.textContent).not.toContain('Alpha');
      expect(document.body.textContent).not.toContain('Beta');
    });
  });

  it('renders agent detail and navigates back to machines', async () => {
    rendered = await renderAt('#/agents/agent-2');

    await waitFor(() => {
      expect(document.body.textContent).toContain('Beta');
      expect(document.body.textContent).toContain('状态');
      expect(document.body.textContent).toContain('地址');
      expect(document.body.textContent).toContain('CPU');
      expect(document.body.textContent).toContain('最后心跳');
      expect(document.body.textContent).toContain('在线·忙碌');
    });

    const backButton = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent === '返回列表',
    );
    expect(backButton).toBeTruthy();

    await act(async () => {
      backButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(window.location.hash).toBe('#/machines');
  });

  it('renders functions tables and confirms VI template deletion', async () => {
    rendered = await renderAt('#/functions');

    await waitFor(() => {
      expect(document.body.textContent).toContain('已注册功能');
      expect(document.body.textContent).toContain('四类功能');
      expect(document.body.textContent).toContain('中心VI功能');
      expect(document.body.textContent).toContain('VoltageSweep');
      expect(document.body.textContent).toContain('中心通用功能');
      expect(document.body.textContent).toContain('中心REST功能');
      expect(document.body.textContent).toContain('中心命令行功能');
    });

    await act(async () => {
      findTab('中心通用功能')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await waitFor(() => {
      const active = document.querySelector('.ant-tabs-tabpane-active');
      expect(active?.textContent).toContain('Delay');
      expect(active?.textContent).toContain('delay_ms=1000');
      expect(active?.textContent).not.toContain('HttpGet');
      expect(active?.textContent).not.toContain('EchoCmd');
    });

    await act(async () => {
      findTab('中心REST功能')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await waitFor(() => {
      const active = document.querySelector('.ant-tabs-tabpane-active');
      expect(active?.textContent).toContain('HttpGet');
      expect(active?.textContent).toContain('REST');
      expect(active?.textContent).not.toContain('Delay');
    });

    await act(async () => {
      findTab('中心命令行功能')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await waitFor(() => {
      const active = document.querySelector('.ant-tabs-tabpane-active');
      expect(active?.textContent).toContain('EchoCmd');
      expect(active?.textContent).toContain('命令行');
    });

    await act(async () => {
      findTab('中心VI功能')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await waitFor(() => {
      expect(document.body.textContent).toContain('VoltageSweep');
    });

    const deleteButton = Array.from(document.querySelectorAll('button')).find(
      (button) => buttonText(button) === '删除',
    );
    await act(async () => {
      deleteButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    await confirmDeleteModal('相关序列队列中的引用也会清除。');
    await waitFor(() => {
      expect(schedulerApi.deleteViTemplate).toHaveBeenCalledWith(10);
    });
  });

  it('renders sequence templates and confirms deletion', async () => {
    rendered = await renderAt('#/sequences');

    await waitFor(() => {
      expect(document.body.textContent).toContain('序列模板');
      expect(document.body.textContent).toContain('PowerCycle');
      expect(document.body.textContent).toContain('步骤数');
      expect(document.body.textContent).toContain('Alpha');
    });

    const deleteButton = Array.from(document.querySelectorAll('button')).find(
      (button) => buttonText(button) === '删除',
    );
    await act(async () => {
      deleteButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    await confirmDeleteModal('确定删除「序列模板「PowerCycle」」？');
    await waitFor(() => {
      expect(schedulerApi.deleteSequenceTemplate).toHaveBeenCalledWith('seq-1');
    });
  });

  it('edits and saves units through the units page', async () => {
    rendered = await renderAt('#/units');

    await waitFor(() => {
      expect(document.body.textContent).toContain('单位');
      expect(document.body.textContent).toContain('全局共享');
      expect(Array.from(document.querySelectorAll('input')).some((input) => input.value === 'dBm')).toBe(true);
    });

    const inputs = Array.from(document.querySelectorAll('input')) as HTMLInputElement[];
    const symbolInput = inputs.find((input) => input.value === 'dBm');
    expect(symbolInput).toBeTruthy();

    await act(async () => {
      setInputValue(symbolInput as HTMLInputElement, 'dB');
    });

    const saveButton = Array.from(document.querySelectorAll('button')).find(
      (button) => buttonText(button) === '保存',
    );
    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    await waitFor(() => {
      expect(schedulerApi.saveUnits).toHaveBeenCalledWith([
        { symbol: 'dB', description: '光功率，相对 1 mW' },
      ]);
    });
  });

  it('lists test runs and opens a detail with empty SN as dash', async () => {
    rendered = await renderAt('#/runs');
    await waitFor(() => {
      expect(document.body.textContent).toContain('运行');
      expect(document.body.textContent).toContain('SN001');
      expect(document.body.textContent).toContain('CH0');
    });
    const viewButton = Array.from(document.querySelectorAll('button')).find(
      (button) => buttonText(button) === '查看',
    );
    await act(async () => {
      viewButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await waitFor(() => {
      expect(schedulerApi.getTestRun).toHaveBeenCalledWith('run-1');
      expect(document.body.textContent).toContain('TX_AP');
      expect(document.body.textContent).toContain('—');
    });
  });

  it('opens station config as a page instead of a modal', async () => {
    rendered = await renderAt('#/configs');
    await waitFor(() => {
      expect(document.body.textContent).toContain('各机台当前配置');
      expect(document.body.textContent).toContain('Alpha');
    });
    const editButton = Array.from(document.querySelectorAll('button')).find(
      (button) => buttonText(button) === '编辑',
    );
    await act(async () => {
      editButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await waitFor(() => {
      expect(window.location.hash).toBe('#/configs/agent-1');
      expect(document.body.textContent).toContain('编辑配置 · Alpha');
      expect(document.body.textContent).toContain('返回列表');
      expect(document.body.textContent).toContain('设备配置档');
    });
  });

  it('opens spec editor as a page instead of a modal', async () => {
    rendered = await renderAt('#/specs');
    await waitFor(() => {
      expect(document.body.textContent).toContain('Spec 模板');
      expect(document.body.textContent).toContain('FMT');
    });
    const editButton = Array.from(document.querySelectorAll('button')).find(
      (button) => buttonText(button) === '编辑',
    );
    await act(async () => {
      editButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await waitFor(() => {
      expect(window.location.hash).toBe('#/specs/7');
      expect(document.body.textContent).toContain('编辑 Spec · FMT');
      expect(document.body.textContent).toContain('返回列表');
    });
  });
});


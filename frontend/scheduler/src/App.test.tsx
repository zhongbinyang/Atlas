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
    deleteGeneralTemplate: vi.fn(),
    deleteSequenceTemplate: vi.fn(),
    deleteViTemplate: vi.fn(),
    listAgents: vi.fn(),
    listGeneralTemplates: vi.fn(),
    listSequenceTemplates: vi.fn(),
    listUnits: vi.fn(),
    listViTemplates: vi.fn(),
    saveUnits: vi.fn(),
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

describe('Scheduler App routes', () => {
  let rendered: { host: HTMLDivElement; root: Root } | undefined;

  beforeEach(() => {
    installBrowserStubs();
    vi.useRealTimers();
    vi.mocked(schedulerApi.listAgents).mockResolvedValue(agents);
    vi.mocked(schedulerApi.listViTemplates).mockResolvedValue(viTemplates);
    vi.mocked(schedulerApi.listGeneralTemplates).mockResolvedValue(generalTemplates);
    vi.mocked(schedulerApi.deleteViTemplate).mockResolvedValue(undefined);
    vi.mocked(schedulerApi.deleteGeneralTemplate).mockResolvedValue(undefined);
    vi.mocked(schedulerApi.listSequenceTemplates).mockResolvedValue(sequenceTemplates);
    vi.mocked(schedulerApi.deleteSequenceTemplate).mockResolvedValue(undefined);
    vi.mocked(schedulerApi.listUnits).mockResolvedValue(units);
    vi.mocked(schedulerApi.saveUnits).mockResolvedValue({ units });
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
      (button) => button.textContent === '返回机台',
    );
    expect(backButton).toBeTruthy();

    await act(async () => {
      backButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(window.location.hash).toBe('#/machines');
  });

  it('renders functions tables and confirms VI template deletion', async () => {
    const confirmSpy = vi.spyOn(Modal, 'confirm').mockImplementation((config) => {
      void config.onOk?.();
      return { destroy: vi.fn(), update: vi.fn() } as ReturnType<typeof Modal.confirm>;
    });

    rendered = await renderAt('#/functions');

    await waitFor(() => {
      expect(document.body.textContent).toContain('已注册功能');
      expect(document.body.textContent).toContain('中心VI功能');
      expect(document.body.textContent).toContain('VoltageSweep');
      expect(document.body.textContent).toContain('中心通用功能');
      expect(document.body.textContent).toContain('Delay');
      expect(document.body.textContent).toContain('delay_ms=1000');
    });

    const deleteButton = Array.from(document.querySelectorAll('button')).find(
      (button) => buttonText(button) === '删除',
    );
    await act(async () => {
      deleteButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    await waitFor(() => {
      expect(confirmSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining('相关序列队列中的引用也会清除。'),
          okText: '删除',
          title: '确认删除',
        }),
      );
      expect(schedulerApi.deleteViTemplate).toHaveBeenCalledWith(10);
    });
  });

  it('renders sequence templates and confirms deletion', async () => {
    const confirmSpy = vi.spyOn(Modal, 'confirm').mockImplementation((config) => {
      void config.onOk?.();
      return { destroy: vi.fn(), update: vi.fn() } as ReturnType<typeof Modal.confirm>;
    });

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

    await waitFor(() => {
      expect(confirmSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          content: '确定删除「序列模板「PowerCycle」」？',
          okText: '删除',
          title: '确认删除',
        }),
      );
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
});

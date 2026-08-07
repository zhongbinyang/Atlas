// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { schedulerApi } from './api/schedulerApi';
import type { Agent } from './api/types';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

vi.mock('./api/schedulerApi', () => ({
  schedulerApi: {
    listAgents: vi.fn(),
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

describe('Scheduler App routes', () => {
  let rendered: { host: HTMLDivElement; root: Root } | undefined;

  beforeEach(() => {
    installBrowserStubs();
    vi.useRealTimers();
    vi.mocked(schedulerApi.listAgents).mockResolvedValue(agents);
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
});

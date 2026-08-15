// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PageHeader } from './PageHeader';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

describe('PageHeader', () => {
  let host: HTMLDivElement | undefined;
  let root: ReturnType<typeof createRoot> | undefined;

  afterEach(async () => {
    if (root) {
      await act(async () => root?.unmount());
    }
    host?.remove();
    host = undefined;
    root = undefined;
  });

  it('renders title, description, extra, and back', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const onBack = vi.fn();

    await act(async () => {
      root?.render(
        <PageHeader
          title="机台"
          description="查看各机台状态"
          extra={<button type="button">刷新</button>}
          onBack={onBack}
        />,
      );
    });

    expect(host.textContent).toContain('机台');
    expect(host.textContent).toContain('查看各机台状态');
    expect(host.textContent).toContain('返回列表');
    expect(host.textContent).toContain('刷新');

    const back = Array.from(host.querySelectorAll('button')).find(
      (button) => button.textContent === '返回列表',
    );
    await act(async () => {
      back?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});

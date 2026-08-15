import { describe, expect, it, vi } from 'vitest';
import { runOrConfirmUnsaved } from './leaveConfirm';

describe('runOrConfirmUnsaved', () => {
  it('runs immediately when clean', () => {
    const confirm = vi.fn();
    const action = vi.fn();
    runOrConfirmUnsaved(confirm, false, action);
    expect(action).toHaveBeenCalledTimes(1);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('asks before leaving when dirty', () => {
    const confirm = vi.fn();
    const action = vi.fn();
    runOrConfirmUnsaved(confirm, true, action);
    expect(action).not.toHaveBeenCalled();
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        title: '有未保存的修改',
        okText: '离开',
      }),
    );
    confirm.mock.calls[0][0].onOk();
    expect(action).toHaveBeenCalledTimes(1);
  });
});

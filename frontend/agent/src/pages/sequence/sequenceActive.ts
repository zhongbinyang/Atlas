/** Local binding for the template that last loaded/saved into this agent's run-queue. */

export const ACTIVE_SEQUENCE_STORAGE_KEY = 'atlas.agent.activeSequence';

export type ActiveSequenceBinding = {
  id: string | number;
  name: string;
  dirty?: boolean;
};

export type ActiveSequenceSummary = {
  stepCount: number;
  binding: ActiveSequenceBinding | null;
  title: string;
  dirty: boolean;
};

function canUseStorage(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

export function readActiveSequenceBinding(): ActiveSequenceBinding | null {
  if (!canUseStorage()) return null;
  try {
    const raw = window.localStorage.getItem(ACTIVE_SEQUENCE_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ActiveSequenceBinding>;
    if (parsed.id == null || parsed.id === '') return null;
    const name = String(parsed.name ?? '').trim();
    return {
      id: parsed.id as string | number,
      name: name || `模板 #${String(parsed.id)}`,
      dirty: !!parsed.dirty,
    };
  } catch {
    return null;
  }
}

export function writeActiveSequenceBinding(binding: ActiveSequenceBinding | null): void {
  if (!canUseStorage()) return;
  try {
    if (!binding || binding.id == null || binding.id === '') {
      window.localStorage.removeItem(ACTIVE_SEQUENCE_STORAGE_KEY);
      return;
    }
    const payload: ActiveSequenceBinding = {
      id: binding.id,
      name: String(binding.name || '').trim() || `模板 #${String(binding.id)}`,
      dirty: !!binding.dirty,
    };
    window.localStorage.setItem(ACTIVE_SEQUENCE_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    /* ignore quota / private mode */
  }
}

export function bindActiveSequence(id: string | number, name: string): ActiveSequenceBinding {
  const binding: ActiveSequenceBinding = {
    id,
    name: String(name || '').trim() || `模板 #${String(id)}`,
    dirty: false,
  };
  writeActiveSequenceBinding(binding);
  return binding;
}

export function markActiveSequenceDirty(): ActiveSequenceBinding | null {
  const current = readActiveSequenceBinding();
  if (!current) return null;
  const next = { ...current, dirty: true };
  writeActiveSequenceBinding(next);
  return next;
}

export function clearActiveSequenceBinding(): void {
  writeActiveSequenceBinding(null);
}

export function countRunQueueSteps(queue: Array<{ template_source?: string }> | null | undefined): number {
  if (!Array.isArray(queue)) return 0;
  return queue.filter((item) => item?.template_source !== 'group').length;
}

export function buildActiveSequenceSummary(
  stepCount: number,
  binding: ActiveSequenceBinding | null = readActiveSequenceBinding(),
): ActiveSequenceSummary {
  const dirty = !!binding?.dirty;
  if (binding) {
    return {
      stepCount,
      binding,
      dirty,
      title: `当前激活：${binding.name}（#${String(binding.id)}）· ${stepCount} 步`,
    };
  }
  return {
    stepCount,
    binding: null,
    dirty: false,
    title: `当前激活：执行顺序草稿 · ${stepCount} 步`,
  };
}

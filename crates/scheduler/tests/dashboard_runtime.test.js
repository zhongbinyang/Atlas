const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createRequestDeduper,
  createRefreshController,
  reconcileKeyedChildren,
} = require('../static/dashboard-runtime.js');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createTimers() {
  const scheduled = [];

  return {
    scheduled,
    setTimeout(callback, delay) {
      const timer = { callback, delay, cancelled: false };
      scheduled.push(timer);
      return timer;
    },
    clearTimeout(timer) {
      timer.cancelled = true;
    },
    nextActive() {
      return scheduled.find((timer) => !timer.cancelled && !timer.fired);
    },
    fire(timer) {
      timer.fired = true;
      timer.callback();
    },
  };
}

function createVisibilityDocument() {
  const listeners = new Map();

  return {
    hidden: false,
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    removeEventListener(type, listener) {
      if (listeners.get(type) === listener) listeners.delete(type);
    },
    setHidden(hidden) {
      this.hidden = hidden;
      listeners.get('visibilitychange')?.();
    },
  };
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
}

test('request deduper reuses an in-flight request and allows a new request after settlement', async () => {
  const requests = [];
  const load = createRequestDeduper(() => {
    const pending = deferred();
    requests.push(pending);
    return pending.promise;
  });

  const first = load();
  const duplicate = load();
  assert.equal(first, duplicate);
  await flushPromises();
  assert.equal(requests.length, 1);

  requests[0].resolve('first result');
  assert.equal(await first, 'first result');

  const next = load();
  assert.notEqual(next, first);
  await flushPromises();
  assert.equal(requests.length, 2);
  requests[1].resolve('second result');
  assert.equal(await next, 'second result');
});

test('refresh controller schedules the next refresh only after the current one settles', async () => {
  const timers = createTimers();
  const document = createVisibilityDocument();
  const refreshes = [];
  let active = 0;
  let maxActive = 0;
  const controller = createRefreshController({
    delayMs: 2000,
    document,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    refresh: () => {
      const pending = deferred();
      refreshes.push(pending);
      active += 1;
      maxActive = Math.max(maxActive, active);
      return pending.promise.finally(() => {
        active -= 1;
      });
    },
  });

  controller.start();
  const firstTimer = timers.nextActive();
  assert.equal(firstTimer.delay, 2000);

  timers.fire(firstTimer);
  await flushPromises();
  assert.equal(refreshes.length, 1);
  assert.equal(timers.nextActive(), undefined, 'no timer is armed while refresh is pending');

  const reusedRefresh = controller.refreshNow();
  assert.equal(refreshes.length, 1, 'an immediate request reuses the active refresh');

  refreshes[0].resolve();
  await reusedRefresh;
  await flushPromises();
  assert.equal(maxActive, 1);
  assert.equal(timers.nextActive().delay, 2000);

  controller.stop();
});

test('refresh controller pauses while hidden and refreshes immediately when visible', async () => {
  const timers = createTimers();
  const document = createVisibilityDocument();
  const refreshes = [];
  const controller = createRefreshController({
    delayMs: 2000,
    document,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    refresh: () => {
      const pending = deferred();
      refreshes.push(pending);
      return pending.promise;
    },
  });

  controller.start();
  const waitingTimer = timers.nextActive();

  document.setHidden(true);
  assert.equal(waitingTimer.cancelled, true);
  assert.equal(timers.nextActive(), undefined);

  document.setHidden(false);
  await flushPromises();
  assert.equal(refreshes.length, 1, 'becoming visible starts a refresh without waiting');
  assert.equal(timers.nextActive(), undefined);

  refreshes[0].resolve();
  await flushPromises();
  assert.equal(timers.nextActive().delay, 2000);

  controller.stop();
});

class FakeParent {
  constructor(children = []) {
    this.children = [];
    this.mutationCount = 0;
    for (const child of children) this.appendChild(child);
    this.mutationCount = 0;
  }

  appendChild(child) {
    if (child.parentNode) child.parentNode.removeChild(child);
    this.children.push(child);
    child.parentNode = this;
    this.mutationCount += 1;
    return child;
  }

  insertBefore(child, reference) {
    const oldIndex = this.children.indexOf(child);
    if (oldIndex !== -1) this.children.splice(oldIndex, 1);
    const nextIndex = reference === null ? this.children.length : this.children.indexOf(reference);
    this.children.splice(nextIndex, 0, child);
    child.parentNode = this;
    this.mutationCount += 1;
    return child;
  }

  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index !== -1) this.children.splice(index, 1);
    child.parentNode = null;
    this.mutationCount += 1;
    return child;
  }
}

test('keyed reconciliation does not move nodes when their order is unchanged', () => {
  const alpha = { key: 'alpha' };
  const bravo = { key: 'bravo' };
  const parent = new FakeParent([alpha, bravo]);

  reconcileKeyedChildren(parent, [{ id: 'alpha' }, { id: 'bravo' }], {
    getKey: (item) => item.id,
    getNodeKey: (node) => node.key,
    createNode: () => {
      throw new Error('no node should be created');
    },
    updateNode: () => {},
  });

  assert.equal(parent.mutationCount, 0);
});

test('keyed reconciliation preserves matching nodes and removes stale nodes in latest order', () => {
  const alpha = { key: 'alpha' };
  const stale = { key: 'stale' };
  const parent = new FakeParent([alpha, stale]);

  reconcileKeyedChildren(parent, [
    { id: 'bravo', label: 'B' },
    { id: 'alpha', label: 'A updated' },
  ], {
    getKey: (item) => item.id,
    getNodeKey: (node) => node.key,
    createNode: (item) => ({ key: item.id }),
    updateNode: (node, item) => {
      node.label = item.label;
    },
  });

  assert.deepEqual(parent.children.map((node) => node.key), ['bravo', 'alpha']);
  assert.equal(parent.children[1], alpha, 'the node for an existing key keeps its identity');
  assert.equal(alpha.label, 'A updated');
  assert.equal(stale.parentNode, null, 'a node missing from the latest data is removed');
});

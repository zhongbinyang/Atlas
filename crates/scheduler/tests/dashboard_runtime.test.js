const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createLatestTaskRunner,
  createLatestResourceLoader,
  createMessageChannel,
  createRequestDeduper,
  createRefreshController,
  createSafeEventHandler,
  reconcileKeyedChildren,
  startDashboard,
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

function createMessageElement() {
  const element = {
    hidden: true,
    textContent: '',
    className: 'msg',
  };
  element.classList = {
    contains: (name) => element.className.split(/\s+/).includes(name),
  };
  return element;
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

test('request deduper releases a rejected request so the next call can retry', async () => {
  let attempts = 0;
  const load = createRequestDeduper(() => {
    attempts += 1;
    if (attempts === 1) return Promise.reject(new Error('temporary failure'));
    return Promise.resolve('recovered');
  });

  const first = load();
  assert.equal(load(), first, 'the rejected in-flight request is still shared');
  await assert.rejects(first, /temporary failure/);
  assert.equal(await load(), 'recovered');
  assert.equal(attempts, 2);
});

test('latest task runner prevents an older route from committing after a newer route', async () => {
  const agentRequest = deferred();
  const functionsRequest = deferred();
  const commits = [];
  const runRoute = createLatestTaskRunner(async (route, isCurrent) => {
    await (route === 'agent' ? agentRequest.promise : functionsRequest.promise);
    if (isCurrent()) commits.push(route);
  });

  const oldRoute = runRoute('agent');
  await flushPromises();
  const currentRoute = runRoute('functions');
  await flushPromises();

  functionsRequest.resolve();
  await currentRoute;
  agentRequest.resolve();
  await oldRoute;

  assert.deepEqual(commits, ['functions']);
});

test('latest task runner consumes entry-point rejection and reports it', async () => {
  const errors = [];
  const runRoute = createLatestTaskRunner(
    async () => {
      throw new Error('route failed');
    },
    { onError: (error) => errors.push(error.message) },
  );

  await assert.doesNotReject(runRoute('machines'));
  assert.deepEqual(errors, ['route failed']);
});

function createQueuedResourceLoader() {
  const requests = [];
  const commits = [];
  const errors = [];
  const loadLatest = createLatestResourceLoader({
    load: () => {
      const request = deferred();
      requests.push(request);
      return request.promise;
    },
    commit: (value) => commits.push(value),
    onError: (error) => errors.push(error.message),
  });
  return { requests, commits, errors, loadLatest };
}

test('latest resource loader prevents an older filter response from replacing a newer response', async () => {
  const loader = createQueuedResourceLoader();
  const oldFilter = loader.loadLatest();
  await flushPromises();
  const newFilter = loader.loadLatest();
  await flushPromises();

  loader.requests[1].resolve('new result');
  await newFilter;
  loader.requests[0].resolve('old result');
  await oldFilter;

  assert.deepEqual(loader.commits, ['new result']);
});

test('latest resource loader shares invalidation across route and filter entry points', async () => {
  const loader = createQueuedResourceLoader();
  const loadFromRoute = (guard) => loader.loadLatest(guard);
  const loadFromFilter = () => loader.loadLatest();
  const routeLoad = loadFromRoute(() => true);
  await flushPromises();
  const filterLoad = loadFromFilter();
  await flushPromises();

  loader.requests[1].resolve('filter result');
  await filterLoad;
  loader.requests[0].resolve('route result');
  await routeLoad;

  assert.deepEqual(loader.commits, ['filter result']);
});

test('latest resource loader checks the route guard before committing', async () => {
  const loader = createQueuedResourceLoader();
  let routeIsCurrent = true;
  const routeLoad = loader.loadLatest(() => routeIsCurrent);
  await flushPromises();

  routeIsCurrent = false;
  loader.requests[0].resolve('stale route result');
  await routeLoad;

  assert.deepEqual(loader.commits, []);
});

test('resource loader retains the last commit after an HTTP 500 failure', async () => {
  let attempt = 0;
  const commits = [];
  const errors = [];
  const loadLatest = createLatestResourceLoader({
    load: async () => {
      attempt += 1;
      if (attempt === 1) return ['stable'];
      throw new Error('HTTP 500');
    },
    commit: (value) => commits.push(value),
    onError: (error) => errors.push(error.message),
  });

  await loadLatest();
  await assert.doesNotReject(loadLatest());

  assert.deepEqual(commits, [['stable']]);
  assert.deepEqual(errors, ['HTTP 500']);
});

test('resource loader retains the last commit after JSON parsing fails', async () => {
  let attempt = 0;
  const commits = [];
  const errors = [];
  const loadLatest = createLatestResourceLoader({
    load: async () => {
      attempt += 1;
      if (attempt === 1) return ['stable'];
      throw new SyntaxError('invalid JSON');
    },
    commit: (value) => commits.push(value),
    onError: (error) => errors.push(error.message),
  });

  await loadLatest();
  await assert.doesNotReject(loadLatest());

  assert.deepEqual(commits, [['stable']]);
  assert.deepEqual(errors, ['invalid JSON']);
});

test('operation success and reload failure remain visible in separate channels', () => {
  for (const operationText of ['已修改', '已删除', '序列已删除']) {
    const operationElement = createMessageElement();
    const loadElement = createMessageElement();
    const operationMessages = createMessageChannel(operationElement);
    const loadMessages = createMessageChannel(loadElement);

    operationMessages.show(operationText, true);
    loadMessages.show('加载失败: HTTP 500', false);

    assert.equal(operationElement.textContent, operationText);
    assert.equal(operationElement.className, 'msg ok');
    assert.equal(loadElement.textContent, '加载失败: HTTP 500');
    assert.equal(loadElement.className, 'msg err');
  }
});

test('successful reload does not clear operation validation or failure', () => {
  for (const operationText of ['名称不能为空', '修改失败', '删除失败', '序列删除失败']) {
    const operationElement = createMessageElement();
    const loadElement = createMessageElement();
    const operationMessages = createMessageChannel(operationElement);
    const loadMessages = createMessageChannel(loadElement);

    operationMessages.show(operationText, false);
    loadMessages.show('加载失败: invalid JSON', false);
    loadMessages.clearError();

    assert.equal(operationElement.hidden, false);
    assert.equal(operationElement.textContent, operationText);
    assert.equal(operationElement.className, 'msg err');
  }
});

test('successful reload clears only its own resource load error', () => {
  const operationElement = createMessageElement();
  const viLoadElement = createMessageElement();
  const sequenceLoadElement = createMessageElement();
  const operationMessages = createMessageChannel(operationElement);
  const viLoadMessages = createMessageChannel(viLoadElement);
  const sequenceLoadMessages = createMessageChannel(sequenceLoadElement);

  operationMessages.show('已删除', true);
  viLoadMessages.show('VI 加载失败', false);
  sequenceLoadMessages.show('序列加载失败', false);
  viLoadMessages.clearError();

  assert.equal(viLoadElement.hidden, true);
  assert.equal(operationElement.textContent, '已删除');
  assert.equal(sequenceLoadElement.textContent, '序列加载失败');
  assert.equal(sequenceLoadElement.hidden, false);
});

test('safe event handler does not pass the browser event to its async task', async () => {
  const calls = [];
  const handler = createSafeEventHandler(async (...args) => {
    calls.push(args);
  });

  await handler({ type: 'change' });

  assert.deepEqual(calls, [[]]);
});

test('safe event handler consumes async rejection and reports it', async () => {
  const errors = [];
  const handler = createSafeEventHandler(
    async () => {
      throw new Error('filter failed');
    },
    { onError: (error) => errors.push(error.message) },
  );

  await assert.doesNotReject(handler({ type: 'change' }));
  assert.deepEqual(errors, ['filter failed']);
});

test('dashboard refresh starts without waiting for the initial route to settle', () => {
  const initialRoute = deferred();
  let starts = 0;

  const pending = startDashboard(
    () => initialRoute.promise,
    { start: () => { starts += 1; } },
  );

  assert.equal(starts, 1);
  assert.equal(pending, initialRoute.promise);
  initialRoute.resolve();
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

test('refresh controller consumes automatic rejection and schedules another refresh', async () => {
  const timers = createTimers();
  const document = createVisibilityDocument();
  const errors = [];
  const controller = createRefreshController({
    delayMs: 2000,
    document,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    refresh: () => Promise.reject(new Error('refresh failed')),
    onError: (error) => errors.push(error.message),
  });

  controller.start();
  timers.fire(timers.nextActive());
  await flushPromises();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(errors, ['refresh failed']);
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

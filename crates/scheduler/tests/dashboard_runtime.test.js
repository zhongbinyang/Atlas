const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createLatestTaskRunner,
  createDialogController,
  createLatestResourceLoader,
  createMessageChannel,
  createRequestDeduper,
  createRefreshController,
  createSafeEventHandler,
  createToastController,
  formatAgentHeartbeat,
  getAgentTelemetry,
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

function createKeyboardDocument() {
  const listeners = new Map();
  return {
    activeElement: null,
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    dispatch(type, event) {
      listeners.get(type)?.(event);
    },
  };
}

function createFocusable(document) {
  const listeners = new Map();
  return {
    hidden: false,
    disabled: false,
    isConnected: true,
    focusCount: 0,
    focus() {
      this.focusCount += 1;
      document.activeElement = this;
    },
    addEventListener(type, listener) {
      const callbacks = listeners.get(type) || [];
      callbacks.push(listener);
      listeners.set(type, callbacks);
    },
    dispatch(type) {
      for (const listener of listeners.get(type) || []) listener();
    },
  };
}

function createDialog(document, controls) {
  const dialog = {
    hidden: true,
    isConnected: true,
    querySelectorAll() {
      return controls;
    },
    querySelector(selector) {
      if (selector === '[data-dialog-confirm]') return controls[0] || null;
      if (selector === '[data-dialog-cancel]') return controls[1] || null;
      return null;
    },
    contains(element) {
      return controls.includes(element);
    },
  };
  for (const control of controls) {
    if (!control.parentElement) control.parentElement = dialog;
  }
  return dialog;
}

function createToastElement() {
  const listeners = new Map();
  return {
    hidden: true,
    textContent: '',
    className: 'toast',
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    dispatch(type) {
      listeners.get(type)?.();
    },
  };
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
}

const telemetryAgents = [
  { id: 'offline', name: '离线机台', ip: '10.0.0.3', port: 26631, status: 'offline', busy: false, cpu_percent: 2, memory_percent: 3 },
  { id: 'busy', name: 'Busy rig', ip: '10.0.0.2', port: 26632, status: 'online', busy: true, cpu_percent: 80, memory_percent: 40 },
  { id: 'idle', name: 'Alpha 机台', ip: '10.0.0.1', port: 26631, status: 'online', busy: false, cpu_percent: 20, memory_percent: 90 },
];

test('agent telemetry summarizes the full successful agent array', () => {
  const telemetry = getAgentTelemetry(telemetryAgents, { query: '10.0.0.1' });

  assert.deepEqual(telemetry.summary, { total: 3, online: 2, busy: 1, offline: 1 });
  assert.deepEqual(telemetry.visibleAgents.map((agent) => agent.id), ['idle']);
});

test('agent telemetry combines case-insensitive name address port search and status filters', () => {
  const telemetry = getAgentTelemetry(telemetryAgents, {
    query: 'BUSY RIG',
    status: 'online',
    sort: 'name',
  });
  assert.deepEqual(telemetry.visibleAgents.map((agent) => agent.id), ['busy']);

  const addressTelemetry = getAgentTelemetry(telemetryAgents, {
    query: '10.0.0.2:26632',
    status: 'busy',
  });
  assert.deepEqual(addressTelemetry.visibleAgents.map((agent) => agent.id), ['busy']);
});

test('agent telemetry intersects abnormal-only with the selected status', () => {
  const offline = getAgentTelemetry(telemetryAgents, { abnormalOnly: true, status: 'all' });
  assert.deepEqual(offline.visibleAgents.map((agent) => agent.id), ['offline']);

  const noMatch = getAgentTelemetry(telemetryAgents, { abnormalOnly: true, status: 'online' });
  assert.deepEqual(noMatch.visibleAgents, []);
});

test('agent telemetry supports name, status, cpu and memory sorting without mutating agents', () => {
  const originalOrder = telemetryAgents.map((agent) => agent.id);

  assert.deepEqual(getAgentTelemetry(telemetryAgents, { sort: 'name' }).visibleAgents.map((agent) => agent.id), ['offline', 'idle', 'busy']);
  assert.deepEqual(getAgentTelemetry(telemetryAgents, { sort: 'status' }).visibleAgents.map((agent) => agent.id), ['offline', 'busy', 'idle']);
  assert.deepEqual(getAgentTelemetry(telemetryAgents, { sort: 'cpu_desc' }).visibleAgents.map((agent) => agent.id), ['busy', 'idle', 'offline']);
  assert.deepEqual(getAgentTelemetry(telemetryAgents, { sort: 'memory_desc' }).visibleAgents.map((agent) => agent.id), ['idle', 'busy', 'offline']);
  assert.deepEqual(telemetryAgents.map((agent) => agent.id), originalOrder);
});

test('agent heartbeat formats relative and local time while invalid values render an em dash', () => {
  assert.equal(formatAgentHeartbeat('not-a-date', new Date('2026-07-30T12:00:00Z')), '—');
  assert.match(
    formatAgentHeartbeat('2026-07-30T11:59:30Z', new Date('2026-07-30T12:00:00Z')),
    /^30 秒前 · /,
  );
});

test('dialog controller focuses the first control, traps Tab, closes on Escape, and restores its trigger', () => {
  const document = createKeyboardDocument();
  const trigger = createFocusable(document);
  const first = createFocusable(document);
  const last = createFocusable(document);
  const dialog = createDialog(document, [first, last]);
  const controller = createDialogController({ document });

  controller.open(dialog, { trigger });
  assert.equal(dialog.hidden, false);
  assert.equal(document.activeElement, first);

  document.activeElement = last;
  let prevented = false;
  document.dispatch('keydown', {
    key: 'Tab',
    shiftKey: false,
    preventDefault() { prevented = true; },
  });
  assert.equal(prevented, true);
  assert.equal(document.activeElement, first);

  document.activeElement = first;
  document.dispatch('keydown', {
    key: 'Tab',
    shiftKey: true,
    preventDefault() {},
  });
  assert.equal(document.activeElement, last);

  document.dispatch('keydown', { key: 'Escape', preventDefault() {} });
  assert.equal(dialog.hidden, true);
  assert.equal(document.activeElement, trigger);
});

test('dialog controller excludes controls hidden by a parent container from its focus order', () => {
  const document = createKeyboardDocument();
  const trigger = createFocusable(document);
  const hiddenByAttribute = createFocusable(document);
  hiddenByAttribute.parentElement = {
    hidden: false,
    getAttribute(name) { return name === 'aria-hidden' ? 'true' : null; },
  };
  const hiddenByProperty = createFocusable(document);
  hiddenByProperty.parentElement = { hidden: true, getAttribute() { return null; } };
  const visible = createFocusable(document);
  const dialog = createDialog(document, [hiddenByAttribute, hiddenByProperty, visible]);
  const controller = createDialogController({ document });

  controller.open(dialog, { trigger });

  assert.equal(document.activeElement, visible);
});

test('dialog controller allows only one open dialog and resolves custom confirmation asynchronously', async () => {
  const document = createKeyboardDocument();
  const trigger = createFocusable(document);
  const firstDialog = createDialog(document, [createFocusable(document)]);
  const confirmButton = createFocusable(document);
  const cancelButton = createFocusable(document);
  const confirmDialog = createDialog(document, [confirmButton, cancelButton]);
  const controller = createDialogController({ document });

  controller.open(firstDialog, { trigger });
  const confirmed = controller.confirm(confirmDialog, { trigger });
  assert.equal(firstDialog.hidden, true);
  assert.equal(confirmDialog.hidden, false);

  confirmButton.dispatch('click');
  assert.equal(await confirmed, true);
  assert.equal(confirmDialog.hidden, true);
  assert.equal(document.activeElement, trigger);
});

test('dialog controller replaces an open dialog without restoring focus to its hidden trigger', () => {
  const document = createKeyboardDocument();
  const firstTrigger = createFocusable(document);
  const secondTrigger = createFocusable(document);
  const firstDialog = createDialog(document, [createFocusable(document)]);
  const secondFirstControl = createFocusable(document);
  const secondDialog = createDialog(document, [secondFirstControl]);
  const closeReasons = [];
  const controller = createDialogController({ document });

  controller.open(firstDialog, { trigger: firstTrigger, onClose: (reason) => closeReasons.push(reason) });
  controller.open(secondDialog, { trigger: secondTrigger });

  assert.equal(firstDialog.hidden, true);
  assert.deepEqual(closeReasons, ['replaced']);
  assert.equal(firstTrigger.focusCount, 0);
  assert.equal(document.activeElement, secondFirstControl);
});

test('dialog controller restores a nested child trigger before the original parent trigger', () => {
  const document = createKeyboardDocument();
  const externalTrigger = createFocusable(document);
  const childTrigger = createFocusable(document);
  const parentFirstControl = createFocusable(document);
  const childFirstControl = createFocusable(document);
  const parentDialog = createDialog(document, [parentFirstControl, childTrigger]);
  const childDialog = createDialog(document, [childFirstControl]);
  const closeReasons = [];
  const controller = createDialogController({ document });

  controller.open(parentDialog, {
    trigger: externalTrigger,
    onClose: (reason) => closeReasons.push(reason),
  });
  controller.open(childDialog, { parent: parentDialog, trigger: childTrigger });

  assert.equal(parentDialog.hidden, true);
  assert.equal(childDialog.hidden, false);
  controller.close(childDialog);
  assert.equal(parentDialog.hidden, false);
  assert.equal(childDialog.hidden, true);
  assert.equal(document.activeElement, childTrigger);
  assert.deepEqual(closeReasons, []);

  controller.close(parentDialog);
  assert.equal(parentDialog.hidden, true);
  assert.equal(document.activeElement, externalTrigger);
  assert.deepEqual(closeReasons, ['closed']);
});

test('dialog controller reopening the same dialog retains its original restore target', () => {
  const document = createKeyboardDocument();
  const externalTrigger = createFocusable(document);
  const pagerButton = createFocusable(document);
  const firstControl = createFocusable(document);
  const dialog = createDialog(document, [firstControl, pagerButton]);
  const controller = createDialogController({ document });

  controller.open(dialog, { trigger: externalTrigger });
  controller.open(dialog, { trigger: pagerButton });
  controller.close(dialog);

  assert.equal(document.activeElement, externalTrigger);
  assert.equal(pagerButton.focusCount, 0);
});

test('dialog controller uses its fallback for disconnected disabled or hidden restore targets', () => {
  for (const invalidate of [
    (target) => { target.isConnected = false; },
    (target) => { target.disabled = true; },
    (target) => {
      target.parentElement = {
        hidden: true,
        getAttribute() { return null; },
      };
    },
  ]) {
    const document = createKeyboardDocument();
    const trigger = createFocusable(document);
    const fallback = createFocusable(document);
    const dialog = createDialog(document, [createFocusable(document)]);
    const controller = createDialogController({ document, fallback });

    controller.open(dialog, { trigger });
    invalidate(trigger);
    controller.close(dialog);

    assert.equal(document.activeElement, fallback);
    assert.equal(trigger.focusCount, 0);
  }
});

test('dialog controller does not retain a cancelled confirmation action for the next confirmation', async () => {
  const document = createKeyboardDocument();
  const trigger = createFocusable(document);
  const confirmButton = createFocusable(document);
  const cancelButton = createFocusable(document);
  const confirmDialog = createDialog(document, [confirmButton, cancelButton]);
  const controller = createDialogController({ document });

  const cancelled = controller.confirm(confirmDialog, { trigger });
  cancelButton.dispatch('click');
  assert.equal(await cancelled, false);

  const confirmed = controller.confirm(confirmDialog, { trigger });
  confirmButton.dispatch('click');
  assert.equal(await confirmed, true);
});

test('toast controller shows one message for 4000 ms and pauses while hovered or focused', () => {
  const timers = createTimers();
  const element = createToastElement();
  const toast = createToastController(element, {
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });

  toast.show('截图已获取', 'success');
  assert.equal(element.hidden, false);
  assert.equal(element.textContent, '截图已获取');
  assert.equal(timers.nextActive().delay, 4000);

  element.dispatch('mouseenter');
  assert.equal(timers.nextActive(), undefined);
  element.dispatch('mouseleave');
  assert.equal(timers.nextActive().delay, 4000);
  element.dispatch('focusin');
  assert.equal(timers.nextActive(), undefined);
  element.dispatch('focusout');
  timers.fire(timers.nextActive());
  assert.equal(element.hidden, true);
});

test('toast mouseleave does not resume auto-close while focus remains inside', () => {
  const timers = createTimers();
  const element = createToastElement();
  const toast = createToastController(element, {
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });

  toast.show('截图已获取', 'success');
  element.dispatch('focusin');
  element.dispatch('mouseenter');
  element.dispatch('mouseleave');
  assert.equal(timers.nextActive(), undefined);

  element.dispatch('focusout');
  assert.equal(timers.nextActive().delay, 4000);
});

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

test('telemetry filters survive a refresh and keyed reconciliation reuses matching card nodes', () => {
  const filters = { query: 'busy rig', status: 'online', sort: 'name', abnormalOnly: false };
  const first = getAgentTelemetry(telemetryAgents, filters).visibleAgents;
  const refreshed = telemetryAgents.map((agent) => ({ ...agent, cpu_percent: agent.cpu_percent + 1 }));
  const next = getAgentTelemetry(refreshed, filters).visibleAgents;
  const parent = new FakeParent();

  reconcileKeyedChildren(parent, first, {
    getKey: (agent) => agent.id,
    getNodeKey: (node) => node.key,
    createNode: (agent) => ({ key: agent.id }),
    updateNode: (node, agent) => { node.cpu = agent.cpu_percent; },
  });
  const busyCard = parent.children[0];
  reconcileKeyedChildren(parent, next, {
    getKey: (agent) => agent.id,
    getNodeKey: (node) => node.key,
    createNode: (agent) => ({ key: agent.id }),
    updateNode: (node, agent) => { node.cpu = agent.cpu_percent; },
  });

  assert.deepEqual(filters, { query: 'busy rig', status: 'online', sort: 'name', abnormalOnly: false });
  assert.equal(parent.children[0], busyCard);
  assert.equal(busyCard.cpu, 81);
});

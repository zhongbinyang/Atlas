(function (root, factory) {
  const runtime = factory();
  if (typeof module === 'object' && module.exports) module.exports = runtime;
  root.AtlasDashboardRuntime = runtime;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function createRequestDeduper(request) {
    let activeRequest = null;

    return function requestOnce() {
      if (activeRequest) return activeRequest;
      const pending = Promise.resolve().then(request);
      const shared = pending.finally(() => {
        if (activeRequest === shared) activeRequest = null;
      });
      activeRequest = shared;
      return shared;
    };
  }

  function createRefreshController(options) {
    const delayMs = options.delayMs;
    const documentRef = options.document;
    const refresh = options.refresh;
    const setTimer = options.setTimeout || setTimeout;
    const clearTimer = options.clearTimeout || clearTimeout;
    let timer = null;
    let activeRefresh = null;
    let started = false;

    function cancelTimer() {
      if (timer === null) return;
      clearTimer(timer);
      timer = null;
    }

    function scheduleNext() {
      cancelTimer();
      if (!started || documentRef.hidden) return;
      timer = setTimer(() => {
        timer = null;
        void refreshNow();
      }, delayMs);
    }

    function refreshNow() {
      if (activeRefresh) return activeRefresh;
      cancelTimer();
      if (!started || documentRef.hidden) return Promise.resolve();

      activeRefresh = Promise.resolve()
        .then(refresh)
        .finally(() => {
          activeRefresh = null;
          scheduleNext();
        });
      return activeRefresh;
    }

    function handleVisibilityChange() {
      if (documentRef.hidden) {
        cancelTimer();
        return;
      }
      void refreshNow();
    }

    function start() {
      if (started) return;
      started = true;
      documentRef.addEventListener('visibilitychange', handleVisibilityChange);
      scheduleNext();
    }

    function stop() {
      if (!started) return;
      started = false;
      cancelTimer();
      documentRef.removeEventListener('visibilitychange', handleVisibilityChange);
    }

    return { start, stop, refreshNow };
  }

  function reconcileKeyedChildren(parent, items, options) {
    const existing = new Map();
    for (const node of Array.from(parent.children)) {
      existing.set(options.getNodeKey(node), node);
    }

    const desired = [];
    for (const item of items) {
      const key = options.getKey(item);
      const node = existing.get(key) || options.createNode(item);
      existing.delete(key);
      options.updateNode(node, item);
      desired.push(node);
    }

    for (const node of existing.values()) {
      parent.removeChild(node);
    }

    desired.forEach((node, index) => {
      const current = parent.children[index] || null;
      if (current !== node) parent.insertBefore(node, current);
    });
  }

  return {
    createRequestDeduper,
    createRefreshController,
    reconcileKeyedChildren,
  };
});

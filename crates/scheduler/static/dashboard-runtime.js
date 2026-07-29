(function (root, factory) {
  const runtime = factory();
  if (typeof module === 'object' && module.exports) module.exports = runtime;
  root.AtlasDashboardRuntime = runtime;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function createSafeEventHandler(task, options) {
    const onError = options?.onError || function () {};
    return function handleEvent() {
      return Promise.resolve()
        .then(() => task())
        .catch((error) => {
          onError(error);
        });
    };
  }

  function createMessageChannel(element) {
    return {
      show(text, ok) {
        element.hidden = false;
        element.textContent = text;
        element.className = ok ? 'msg ok' : 'msg err';
      },
      clearError() {
        if (!element.classList.contains('err')) return;
        element.hidden = true;
        element.textContent = '';
        element.className = 'msg';
      },
    };
  }

  function startDashboard(loadInitialRoute, refreshController) {
    const initialRoute = loadInitialRoute();
    refreshController.start();
    return initialRoute;
  }

  function createLatestTaskRunner(task, options) {
    const onError = options?.onError || function () {};
    let generation = 0;

    return function runLatest(value) {
      const currentGeneration = ++generation;
      const isCurrent = () => currentGeneration === generation;
      return Promise.resolve()
        .then(() => task(value, isCurrent))
        .catch((error) => {
          onError(error);
        });
    };
  }

  function createLatestResourceLoader(options) {
    const onError = options.onError || function () {};
    let generation = 0;

    return function loadLatest(guard) {
      const currentGeneration = ++generation;
      const canCommit = typeof guard === 'function' ? guard : () => true;
      const isCurrent = () => currentGeneration === generation && canCommit();

      return Promise.resolve()
        .then(options.load)
        .then(
          (value) => {
            if (!isCurrent()) return false;
            options.commit(value);
            return true;
          },
          (error) => {
            if (!isCurrent()) return false;
            onError(error);
            return false;
          },
        );
    };
  }

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
    const onError = options.onError || function () {};
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
        refreshAutomatically();
      }, delayMs);
    }

    function reportError(error) {
      try {
        onError(error);
      } catch (reportingError) {
        if (typeof console !== 'undefined') console.error(reportingError);
      }
    }

    function refreshAutomatically() {
      void refreshNow().catch(reportError);
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
      refreshAutomatically();
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
    createLatestResourceLoader,
    createLatestTaskRunner,
    createMessageChannel,
    createRequestDeduper,
    createRefreshController,
    createSafeEventHandler,
    reconcileKeyedChildren,
    startDashboard,
  };
});

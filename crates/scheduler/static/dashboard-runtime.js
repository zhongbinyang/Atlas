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

  function createToastController(element, options) {
    const delayMs = options?.delayMs || 4000;
    const setTimer = options?.setTimeout || setTimeout;
    const clearTimerRef = options?.clearTimeout || clearTimeout;
    let timer = null;
    let paused = false;

    function clearTimer() {
      if (timer === null) return;
      clearTimerRef(timer);
      timer = null;
    }

    function close() {
      clearTimer();
      element.hidden = true;
      element.textContent = '';
      element.className = 'toast';
    }

    function scheduleClose() {
      clearTimer();
      if (paused || element.hidden) return;
      timer = setTimer(close, delayMs);
    }

    element.addEventListener('mouseenter', () => {
      paused = true;
      clearTimer();
    });
    element.addEventListener('mouseleave', () => {
      paused = false;
      scheduleClose();
    });
    element.addEventListener('focusin', () => {
      paused = true;
      clearTimer();
    });
    element.addEventListener('focusout', () => {
      paused = false;
      scheduleClose();
    });

    return {
      show(text, kind) {
        element.hidden = false;
        element.textContent = text;
        element.className = 'toast toast-' + (kind || 'info');
        scheduleClose();
      },
      close,
    };
  }

  function createDialogController(options) {
    const documentRef = options.document;
    const focusableSelector =
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    let current = null;

    function isHidden(element) {
      for (let node = element; node; node = node.parentElement) {
        if (node.hidden || node.getAttribute?.('aria-hidden') === 'true') return true;
      }
      return false;
    }

    function focusable(dialog) {
      return Array.from(dialog.querySelectorAll(focusableSelector)).filter((element) =>
        !isHidden(element) && !element.disabled,
      );
    }

    function focusFirst(dialog) {
      const controls = focusable(dialog);
      (controls[0] || dialog).focus?.();
    }

    function close(dialog, closeOptions) {
      if (!current || (dialog && current.dialog !== dialog)) return false;
      const active = current;
      current = null;
      active.dialog.hidden = true;
      active.onClose?.(closeOptions?.reason || 'closed');
      if (closeOptions?.restoreFocus !== false) active.trigger?.focus?.();
      return true;
    }

    function open(dialog, openOptions) {
      if (current && current.dialog !== dialog) {
        close(undefined, { reason: 'replaced', restoreFocus: false });
      }
      const trigger = openOptions?.trigger || documentRef.activeElement;
      current = {
        dialog,
        trigger,
        onClose: openOptions?.onClose,
      };
      dialog.hidden = false;
      focusFirst(dialog);
    }

    function confirm(dialog, confirmOptions) {
      return new Promise((resolve) => {
        const finish = (result) => {
          if (!current || current.dialog !== dialog) return;
          const active = current;
          current = null;
          dialog._atlasConfirmFinish = null;
          dialog.hidden = true;
          active.trigger?.focus?.();
          resolve(result);
        };
        const controls = focusable(dialog);
        if (!dialog._atlasConfirmBound) {
          const confirmButton = dialog.querySelector?.('[data-dialog-confirm]') || controls[0];
          const cancelButton = dialog.querySelector?.('[data-dialog-cancel]') || controls[1];
          confirmButton?.addEventListener('click', () => dialog._atlasConfirmFinish?.(true));
          cancelButton?.addEventListener('click', () => dialog._atlasConfirmFinish?.(false));
          dialog._atlasConfirmBound = true;
        }
        dialog._atlasConfirmFinish = finish;
        open(dialog, {
          trigger: confirmOptions?.trigger || documentRef.activeElement,
          onClose: () => {
            dialog._atlasConfirmFinish = null;
            resolve(false);
          },
        });
      });
    }

    documentRef.addEventListener('keydown', (event) => {
      if (!current) return;
      if (event.key === 'Escape') {
        event.preventDefault?.();
        close();
        return;
      }
      if (event.key !== 'Tab') return;
      const controls = focusable(current.dialog);
      if (controls.length === 0) {
        event.preventDefault?.();
        current.dialog.focus?.();
        return;
      }
      const index = controls.indexOf(documentRef.activeElement);
      if (event.shiftKey && (index <= 0)) {
        event.preventDefault?.();
        controls[controls.length - 1].focus();
      } else if (!event.shiftKey && index === controls.length - 1) {
        event.preventDefault?.();
        controls[0].focus();
      }
    });

    return { open, close, confirm };
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
    createDialogController,
    createLatestResourceLoader,
    createLatestTaskRunner,
    createMessageChannel,
    createRequestDeduper,
    createRefreshController,
    createSafeEventHandler,
    createToastController,
    reconcileKeyedChildren,
    startDashboard,
  };
});

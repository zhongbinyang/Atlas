(function (root, factory) {
  'use strict';

  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AgentViWorkbenchRuntime = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const BUSY_STATES = new Set(['inspecting', 'running', 'registering']);
  const INSPECTABLE_STATES = new Set([
    'ready_to_inspect',
    'ready_to_run',
    'ready_to_register',
    'registered',
  ]);
  const RUNNABLE_STATES = new Set([
    'ready_to_run',
    'ready_to_register',
    'registered',
  ]);
  const STAGE_KEYS = ['path', 'inspect', 'run', 'naming', 'register'];

  function normalizeFsPath(raw) {
    let value = String(raw == null ? '' : raw).trim();
    if (value.length >= 2) {
      const first = value[0];
      const last = value[value.length - 1];
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
        value = value.slice(1, -1).trim();
      }
    }
    return value;
  }

  function viStemFromPath(viPath) {
    return String(viPath || '').replace(/^.*[\\/]/, '').replace(/\.vi$/i, '');
  }

  function copyList(value) {
    return Array.isArray(value) ? value.slice() : [];
  }

  function createWorkbenchRuntime(initial) {
    const model = {
      state: 'empty',
      rawPath: '',
      path: '',
      inspectedPath: '',
      name: '',
      inputs: [],
      outputs: [],
      runResult: null,
      registration: null,
      pendingAction: null,
      returnState: null,
    };

    function hasValidName() {
      return model.name.trim() !== '';
    }

    function controls() {
      const busy = BUSY_STATES.has(model.state);
      const canInspect = !busy && INSPECTABLE_STATES.has(model.state);
      const canRun = !busy && RUNNABLE_STATES.has(model.state);
      const canRegister = canRun && hasValidName();
      let inspectReason = '';
      let runReason = '';
      let registerReason = '';

      if (busy) {
        inspectReason = runReason = registerReason = '操作进行中';
      } else {
        if (!canInspect) inspectReason = model.path ? '路径尚未就绪' : '请输入 VI 路径';
        if (!canRun) runReason = '请先查询参数';
        if (!canRun) registerReason = '请先查询参数';
        else if (!hasValidName()) registerReason = '请输入名称';
      }

      return {
        pathDisabled: busy,
        nameDisabled: model.state === 'inspecting' || model.state === 'registering',
        inputsDisabled: busy,
        advancedDisabled: busy || model.state === 'empty',
        inspect: { enabled: canInspect, reason: inspectReason },
        run: { enabled: canRun, reason: runReason },
        register: { enabled: canRegister, reason: registerReason },
      };
    }

    function stageProgress() {
      const stages = STAGE_KEYS.map(function (key) {
        return { key: key, status: 'waiting' };
      });
      function completeThrough(index) {
        for (let stageIndex = 0; stageIndex <= index; stageIndex += 1) {
          stages[stageIndex].status = 'complete';
        }
      }
      function markCurrent(index) {
        stages[index].status = 'current';
      }

      if (model.state === 'registered') {
        completeThrough(4);
        if (model.runResult === null) stages[2].status = 'optional';
      } else if (model.state === 'registering') {
        completeThrough(3);
        if (model.runResult === null) stages[2].status = 'optional';
        markCurrent(4);
      } else if (model.state === 'ready_to_register') {
        completeThrough(3);
        markCurrent(4);
      } else if (model.state === 'ready_to_run') {
        completeThrough(1);
        if (model.runResult !== null) {
          stages[2].status = 'complete';
          markCurrent(3);
        } else if (hasValidName()) {
          stages[2].status = 'optional';
          stages[3].status = 'complete';
          markCurrent(4);
        } else {
          markCurrent(2);
        }
      } else if (model.state === 'running') {
        completeThrough(1);
        markCurrent(2);
        if (hasValidName()) stages[3].status = 'complete';
      } else if (model.state === 'inspecting' || model.state === 'ready_to_inspect') {
        completeThrough(0);
        markCurrent(1);
      } else {
        markCurrent(0);
      }
      return stages;
    }

    function snapshot() {
      return {
        state: model.state,
        rawPath: model.rawPath,
        path: model.path,
        inspectedPath: model.inspectedPath,
        name: model.name,
        inputs: copyList(model.inputs),
        outputs: copyList(model.outputs),
        runResult: model.runResult,
        registration: model.registration,
        pendingAction: model.pendingAction,
        controls: controls(),
        stages: stageProgress(),
      };
    }

    function invalidateForPath(path) {
      model.path = path;
      model.inspectedPath = '';
      model.inputs = [];
      model.outputs = [];
      model.runResult = null;
      model.registration = null;
      model.pendingAction = null;
      model.returnState = null;
      model.state = path ? 'ready_to_inspect' : 'empty';
    }

    function inputPath(raw) {
      if (controls().pathDisabled) return false;
      model.rawPath = String(raw == null ? '' : raw);
      const normalized = normalizeFsPath(model.rawPath);
      if (normalized !== model.inspectedPath) {
        invalidateForPath(normalized);
      } else {
        model.path = normalized;
      }
      return true;
    }

    function blurPath() {
      if (controls().pathDisabled) {
        return { path: model.path, name: model.name };
      }
      const normalized = normalizeFsPath(model.rawPath);
      model.rawPath = normalized;
      if (normalized !== model.inspectedPath) invalidateForPath(normalized);
      else model.path = normalized;
      if (!hasValidName()) model.name = viStemFromPath(normalized);
      return { path: model.path, name: model.name };
    }

    function inputName(raw) {
      if (controls().nameDisabled) return false;
      model.name = String(raw == null ? '' : raw);
      if (model.runResult !== null) {
        if (model.state === 'ready_to_run' && hasValidName()) {
          model.state = 'ready_to_register';
        } else if (model.state === 'ready_to_register' && !hasValidName()) {
          model.state = 'ready_to_run';
        }
      }
      return true;
    }

    function begin(action, allowedStates, busyState) {
      if (BUSY_STATES.has(model.state) || !allowedStates.has(model.state)) return false;
      model.returnState = model.state;
      model.pendingAction = action;
      model.state = busyState;
      return true;
    }

    function beginInspect() {
      return begin('inspect', INSPECTABLE_STATES, 'inspecting');
    }

    function beginRun() {
      return begin('run', RUNNABLE_STATES, 'running');
    }

    function beginRegister() {
      const allowed = new Set();
      if (RUNNABLE_STATES.has(model.state) && hasValidName()) allowed.add(model.state);
      return begin('register', allowed, 'registering');
    }

    function inspectSucceeded(result) {
      if (model.pendingAction !== 'inspect') return false;
      const data = result || {};
      model.inspectedPath = model.path;
      model.inputs = copyList(data.inputs);
      model.outputs = copyList(data.outputs);
      model.runResult = null;
      model.registration = null;
      model.pendingAction = null;
      model.returnState = null;
      model.state = 'ready_to_run';
      return true;
    }

    function runSucceeded(result) {
      if (model.pendingAction !== 'run') return false;
      model.runResult = result;
      model.registration = null;
      model.pendingAction = null;
      model.returnState = null;
      model.state = hasValidName() ? 'ready_to_register' : 'ready_to_run';
      return true;
    }

    function registerSucceeded(result) {
      if (model.pendingAction !== 'register') return false;
      model.registration = result || {};
      model.pendingAction = null;
      model.returnState = null;
      model.state = 'registered';
      return true;
    }

    function actionFailed(action) {
      if (model.pendingAction !== action) return false;
      const derivesRunReadiness = action === 'run' &&
        model.runResult !== null &&
        (model.returnState === 'ready_to_run' || model.returnState === 'ready_to_register');
      if (derivesRunReadiness) {
        model.state = hasValidName() ? 'ready_to_register' : 'ready_to_run';
      } else {
        model.state = model.returnState || (model.path ? 'ready_to_inspect' : 'empty');
      }
      model.pendingAction = null;
      model.returnState = null;
      return true;
    }

    function loadTemplate(template) {
      if (BUSY_STATES.has(model.state)) return false;
      const data = template || {};
      const path = normalizeFsPath(data.vi_path);
      model.rawPath = path;
      model.path = path;
      model.inspectedPath = path;
      model.name = String(data.name || '');
      model.inputs = copyList(data.inputs);
      model.outputs = copyList(data.outputs);
      model.runResult = null;
      model.registration = null;
      model.pendingAction = null;
      model.returnState = null;
      model.state = path ? 'ready_to_run' : 'empty';
      return true;
    }

    function continueEditingCopy() {
      if (model.state !== 'registered') return false;
      model.registration = null;
      model.state = model.runResult && hasValidName()
        ? 'ready_to_register'
        : 'ready_to_run';
      return true;
    }

    if (initial) loadTemplate(initial);

    return {
      snapshot,
      inputPath,
      blurPath,
      inputName,
      beginInspect,
      inspectSucceeded,
      beginRun,
      runSucceeded,
      beginRegister,
      registerSucceeded,
      actionFailed,
      loadTemplate,
      continueEditingCopy,
    };
  }

  return {
    createWorkbenchRuntime,
    normalizeFsPath,
    viStemFromPath,
  };
});

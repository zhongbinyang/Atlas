'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const APP_SOURCE = fs.readFileSync(
  path.join(__dirname, '..', 'static', 'app.js'),
  'utf8'
);
const INDEX_SOURCE = fs.readFileSync(
  path.join(__dirname, '..', 'static', 'index.html'),
  'utf8'
);

function functionSource(name) {
  const marker = 'function ' + name + '(';
  const markerStart = APP_SOURCE.indexOf(marker);
  const asyncStart = APP_SOURCE.lastIndexOf('async ', markerStart);
  const start = asyncStart >= 0 && asyncStart + 6 === markerStart ? asyncStart : markerStart;
  assert.notEqual(start, -1, 'missing ' + name + ' in app.js');
  const bodyStart = APP_SOURCE.indexOf('{', start);
  let depth = 0;
  for (let index = bodyStart; index < APP_SOURCE.length; index += 1) {
    if (APP_SOURCE[index] === '{') depth += 1;
    if (APP_SOURCE[index] === '}') {
      depth -= 1;
      if (depth === 0) return APP_SOURCE.slice(start, index + 1);
    }
  }
  throw new Error('unterminated function ' + name);
}

test('path invalidation clears stale success feedback from the DOM', () => {
  const elements = {
    'lv-msg': {
      hidden: false,
      textContent: '已注册: Measure',
      className: 'msg ok',
    },
    'lv-json-raw': { textContent: '{"outputs":[]}' },
    'lv-schema-summary': {
      hidden: false,
      textContent: '参数已加载 · 入参 1 · 出参 1',
    },
  };
  let renderedInputs = 'not-called';
  let clearedRunResult = false;
  const context = {
    document: {
      getElementById(id) {
        return elements[id];
      },
    },
    renderInputsTable(value) {
      renderedInputs = value;
    },
    clearLvRunResult() {
      clearedRunResult = true;
    },
  };
  vm.createContext(context);
  vm.runInContext(functionSource('hideLvMsg'), context);
  vm.runInContext(functionSource('clearLvSchemasAndResults'), context);

  context.clearLvSchemasAndResults();

  assert.equal(elements['lv-msg'].hidden, true);
  assert.equal(elements['lv-msg'].textContent, '');
  assert.equal(elements['lv-json-raw'].textContent, '—');
  assert.equal(elements['lv-schema-summary'].hidden, true);
  assert.equal(elements['lv-schema-summary'].textContent, '');
  assert.equal(renderedInputs, null);
  assert.equal(clearedRunResult, true);
});

test('advanced details uses inert while native summary keeps built-in focusability', () => {
  const summary = {
    attributes: new Map([['tabindex', '-1']]),
    removedAttributes: [],
    removeAttribute(name) {
      this.removedAttributes.push(name);
      this.attributes.delete(name);
    },
  };
  const details = {
    inert: false,
    attributes: new Map(),
    querySelector(selector) {
      assert.equal(selector, 'summary');
      return summary;
    },
    setAttribute(name, value) {
      this.attributes.set(name, value);
    },
    removeAttribute(name) {
      this.attributes.delete(name);
    },
  };
  const context = {};
  vm.createContext(context);
  vm.runInContext(functionSource('syncAdvancedDetailsDisabledState'), context);

  context.syncAdvancedDetailsDisabledState(details, true);
  assert.equal(details.inert, true);
  assert.equal(details.attributes.get('inert'), '');
  assert.equal(details.attributes.get('aria-disabled'), 'true');
  assert.equal(summary.attributes.has('tabindex'), false);

  summary.attributes.set('tabindex', '-1');
  context.syncAdvancedDetailsDisabledState(details, false);
  assert.equal(details.inert, false);
  assert.equal(details.attributes.has('inert'), false);
  assert.equal(details.attributes.has('aria-disabled'), false);
  assert.equal(summary.attributes.has('tabindex'), false);
  assert.deepEqual(summary.removedAttributes, ['tabindex', 'tabindex']);
});

test('workbench text synchronization only assigns when visible text changes', () => {
  let assignments = 0;
  let value = '未变化';
  const element = {};
  Object.defineProperty(element, 'textContent', {
    get() {
      return value;
    },
    set(next) {
      assignments += 1;
      value = next;
    },
  });
  const context = {};
  vm.createContext(context);
  vm.runInContext(functionSource('setTextIfChanged'), context);

  assert.equal(context.setTextIfChanged(element, '未变化'), false);
  assert.equal(assignments, 0);
  assert.equal(context.setTextIfChanged(element, '已变化'), true);
  assert.equal(assignments, 1);
  assert.equal(value, '已变化');
});

test('sequence result labels are consistent Chinese operator statuses', () => {
  const context = {};
  vm.createContext(context);
  vm.runInContext(functionSource('formatSequenceOverall'), context);

  assert.deepEqual(
    ['pass', 'ok', 'fail', 'error', 'aborted', 'running', 'waiting_resource', ''].map(
      context.formatSequenceOverall
    ),
    ['通过', '通过', '失败', '错误', '已中止', '执行中', '等待资源', '待执行']
  );
});

test('first sequence issue identifies the earliest abnormal channel step', () => {
  const context = {};
  vm.createContext(context);
  vm.runInContext(functionSource('findFirstSequenceIssue'), context);

  assert.equal(
    JSON.stringify(context.findFirstSequenceIssue([
      {
        channel_index: 0,
        steps: [
          { position: 0, status: 'pass' },
          { position: 1, status: 'skipped' },
        ],
      },
      {
        channel_index: 1,
        steps: [
          { position: 0, status: 'pass' },
          { position: 3, status: 'error' },
          { position: 4, status: 'fail' },
        ],
      },
    ])),
    JSON.stringify({ channel_index: 1, position: 3 })
  );
  assert.equal(
    context.findFirstSequenceIssue([
      { channel_index: 0, steps: [{ position: 0, status: 'ok' }] },
    ]),
    null
  );
});

test('sequence request failures leave running state on busy and network errors', async () => {
  for (const scenario of ['busy', 'network']) {
    let failureStates = 0;
    const results = { innerHTML: '' };
    const context = {
      seqRunning: false,
      seqSelected: [{}],
      seqActiveTemplateId: null,
      selectedChannelIndexesForRun() { return null; },
      setSeqControlsDisabled() {},
      clearSequenceResultsUi() {},
      document: {
        getElementById(id) {
          assert.equal(id, 'seq-results');
          return results;
        },
      },
      updateSeqOverall() {},
      showSeqMsg() {},
      startSequenceProgressPoll() {},
      stopSequenceProgressPoll() {},
      formatBusyConflictMessage() { return '机台忙碌'; },
      setSeqRequestFailureState() { failureStates += 1; },
      renderSeqChannelPick() {},
      renderSeqRegistered() {},
      fetch: scenario === 'busy'
        ? async () => ({
            ok: false,
            status: 409,
            async json() { return { can_force_release: false }; },
          })
        : async () => { throw new Error('offline'); },
    };
    vm.createContext(context);
    vm.runInContext(functionSource('runSequence'), context);

    await context.runSequence();

    assert.equal(failureStates, 1, scenario + ' must replace the running summary');
  }
});

test('stale sequence progress response is ignored after poll generation changes', async () => {
  let intervalCallback = null;
  let resolveJson = null;
  let applied = 0;
  const context = {
    seqProgressGeneration: 0,
    seqProgressPollTimer: null,
    stopSequenceProgressPoll() {
      context.seqProgressGeneration += 1;
    },
    setInterval(callback) {
      intervalCallback = callback;
      return 42;
    },
    async fetch() {
      return {
        ok: true,
        json() {
          return new Promise((resolve) => { resolveJson = resolve; });
        },
      };
    },
    applySequenceProgress() { applied += 1; },
  };
  vm.createContext(context);
  vm.runInContext(functionSource('startSequenceProgressPoll'), context);

  context.startSequenceProgressPoll();
  const pending = intervalCallback();
  while (!resolveJson) await Promise.resolve();
  context.seqProgressGeneration += 1;
  resolveJson({ running: true });
  await pending;

  assert.equal(applied, 0);
});

test('failure report is visible before render performs focus scrolling', () => {
  const report = { hidden: true };
  const reportOpen = { hidden: true };
  let hiddenWhenRendered = null;
  const context = {
    seqChannelProgress: [{ channel_index: 1, steps: [{ position: 3, status: 'fail' }] }],
    seqReportFocusChannelIndex: null,
    seqReportFocusPosition: null,
    document: {
      getElementById(id) {
        if (id === 'seq-run-report') return report;
        if (id === 'seq-run-report-open') return reportOpen;
        return null;
      },
    },
    findFirstSequenceIssue() { return { channel_index: 1, position: 3 }; },
    renderSeqRunReport() { hiddenWhenRendered = report.hidden; },
  };
  vm.createContext(context);
  vm.runInContext(functionSource('setSeqReportVisibilityForResult'), context);

  context.setSeqReportVisibilityForResult({ overall: 'fail' });

  assert.equal(hiddenWhenRendered, false);
  assert.equal(context.seqReportFocusChannelIndex, 1);
  assert.equal(context.seqReportFocusPosition, 3);
});

test('VI status copy distinguishes not run, run awaiting Name, and ready to register', () => {
  const context = {};
  vm.createContext(context);
  vm.runInContext(functionSource('lvStageMessage'), context);

  assert.equal(
    context.lvStageMessage({ state: 'ready_to_run', name: '', runResult: null }),
    '参数已查询，尚未试跑；可以试跑'
  );
  assert.equal(
    context.lvStageMessage({
      state: 'ready_to_run',
      name: 'Measure',
      runResult: null,
    }),
    '参数已查询，尚未试跑；可直接注册，试跑可选'
  );
  assert.equal(
    context.lvStageMessage({
      state: 'ready_to_run',
      name: '',
      runResult: { status: 'ok' },
    }),
    '试跑完成，等待填写名称'
  );
  assert.equal(
    context.lvStageMessage({
      state: 'ready_to_register',
      name: 'Measure',
      runResult: { status: 'ok' },
    }),
    '试跑完成，已命名，可以注册'
  );
});

test('every VI stage exposes visible status text instead of color alone', () => {
  const context = {};
  vm.createContext(context);
  vm.runInContext(functionSource('lvStageStatusText'), context);

  assert.deepEqual(
    ['current', 'optional', 'complete', 'waiting'].map(context.lvStageStatusText),
    ['当前', '可选', '完成', '待处理']
  );
  assert.equal(
    (INDEX_SOURCE.match(/class="lv-stage-state">待处理<\/span>/g) || []).length,
    4
  );
  assert.equal(
    (INDEX_SOURCE.match(/class="lv-stage-state">当前<\/span>/g) || []).length,
    1
  );
});

test('Center VI load buttons lock and expose a busy reason with the editor', () => {
  const buttons = [{ disabled: false, title: '' }, { disabled: false, title: '' }];
  const context = {
    document: {
      querySelectorAll(selector) {
        assert.equal(selector, '#lv-center-body .lv-load-template');
        return buttons;
      },
    },
  };
  vm.createContext(context);
  vm.runInContext(functionSource('syncLvTemplateLoadButtons'), context);

  context.syncLvTemplateLoadButtons(true);
  assert.deepEqual(buttons, [
    { disabled: true, title: '操作进行中' },
    { disabled: true, title: '操作进行中' },
  ]);

  context.syncLvTemplateLoadButtons(false);
  assert.deepEqual(buttons, [
    { disabled: false, title: '' },
    { disabled: false, title: '' },
  ]);
});

test('rendered scalar and structured parameters have standard and accessible names', () => {
  const tbody = {
    innerHTML: '',
    children: [],
    appendChild(row) {
      this.children.push(row);
    },
  };
  const context = {
    document: {
      getElementById(id) {
        assert.equal(id, 'lv-inputs-body');
        return tbody;
      },
      createElement(tagName) {
        assert.equal(tagName, 'tr');
        return { innerHTML: '' };
      },
    },
    escapeHtml(value) {
      return String(value == null ? '' : value);
    },
    attachVarPickersIn(root) {
      assert.equal(root, tbody);
    },
  };
  vm.createContext(context);
  vm.runInContext(functionSource('isJsonScalar'), context);
  vm.runInContext(functionSource('renderInputsTable'), context);

  context.renderInputsTable([
    { name: 'speed', className: 'Double', value: 1.5 },
    { name: 'config', className: 'Cluster', value: { mode: 'fast' } },
  ]);

  assert.equal(tbody.children.length, 2);
  assert.match(tbody.children[0].innerHTML, /<input[^>]+data-name="speed"/);
  assert.match(tbody.children[0].innerHTML, /<input[^>]+\sname="speed"/);
  assert.match(tbody.children[0].innerHTML, /<label for="lv-input-0">speed<\/label>/);
  assert.match(tbody.children[0].innerHTML, /<input[^>]+\sid="lv-input-0"/);
  assert.match(tbody.children[1].innerHTML, /<textarea[^>]+data-name="config"/);
  assert.match(tbody.children[1].innerHTML, /<textarea[^>]+\sname="config"/);
  assert.match(tbody.children[1].innerHTML, /<label for="lv-input-1">config<\/label>/);
  assert.match(tbody.children[1].innerHTML, /<textarea[^>]+\sid="lv-input-1"/);
});

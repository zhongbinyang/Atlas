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

test('measurement rows align measured values with range and equality specs', () => {
  const context = {};
  vm.createContext(context);
  vm.runInContext(functionSource('normalizeSpecOp'), context);
  vm.runInContext(functionSource('lookupMeasuredValue'), context);
  vm.runInContext(functionSource('formatLimitBoundDisplay'), context);
  vm.runInContext(functionSource('formatStepStatus'), context);
  vm.runInContext(functionSource('buildSequenceMetricRows'), context);

  assert.deepEqual(
    JSON.parse(JSON.stringify(context.buildSequenceMetricRows({
      limits: [
        { output: 'voltage', op: 'range', min: 4.5, max: 5.5, unit: 'V' },
        { output: 'mode', op: 'eq', expect: 'AUTO' },
      ],
    }, {
      status: 'fail',
      measured: { voltage: 4.9, mode: 'MANUAL' },
    }))),
    [
      { output: 'voltage', value: '4.9', min: '4.5', max: '5.5', unit: 'V', result: '失败' },
      { output: 'mode', value: 'MANUAL', min: 'AUTO', max: '—', unit: '—', result: '失败' },
    ]
  );
});

test('multi-channel progress keeps unfinished channels running between step publications', () => {
  const context = {};
  vm.createContext(context);
  vm.runInContext(functionSource('channelProgressFromEnvelope'), context);

  const channels = context.channelProgressFromEnvelope({
    running: true,
    channels: [
      { channel_index: 0, name: 'CH0', steps: [], current_position: null },
      {
        channel_index: 1,
        name: 'CH1',
        steps: [],
        current_position: 2,
        current_name: 'Measure',
        elapsed_ms: 900,
        current_step_elapsed_ms: 250,
      },
      { channel_index: 2, name: 'CH2', steps: [], overall: 'pass' },
    ],
  });

  assert.deepEqual(Array.from(channels, (channel) => channel.running), [true, true, false]);
  assert.equal(channels[1].elapsed_ms, 900);
  assert.equal(channels[1].current_step_elapsed_ms, 250);
});

test('final multi-channel envelope preserves backend channel and step timing', () => {
  const context = {};
  vm.createContext(context);
  vm.runInContext(functionSource('multiEnvelopeToProgress'), context);

  const progress = context.multiEnvelopeToProgress({
    overall: 'pass',
    channels: [{
      channel_index: 0,
      channel_name: 'CH0',
      response: {
        overall: 'pass',
        elapsed_ms: 87,
        steps: [{ position: 0, status: 'pass', elapsed_ms: 61 }],
      },
    }],
  });

  assert.equal(progress.channels[0].elapsed_ms, 87);
  assert.equal(progress.channels[0].steps[0].elapsed_ms, 61);
});

test('channel card model exposes current work, counts, and backend timing', () => {
  const context = {};
  vm.createContext(context);
  vm.runInContext(functionSource('buildSequenceChannelCardModel'), context);

  assert.deepEqual(
    JSON.parse(JSON.stringify(context.buildSequenceChannelCardModel({
      channel_index: 1,
      name: 'CH1',
      running: true,
      current_position: 2,
      current_name: 'Measure',
      elapsed_ms: 1326,
      current_step_elapsed_ms: 418,
      steps: [
        { position: 0, status: 'pass' },
        { position: 1, status: 'skipped' },
      ],
    }, [{}, {}, {}, {}]))),
    {
      state: 'running',
      currentName: 'Measure',
      currentPosition: 2,
      completed: 2,
      total: 4,
      passed: 1,
      failed: 0,
      skipped: 1,
      elapsedMs: 1326,
      currentElapsedMs: 418,
    }
  );
});

test('channel card model is ready before the first run', () => {
  const context = {};
  vm.createContext(context);
  vm.runInContext(functionSource('buildSequenceChannelCardModel'), context);

  assert.deepEqual(
    JSON.parse(JSON.stringify(context.buildSequenceChannelCardModel({
      channel_index: 0,
      name: 'CH0',
      steps: [],
      overall: null,
      running: false,
    }, [{}, {}, {}]))),
    {
      state: 'idle',
      currentName: '等待运行',
      currentPosition: null,
      completed: 0,
      total: 3,
      passed: 0,
      failed: 0,
      skipped: 0,
      elapsedMs: 0,
      currentElapsedMs: null,
    }
  );
});

test('sequence run payload isolates an explicit card channel without changing top selection', () => {
  const context = {};
  vm.createContext(context);
  vm.runInContext(functionSource('buildSequenceRunPayload'), context);

  const selected = [0, 1];
  const explicit = [3];
  const cardPayload = context.buildSequenceRunPayload(12, selected, explicit);
  const topPayload = context.buildSequenceRunPayload(12, selected, null);

  assert.deepEqual(JSON.parse(JSON.stringify(cardPayload)), {
    sequence_template_id: 12,
    channel_indexes: [3],
  });
  assert.deepEqual(JSON.parse(JSON.stringify(topPayload)), {
    sequence_template_id: 12,
    channel_indexes: [0, 1],
  });
  assert.deepEqual(selected, [0, 1]);
  assert.deepEqual(explicit, [3]);
});

test('sequence run payload omits channel indexes when top selection means all enabled', () => {
  const context = {};
  vm.createContext(context);
  vm.runInContext(functionSource('buildSequenceRunPayload'), context);

  assert.deepEqual(
    JSON.parse(JSON.stringify(context.buildSequenceRunPayload(null, null, null))),
    {}
  );
});

test('synthetic sequence card run posts without channel indexes', async () => {
  let request = null;
  const results = { innerHTML: '' };
  const context = {
    seqRunning: false,
    seqSelected: [{}],
    seqActiveTemplateId: 12,
    selectedChannelIndexesForRun() { return null; },
    captureSequenceChannelCardFocus() { return null; },
    setSeqControlsDisabled() {},
    clearSequenceResultsUi() {},
    document: {
      getElementById(id) {
        if (id === 'seq-channel-cards') return null;
        assert.equal(id, 'seq-results');
        return results;
      },
    },
    updateSeqOverall() {},
    showSeqMsg() {},
    startSequenceProgressPoll() {},
    stopSequenceProgressPoll() {},
    handleSequenceResponse() {},
    setSeqRequestFailureState() {},
    renderSeqChannelPick() {},
    renderSeqRegistered() {},
    async fetch(path, options) {
      request = { path, options };
      return {
        ok: true,
        async json() { return {}; },
      };
    },
  };
  vm.createContext(context);
  vm.runInContext(functionSource('pendingSequenceChannelsForOperator'), context);
  vm.runInContext(functionSource('sequenceCardRunChannelIndexes'), context);
  vm.runInContext(functionSource('sequenceRunQueueItems'), context);
  vm.runInContext(functionSource('buildSequenceRunPayload'), context);
  vm.runInContext(functionSource('runSequence'), context);

  const syntheticCard = context.pendingSequenceChannelsForOperator([], null)[0];
  const cardChannelIndexes = context.sequenceCardRunChannelIndexes(syntheticCard);
  await context.runSequence(cardChannelIndexes, true);

  assert.equal(syntheticCard.synthetic, true);
  assert.equal(cardChannelIndexes, undefined);
  assert.equal(request.path, '/api/sequence/run');
  assert.deepEqual(JSON.parse(request.options.body), {
    sequence_template_id: 12,
  });
  assert.equal(Object.hasOwn(JSON.parse(request.options.body), 'channel_indexes'), false);
});

test('channel detail model keeps the complete queue pending before execution', () => {
  const context = {};
  vm.createContext(context);
  vm.runInContext(functionSource('buildSequenceDetailSections'), context);
  vm.runInContext(functionSource('isSequenceIssueStatus'), context);
  vm.runInContext(functionSource('sequenceStatusVisualState'), context);
  vm.runInContext(functionSource('buildSequenceGroupSummary'), context);
  vm.runInContext(functionSource('buildSequenceChannelDetailModel'), context);

  assert.deepEqual(
    JSON.parse(JSON.stringify(context.buildSequenceChannelDetailModel(
      { channel_index: 0, name: 'CH0', steps: [], overall: null },
      [
        { position: 0, name: 'Prepare' },
        { position: 1, name: 'Measure', inputs: { target: 20 } },
      ]
    ).steps)),
    [
      { position: 0, name: 'Prepare', status: 'pending', elapsedMs: null, item: { position: 0, name: 'Prepare' }, result: null },
      { position: 1, name: 'Measure', status: 'pending', elapsedMs: null, item: { position: 1, name: 'Measure', inputs: { target: 20 } }, result: null },
    ]
  );
});

test('channel detail model preserves terminal status and recorded step time', () => {
  const context = {};
  vm.createContext(context);
  vm.runInContext(functionSource('buildSequenceDetailSections'), context);
  vm.runInContext(functionSource('isSequenceIssueStatus'), context);
  vm.runInContext(functionSource('sequenceStatusVisualState'), context);
  vm.runInContext(functionSource('buildSequenceGroupSummary'), context);
  vm.runInContext(functionSource('buildSequenceChannelDetailModel'), context);

  const model = context.buildSequenceChannelDetailModel({
    channel_index: 0,
    name: 'CH0',
    elapsed_ms: 80,
    overall: 'pass',
    steps: [{ position: 0, name: 'Measure', status: 'pass', elapsed_ms: 61 }],
  }, [{ position: 0, name: 'Measure' }]);

  assert.equal(model.elapsedMs, 80);
  assert.equal(model.steps[0].status, 'pass');
  assert.equal(model.steps[0].elapsedMs, 61);
});

test('channel detail retains flat steps and adds named group sections', () => {
  const context = {};
  vm.createContext(context);
  vm.runInContext(functionSource('buildSequenceDetailSections'), context);
  vm.runInContext(functionSource('isSequenceIssueStatus'), context);
  vm.runInContext(functionSource('sequenceStatusVisualState'), context);
  vm.runInContext(functionSource('buildSequenceGroupSummary'), context);
  vm.runInContext(functionSource('buildSequenceChannelDetailModel'), context);

  const model = context.buildSequenceChannelDetailModel({
    channel_index: 0,
    name: 'CH0',
    steps: [{ position: 0, status: 'pass' }, { position: 2, status: 'running' }],
  }, [
    { position: 0, name: 'Root' },
    { position: 1, template_source: 'group', name: '校准', collapsed: true },
    { position: 2, name: 'Measure' },
  ]);

  assert.deepEqual(JSON.parse(JSON.stringify({
    positions: model.steps.map((step) => step.position),
    namedGroupCount: model.namedGroupCount,
    sections: model.sections.map((section) => ({
      title: section.title,
      positions: section.steps.map((step) => step.position),
      state: section.summary.state,
      open: section.summary.open,
    })),
  })), {
    positions: [0, 2],
    namedGroupCount: 1,
    sections: [
      { title: '未分组步骤', positions: [0], state: 'pass', open: true },
      { title: '校准', positions: [2], state: 'running', open: true },
    ],
  });
});

test('channel detail projects persisted groups without counting headers as steps', () => {
  const context = {};
  vm.createContext(context);
  vm.runInContext(functionSource('buildSequenceDetailSections'), context);

  const sections = context.buildSequenceDetailSections([
    { position: 0, name: 'Root' },
    { position: 1, template_source: 'group', name: '校准', note: '连接仪表', enabled: true, collapsed: true },
    { position: 2, name: 'Zero' },
    { position: 3, name: 'Measure' },
    { position: 4, template_source: 'group', name: '收尾', enabled: false, collapsed: false },
    { position: 5, name: 'Reset' },
  ], [
    { position: 0, name: 'Root', status: 'pending' },
    { position: 2, name: 'Zero', status: 'pass' },
    { position: 3, name: 'Measure', status: 'running' },
    { position: 5, name: 'Reset', status: 'skipped' },
  ]);

  assert.deepEqual(JSON.parse(JSON.stringify(sections.map((section) => ({
    kind: section.kind,
    title: section.title,
    positions: section.steps.map((step) => step.position),
  })))), [
    { kind: 'ungrouped', title: '未分组步骤', positions: [0] },
    { kind: 'group', title: '校准', positions: [2, 3] },
    { kind: 'group', title: '收尾', positions: [5] },
  ]);
});

test('group summaries prioritize disabled, active, failure, and terminal member states', () => {
  const context = {};
  vm.createContext(context);
  vm.runInContext(functionSource('isSequenceIssueStatus'), context);
  vm.runInContext(functionSource('sequenceStatusVisualState'), context);
  vm.runInContext(functionSource('buildSequenceGroupSummary'), context);
  const summary = context.buildSequenceGroupSummary;

  assert.equal(summary({ enabled: false, steps: [{ status: 'skipped' }] }).state, 'disabled');
  assert.equal(summary({ enabled: true, collapsed: true, steps: [{ status: 'running' }] }).state, 'running');
  assert.equal(summary({ enabled: true, steps: [{ status: 'pass' }, { status: 'error' }] }).state, 'fail');
  assert.equal(summary({ enabled: true, steps: [{ status: 'pass' }, { status: 'skipped' }] }).state, 'pass');
  assert.equal(summary({ enabled: true, steps: [{ status: 'skipped' }] }).state, 'skipped');
  assert.equal(summary({ enabled: true, steps: [{ status: 'pass' }, { status: 'pending' }] }).state, 'pending');
});

test('group summaries keep active and issue variants open when collapsed', () => {
  const context = {};
  vm.createContext(context);
  vm.runInContext(functionSource('isSequenceIssueStatus'), context);
  vm.runInContext(functionSource('sequenceStatusVisualState'), context);
  vm.runInContext(functionSource('buildSequenceGroupSummary'), context);
  const summary = context.buildSequenceGroupSummary;

  [
    ['waiting_resource', 'running'],
    ['failed', 'fail'],
    ['stopped', 'fail'],
  ].forEach(([status, expectedState]) => {
    const result = summary({ enabled: true, collapsed: true, steps: [{ status }] });
    assert.equal(result.state, expectedState, status);
    assert.equal(result.open, true, status);
  });
});

test('group summaries count terminal members and keep inactive collapsed groups closed', () => {
  const context = {};
  vm.createContext(context);
  vm.runInContext(functionSource('isSequenceIssueStatus'), context);
  vm.runInContext(functionSource('sequenceStatusVisualState'), context);
  vm.runInContext(functionSource('buildSequenceGroupSummary'), context);

  assert.deepEqual(
    JSON.parse(JSON.stringify(context.buildSequenceGroupSummary({
      enabled: true,
      collapsed: true,
      steps: [{ status: 'pass' }, { status: 'fail' }, { status: 'skipped' }, { status: 'pending' }],
    }))),
    { state: 'fail', completed: 3, total: 4, passed: 1, failed: 1, skipped: 1, open: true }
  );
  assert.equal(
    context.buildSequenceGroupSummary({
      enabled: true,
      collapsed: true,
      steps: [{ status: 'pending' }],
    }).open,
    false
  );
});

test('group disclosure prefers forced expansion, then polling state, then initial state', () => {
  const context = {};
  vm.createContext(context);
  vm.runInContext(functionSource('resolveSequenceGroupOpen'), context);

  assert.equal(context.resolveSequenceGroupOpen(false, null, false), false);
  assert.equal(context.resolveSequenceGroupOpen(true, false, false), false);
  assert.equal(context.resolveSequenceGroupOpen(false, false, true), true);
  assert.equal(context.resolveSequenceGroupOpen(false, true, false), true);
});

test('focus restoration prevents scrolling and restores scroll after fallback', () => {
  const normalCalls = [];
  const normalContext = {};
  vm.createContext(normalContext);
  vm.runInContext(functionSource('focusWithoutScroll'), normalContext);
  normalContext.focusWithoutScroll({
    focus(options) { normalCalls.push(options); },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(normalCalls)), [{ preventScroll: true }]);

  const scroll = { left: 37, top: 49 };
  const fallbackContext = {
    window: {
      get scrollX() { return scroll.left; },
      get scrollY() { return scroll.top; },
      scrollTo(left, top) {
        scroll.left = left;
        scroll.top = top;
      },
    },
  };
  vm.createContext(fallbackContext);
  vm.runInContext(functionSource('focusWithoutScroll'), fallbackContext);
  fallbackContext.focusWithoutScroll({
    focus(options) {
      if (options) throw new Error('preventScroll unsupported');
      scroll.left = 0;
      scroll.top = 0;
    },
  });
  assert.deepEqual(scroll, { left: 37, top: 49 });
});

test('channel card focus capture remembers the focused descendant kind', () => {
  const card = {
    getAttribute(name) {
      assert.equal(name, 'data-channel-index');
      return '4';
    },
  };
  const context = { document: { activeElement: null } };
  const host = {
    contains(element) { return element === context.document.activeElement; },
  };
  vm.createContext(context);
  vm.runInContext(functionSource('captureSequenceChannelCardFocus'), context);

  for (const [className, kind] of [
    ['seq-channel-card-body', 'body'],
    ['seq-channel-card-run', 'run'],
    ['seq-channel-card-detail', 'detail'],
  ]) {
    context.document.activeElement = {
      classList: {
        contains(name) { return name === className; },
      },
      closest(selector) {
        assert.equal(selector, '.seq-channel-card[data-channel-index]');
        return card;
      },
    };
    assert.deepEqual(
      JSON.parse(JSON.stringify(context.captureSequenceChannelCardFocus(host))),
      { channelIndex: '4', kind }
    );
  }
});

test('channel card focus restore keeps enabled run and detail controls without scrolling', () => {
  const focusCalls = [];
  const body = { focus(options) { focusCalls.push(['body', options]); } };
  const run = { disabled: false, focus(options) { focusCalls.push(['run', options]); } };
  const detail = { focus(options) { focusCalls.push(['detail', options]); } };
  const card = {
    querySelector(selector) {
      return {
        '.seq-channel-card-body': body,
        '.seq-channel-card-run': run,
        '.seq-channel-card-detail': detail,
      }[selector] || null;
    },
  };
  const host = {
    querySelector(selector) {
      assert.equal(selector, '.seq-channel-card[data-channel-index="2"]');
      return card;
    },
  };
  const context = {};
  vm.createContext(context);
  vm.runInContext(functionSource('focusWithoutScroll'), context);
  vm.runInContext(functionSource('restoreSequenceChannelCardFocus'), context);

  context.restoreSequenceChannelCardFocus(host, { channelIndex: '2', kind: 'body' });
  context.restoreSequenceChannelCardFocus(host, { channelIndex: '2', kind: 'run' });
  context.restoreSequenceChannelCardFocus(host, { channelIndex: '2', kind: 'detail' });

  assert.deepEqual(JSON.parse(JSON.stringify(focusCalls)), [
    ['body', { preventScroll: true }],
    ['run', { preventScroll: true }],
    ['detail', { preventScroll: true }],
  ]);
});

test('channel card focus restore falls back to the card body when run becomes disabled', () => {
  const focusCalls = [];
  const body = { focus(options) { focusCalls.push(['body', options]); } };
  const run = { disabled: true, focus(options) { focusCalls.push(['run', options]); } };
  const card = {
    querySelector(selector) {
      return selector === '.seq-channel-card-run' ? run : body;
    },
  };
  const host = { querySelector() { return card; } };
  const context = {};
  vm.createContext(context);
  vm.runInContext(functionSource('focusWithoutScroll'), context);
  vm.runInContext(functionSource('restoreSequenceChannelCardFocus'), context);

  context.restoreSequenceChannelCardFocus(host, { channelIndex: '0', kind: 'run' });

  assert.deepEqual(JSON.parse(JSON.stringify(focusCalls)), [
    ['body', { preventScroll: true }],
  ]);
});

test('sequence run captures focused card control before lock and threads it into the first rerender', async () => {
  const events = [];
  const body = {
    focus(options) { events.push(['focus', 'body', options]); },
  };
  const run = {
    disabled: false,
    classList: {
      contains(name) { return name === 'seq-channel-card-run'; },
    },
    closest(selector) {
      assert.equal(selector, '.seq-channel-card[data-channel-index]');
      return card;
    },
    focus(options) { events.push(['focus', 'run', options]); },
  };
  const card = {
    getAttribute(name) {
      assert.equal(name, 'data-channel-index');
      return '0';
    },
    querySelector(selector) {
      return selector === '.seq-channel-card-run' ? run : body;
    },
  };
  const outside = { classList: { contains() { return false; } } };
  const host = {
    contains(element) {
      events.push(['capture', element === run ? 'run' : 'other']);
      return element === run;
    },
    querySelector() { return card; },
  };
  const results = { innerHTML: '', hidden: false };
  const context = {
    seqRunning: false,
    seqSelected: [{}],
    seqActiveTemplateId: null,
    seqStepResults: {},
    seqChannelProgress: [],
    selectedChannelIndexesForRun() { return [0]; },
    setSeqControlsDisabled(disabled) {
      events.push(['lock', disabled]);
      run.disabled = disabled;
      if (disabled) context.document.activeElement = outside;
    },
    document: {
      activeElement: run,
      getElementById(id) {
        return id === 'seq-channel-cards' ? host : results;
      },
    },
    updateSeqOverall() {},
    renderSeqChannelCards(preservedFocus) {
      events.push(['render', preservedFocus && preservedFocus.kind]);
      context.restoreSequenceChannelCardFocus(host, preservedFocus);
    },
    renderSeqChannelDetail() {},
    renderSeqSelected() {},
    showSeqMsg() {},
    startSequenceProgressPoll() {},
    stopSequenceProgressPoll() {},
    handleSequenceResponse() {},
    setSeqRequestFailureState() {},
    renderSeqChannelPick() {},
    renderSeqRegistered() {},
    async fetch() {
      return { ok: true, async json() { return {}; } };
    },
  };
  vm.createContext(context);
  vm.runInContext(functionSource('focusWithoutScroll'), context);
  vm.runInContext(functionSource('captureSequenceChannelCardFocus'), context);
  vm.runInContext(functionSource('restoreSequenceChannelCardFocus'), context);
  vm.runInContext(functionSource('sequenceRunQueueItems'), context);
  vm.runInContext(functionSource('buildSequenceRunPayload'), context);
  vm.runInContext(functionSource('clearSequenceResultsUi'), context);
  vm.runInContext(functionSource('runSequence'), context);

  await context.runSequence([0], false);

  assert.deepEqual(JSON.parse(JSON.stringify(events.slice(0, 4))), [
    ['capture', 'run'],
    ['lock', true],
    ['render', 'run'],
    ['focus', 'body', { preventScroll: true }],
  ]);
});

test('channel models discard group-header result and current-position collisions', () => {
  const context = {};
  vm.createContext(context);
  vm.runInContext(functionSource('buildSequenceChannelCardModel'), context);
  vm.runInContext(functionSource('buildSequenceDetailSections'), context);
  vm.runInContext(functionSource('isSequenceIssueStatus'), context);
  vm.runInContext(functionSource('sequenceStatusVisualState'), context);
  vm.runInContext(functionSource('buildSequenceGroupSummary'), context);
  vm.runInContext(functionSource('buildSequenceChannelDetailModel'), context);

  const channel = {
    channel_index: 0,
    name: 'CH0',
    running: true,
    current_position: 1,
    current_name: 'Unexpected header result',
    current_step_elapsed_ms: 10,
    steps: [
      { position: 1, name: 'Unexpected header result', status: 'fail', elapsed_ms: 10 },
      { position: 2, name: 'Measure', status: 'pass', elapsed_ms: 20 },
    ],
  };
  const queue = [
    { position: 1, template_source: 'group', name: '校准' },
    { position: 2, name: 'Measure' },
  ];
  const card = context.buildSequenceChannelCardModel(channel, queue);
  const model = context.buildSequenceChannelDetailModel(channel, queue);

  assert.deepEqual(
    JSON.parse(JSON.stringify({
      total: card.total,
      completed: card.completed,
      passed: card.passed,
      failed: card.failed,
      skipped: card.skipped,
      currentPosition: card.currentPosition,
      currentName: card.currentName,
      currentElapsedMs: card.currentElapsedMs,
    })),
    {
      total: 1,
      completed: 1,
      passed: 1,
      failed: 0,
      skipped: 0,
      currentPosition: null,
      currentName: '准备下一步骤',
      currentElapsedMs: null,
    }
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify({
      namedGroupCount: model.namedGroupCount,
      currentPosition: model.currentPosition,
      currentName: model.currentName,
      currentElapsedMs: model.currentElapsedMs,
      steps: model.steps.map((step) => ({ position: step.position, elapsedMs: step.elapsedMs })),
      summary: model.sections[0].summary,
    })),
    {
      namedGroupCount: 1,
      currentPosition: null,
      currentName: null,
      currentElapsedMs: null,
      steps: [{ position: 2, elapsedMs: 20 }],
      summary: { state: 'pass', completed: 1, total: 1, passed: 1, failed: 0, skipped: 0, open: true },
    }
  );
});

test('channel detail keeps unmatched backend results in an ordered fallback section', () => {
  const context = {};
  vm.createContext(context);
  vm.runInContext(functionSource('buildSequenceDetailSections'), context);
  vm.runInContext(functionSource('isSequenceIssueStatus'), context);
  vm.runInContext(functionSource('sequenceStatusVisualState'), context);
  vm.runInContext(functionSource('buildSequenceGroupSummary'), context);
  vm.runInContext(functionSource('buildSequenceChannelDetailModel'), context);

  const model = context.buildSequenceChannelDetailModel({
    channel_index: 0,
    name: 'CH0',
    steps: [
      { position: 9, name: 'Old reset', status: 'failed', elapsed_ms: 90, result: { code: 'reset' } },
      { position: 1, name: 'Unexpected header result', status: 'pass', elapsed_ms: 10 },
      { position: 7, name: 'Old measure', status: 'pass', elapsed_ms: 70, result: { voltage: 4.9 } },
      { position: 2, name: 'Current measure', status: 'pass', elapsed_ms: 20 },
    ],
  }, [
    { position: 1, template_source: 'group', name: '校准' },
    { position: 2, name: 'Current measure' },
  ]);

  assert.deepEqual(
    JSON.parse(JSON.stringify(model.sections.map((section) => ({
      kind: section.kind,
      title: section.title,
      positions: section.steps.map((step) => step.position),
    })))),
    [
      { kind: 'group', title: '校准', positions: [2] },
      { kind: 'result-only', title: '历史运行结果', positions: [7, 9] },
    ]
  );
  const fallback = model.sections[1];
  assert.deepEqual(
    JSON.parse(JSON.stringify(fallback.steps.map((step) => step.elapsedMs))),
    [70, 90]
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(fallback.steps.map((step) => step.result.result))),
    [{ voltage: 4.9 }, { code: 'reset' }]
  );
  assert.equal(model.namedGroupCount, 1);
});

test('sequence elapsed formatter is stable from milliseconds through hours', () => {
  const context = {};
  vm.createContext(context);
  vm.runInContext(functionSource('formatSequenceElapsed'), context);

  assert.equal(context.formatSequenceElapsed(0), '00:00.000');
  assert.equal(context.formatSequenceElapsed(1326), '00:01.326');
  assert.equal(context.formatSequenceElapsed(3661007), '01:01:01.007');
  assert.equal(context.formatSequenceElapsed(null), '—');
});

test('operator console creates pending cards for the currently selected channels', () => {
  const context = {};
  vm.createContext(context);
  vm.runInContext(functionSource('pendingSequenceChannelsForOperator'), context);

  const pending = context.pendingSequenceChannelsForOperator([
    { channel_index: 0, name: 'CH0' },
    { channel_index: 1, name: 'CH1' },
  ], [1]);

  assert.deepEqual(JSON.parse(JSON.stringify(pending)), [
    { channel_index: 1, name: 'CH1', steps: [], overall: null, running: false, synthetic: false },
  ]);
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.pendingSequenceChannelsForOperator([], null))),
    [{ channel_index: 0, name: 'CH0', steps: [], overall: null, running: false, synthetic: true }]
  );
});

test('sequence card synthetic identity survives result and configuration transitions', () => {
  const context = {
    enabled: [{ channel_index: 2, name: 'Fixture CH2' }],
    seqSelectedChannelIndexes: null,
    seqChannelProgress: [],
    seqRunUsesSyntheticChannel: false,
    seqStepResults: {},
    enabledAgentChannels() { return context.enabled; },
    renderSeqChannelCards() {},
    renderSeqChannelDetail() {},
    renderSeqSelected() {},
  };
  vm.createContext(context);
  vm.runInContext(functionSource('pendingSequenceChannelsForOperator'), context);
  vm.runInContext(functionSource('channelProgressFromEnvelope'), context);
  vm.runInContext(functionSource('applyMultiChannelProgress'), context);
  vm.runInContext(functionSource('sequenceChannelsForDisplay'), context);
  vm.runInContext(functionSource('sequenceCardRunChannelIndexes'), context);
  vm.runInContext(functionSource('buildSequenceRunPayload'), context);

  context.applyMultiChannelProgress({
    running: false,
    channels: [{ channel_index: 2, name: 'Fixture CH2', overall: 'pass', steps: [] }],
  });
  context.enabled = [];
  const retainedConfigured = context.sequenceChannelsForDisplay();

  const initialSynthetic = context.pendingSequenceChannelsForOperator([], null)[0];
  context.seqRunUsesSyntheticChannel = true;
  context.applyMultiChannelProgress({
    running: false,
    channels: [{ channel_index: 0, name: 'CH0', overall: 'pass', steps: [] }],
  });
  const completedSynthetic = context.seqChannelProgress[0];

  assert.equal(retainedConfigured[0].synthetic, false);
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.sequenceCardRunChannelIndexes(retainedConfigured[0]))),
    [2]
  );
  for (const syntheticCard of [initialSynthetic, completedSynthetic]) {
    assert.equal(syntheticCard.synthetic, true);
    const indexes = context.sequenceCardRunChannelIndexes(syntheticCard);
    assert.equal(indexes, undefined);
    assert.equal(
      Object.hasOwn(context.buildSequenceRunPayload(null, null, indexes), 'channel_indexes'),
      false
    );
  }
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
      enabledAgentChannels() { return [{ channel_index: 0 }]; },
      captureSequenceChannelCardFocus() { return null; },
      setSeqControlsDisabled() {},
      clearSequenceResultsUi() {},
      document: {
        getElementById(id) {
          if (id === 'seq-channel-cards') return null;
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
    vm.runInContext(functionSource('sequenceRunQueueItems'), context);
    vm.runInContext(functionSource('buildSequenceRunPayload'), context);
    vm.runInContext(functionSource('runSequence'), context);

    await context.runSequence();

    assert.equal(failureStates, 1, scenario + ' must replace the running summary');
  }
});

test('sequence card run posts only its explicit channel without changing top selection', async () => {
  const selected = [0, 1];
  let request = null;
  const results = { innerHTML: '' };
  const context = {
    seqRunning: false,
    seqSelected: [{}],
    seqActiveTemplateId: 12,
    selectedChannelIndexesForRun() { return selected; },
    captureSequenceChannelCardFocus() { return null; },
    setSeqControlsDisabled() {},
    clearSequenceResultsUi() {},
    document: {
      getElementById(id) {
        if (id === 'seq-channel-cards') return null;
        assert.equal(id, 'seq-results');
        return results;
      },
    },
    updateSeqOverall() {},
    showSeqMsg() {},
    startSequenceProgressPoll() {},
    stopSequenceProgressPoll() {},
    handleSequenceResponse() {},
    setSeqRequestFailureState() {},
    renderSeqChannelPick() {},
    renderSeqRegistered() {},
    async fetch(path, options) {
      request = { path, options };
      return {
        ok: true,
        async json() { return {}; },
      };
    },
  };
  vm.createContext(context);
  vm.runInContext(functionSource('sequenceCardRunChannelIndexes'), context);
  vm.runInContext(functionSource('sequenceRunQueueItems'), context);
  vm.runInContext(functionSource('buildSequenceRunPayload'), context);
  vm.runInContext(functionSource('runSequence'), context);

  const cardChannelIndexes = context.sequenceCardRunChannelIndexes({
    channel_index: 3,
    synthetic: false,
  });
  await context.runSequence(cardChannelIndexes, false);

  assert.equal(request.path, '/api/sequence/run');
  assert.deepEqual(JSON.parse(request.options.body), {
    sequence_template_id: 12,
    channel_indexes: [3],
  });
  assert.deepEqual(selected, [0, 1]);
});

test('zero-argument top sequence run posts the current channel selection', async () => {
  let request = null;
  const results = { innerHTML: '' };
  const context = {
    seqRunning: false,
    seqSelected: [{}],
    seqActiveTemplateId: null,
    selectedChannelIndexesForRun() { return [1]; },
    enabledAgentChannels() { return [{ channel_index: 1 }]; },
    captureSequenceChannelCardFocus() { return null; },
    setSeqControlsDisabled() {},
    clearSequenceResultsUi() {},
    document: {
      getElementById(id) {
        if (id === 'seq-channel-cards') return null;
        assert.equal(id, 'seq-results');
        return results;
      },
    },
    updateSeqOverall() {},
    showSeqMsg() {},
    startSequenceProgressPoll() {},
    stopSequenceProgressPoll() {},
    handleSequenceResponse() {},
    setSeqRequestFailureState() {},
    renderSeqChannelPick() {},
    renderSeqRegistered() {},
    async fetch(path, options) {
      request = { path, options };
      return {
        ok: true,
        async json() { return {}; },
      };
    },
  };
  vm.createContext(context);
  vm.runInContext(functionSource('sequenceRunQueueItems'), context);
  vm.runInContext(functionSource('buildSequenceRunPayload'), context);
  vm.runInContext(functionSource('runSequence'), context);

  await context.runSequence();

  assert.equal(request.path, '/api/sequence/run');
  assert.deepEqual(JSON.parse(request.options.body), { channel_indexes: [1] });
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

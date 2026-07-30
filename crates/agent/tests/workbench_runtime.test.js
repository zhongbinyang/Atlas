'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createWorkbenchRuntime,
  normalizeFsPath,
} = require('../static/workbench-runtime.js');

test('empty state only permits path and name editing', () => {
  const snapshot = createWorkbenchRuntime().snapshot();

  assert.equal(snapshot.state, 'empty');
  assert.equal(snapshot.controls.pathDisabled, false);
  assert.equal(snapshot.controls.nameDisabled, false);
  assert.equal(snapshot.controls.advancedDisabled, true);
  assert.equal(snapshot.controls.inspect.enabled, false);
  assert.equal(snapshot.controls.run.enabled, false);
  assert.equal(snapshot.controls.register.enabled, false);
});

test('path input invalidates inspected schemas and run results immediately', () => {
  const runtime = createWorkbenchRuntime();
  runtime.loadTemplate({
    vi_path: String.raw`C:\VI\Adder.vi`,
    name: 'Adder',
    inputs: [{ name: 'a' }],
    outputs: [{ name: 'sum' }],
  });
  assert.equal(runtime.beginRun(), true);
  runtime.runSucceeded({ outputs: { sum: 3 } });

  runtime.inputPath(String.raw`C:\VI\Multiply.vi`);

  const snapshot = runtime.snapshot();
  assert.equal(snapshot.state, 'ready_to_inspect');
  assert.deepEqual(snapshot.inputs, []);
  assert.deepEqual(snapshot.outputs, []);
  assert.equal(snapshot.runResult, null);
  assert.equal(snapshot.registration, null);
  assert.equal(snapshot.controls.run.enabled, false);
  assert.equal(snapshot.controls.run.reason, '请先查询参数');
  assert.equal(snapshot.controls.register.enabled, false);
});

test('path blur normalizes quotes and supplies a default name without starting an action', () => {
  const runtime = createWorkbenchRuntime();
  runtime.inputPath('  "C:\\VI\\Measure.vi"  ');

  const normalized = runtime.blurPath();

  assert.equal(normalizeFsPath('  "C:\\VI\\Measure.vi"  '), String.raw`C:\VI\Measure.vi`);
  assert.deepEqual(normalized, {
    path: String.raw`C:\VI\Measure.vi`,
    name: 'Measure',
  });
  assert.equal(runtime.snapshot().state, 'ready_to_inspect');
  assert.equal(runtime.snapshot().pendingAction, null);
});

test('inspection unlocks run and name changes only recalculate registration', () => {
  const runtime = createWorkbenchRuntime();
  runtime.inputPath(String.raw`C:\VI\Measure.vi`);
  assert.equal(runtime.beginInspect(), true);
  assert.equal(runtime.snapshot().state, 'inspecting');
  assert.equal(runtime.snapshot().controls.pathDisabled, true);
  assert.equal(runtime.snapshot().controls.advancedDisabled, true);

  runtime.inspectSucceeded({
    inputs: [{ name: 'voltage' }],
    outputs: [{ name: 'reading' }, { name: 'valid' }],
  });
  let snapshot = runtime.snapshot();
  assert.equal(snapshot.state, 'ready_to_run');
  assert.equal(snapshot.controls.inspect.enabled, true);
  assert.equal(snapshot.controls.run.enabled, true);
  assert.equal(snapshot.controls.register.enabled, false);
  assert.equal(snapshot.controls.register.reason, '请输入名称');

  runtime.inputName('Voltage check');
  snapshot = runtime.snapshot();
  assert.equal(snapshot.state, 'ready_to_run');
  assert.equal(snapshot.inputs.length, 1);
  assert.equal(snapshot.outputs.length, 2);
  assert.equal(snapshot.controls.register.enabled, true);
});

test('naming stage advances from current to complete without a new business state', () => {
  const runtime = createWorkbenchRuntime();
  runtime.loadTemplate({
    vi_path: String.raw`C:\VI\Measure.vi`,
    name: '',
    inputs: [],
    outputs: [],
  });

  let snapshot = runtime.snapshot();
  assert.equal(snapshot.state, 'ready_to_run');
  assert.deepEqual(snapshot.stages, [
    { key: 'path', status: 'complete' },
    { key: 'inspect', status: 'complete' },
    { key: 'run', status: 'complete' },
    { key: 'naming', status: 'current' },
    { key: 'register', status: 'waiting' },
  ]);

  runtime.inputName('Measure');
  snapshot = runtime.snapshot();
  assert.equal(snapshot.state, 'ready_to_run');
  assert.deepEqual(snapshot.stages.slice(3), [
    { key: 'naming', status: 'complete' },
    { key: 'register', status: 'current' },
  ]);

  runtime.beginRun();
  runtime.runSucceeded({ status: 'ok' });
  assert.equal(runtime.snapshot().state, 'ready_to_register');
  assert.deepEqual(runtime.snapshot().stages.slice(3), [
    { key: 'naming', status: 'complete' },
    { key: 'register', status: 'current' },
  ]);

  runtime.beginRegister();
  runtime.registerSucceeded({ id: 'vi-1' });
  assert.ok(runtime.snapshot().stages.every((stage) => stage.status === 'complete'));
});

test('successful run and registration follow the staged workflow', () => {
  const runtime = createWorkbenchRuntime();
  runtime.loadTemplate({
    vi_path: String.raw`C:\VI\Measure.vi`,
    name: 'Voltage check',
    inputs: [],
    outputs: [{ name: 'reading' }],
  });

  assert.equal(runtime.snapshot().state, 'ready_to_run');
  assert.equal(runtime.beginRun(), true);
  assert.equal(runtime.snapshot().state, 'running');
  assert.equal(runtime.snapshot().controls.inputsDisabled, true);
  assert.equal(runtime.snapshot().controls.nameDisabled, false);
  runtime.runSucceeded({ status: 'ok', outputs: { reading: 1.2 } });
  assert.equal(runtime.snapshot().state, 'ready_to_register');

  assert.equal(runtime.beginRegister(), true);
  assert.equal(runtime.snapshot().state, 'registering');
  assert.equal(runtime.snapshot().controls.nameDisabled, true);
  runtime.registerSucceeded({ id: 'vi-42', name: 'Voltage check' });
  assert.equal(runtime.snapshot().state, 'registered');
  assert.equal(runtime.snapshot().controls.inspect.enabled, true);
  assert.equal(runtime.snapshot().controls.run.enabled, true);
  assert.equal(runtime.snapshot().controls.register.enabled, true);

  runtime.continueEditingCopy();
  const snapshot = runtime.snapshot();
  assert.equal(snapshot.state, 'ready_to_register');
  assert.equal(snapshot.registration, null);
  assert.deepEqual(snapshot.runResult, { status: 'ok', outputs: { reading: 1.2 } });
});

test('successful run without a valid name returns to ready to run', () => {
  const runtime = createWorkbenchRuntime();
  runtime.loadTemplate({
    vi_path: String.raw`C:\VI\Measure.vi`,
    name: '',
    inputs: [],
    outputs: [],
  });

  assert.equal(runtime.beginRun(), true);
  runtime.runSucceeded({ status: 'ok' });

  const snapshot = runtime.snapshot();
  assert.equal(snapshot.state, 'ready_to_run');
  assert.equal(snapshot.controls.register.enabled, false);
  assert.equal(snapshot.controls.register.reason, '请输入名称');
});

test('in-flight actions reject duplicate submissions and recover after failure', () => {
  const runtime = createWorkbenchRuntime();
  runtime.inputPath(String.raw`C:\VI\Measure.vi`);

  assert.equal(runtime.beginInspect(), true);
  assert.equal(runtime.beginInspect(), false);
  assert.equal(runtime.beginRun(), false);
  runtime.actionFailed('inspect');
  assert.equal(runtime.snapshot().state, 'ready_to_inspect');

  runtime.inputName('Voltage check');
  assert.equal(runtime.beginInspect(), true);
  runtime.inspectSucceeded({ inputs: [], outputs: [] });
  assert.equal(runtime.beginRun(), true);
  assert.equal(runtime.beginRun(), false);
  assert.equal(runtime.beginRegister(), false);
  runtime.actionFailed('run');
  assert.equal(runtime.snapshot().state, 'ready_to_run');

  assert.equal(runtime.beginRegister(), true);
  assert.equal(runtime.beginRegister(), false);
  runtime.actionFailed('register');
  assert.equal(runtime.snapshot().state, 'ready_to_run');
});

test('editing a path whose normalized value matches the inspected path keeps results valid', () => {
  const runtime = createWorkbenchRuntime();
  runtime.loadTemplate({
    vi_path: String.raw`C:\VI\Measure.vi`,
    name: 'Voltage check',
    inputs: [{ name: 'channel' }],
    outputs: [{ name: 'reading' }],
  });
  runtime.beginRun();
  runtime.runSucceeded({ outputs: { reading: 2.4 } });

  runtime.inputPath('  "C:\\VI\\Measure.vi" ');

  const snapshot = runtime.snapshot();
  assert.equal(snapshot.state, 'ready_to_register');
  assert.equal(snapshot.inputs.length, 1);
  assert.deepEqual(snapshot.runResult, { outputs: { reading: 2.4 } });
});

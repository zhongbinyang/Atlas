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

function functionSource(name) {
  const marker = 'function ' + name + '(';
  const start = APP_SOURCE.indexOf(marker);
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

test('rendered scalar and structured parameters have standard names', () => {
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
  assert.match(tbody.children[1].innerHTML, /<textarea[^>]+data-name="config"/);
  assert.match(tbody.children[1].innerHTML, /<textarea[^>]+\sname="config"/);
});

const POLL_MS = 2000;

async function fetchStatus() {
  const resp = await fetch('/api/status');
  if (!resp.ok) return;
  const data = await resp.json();
  document.getElementById('hostname').textContent = data.hostname;
  document.getElementById('ip').textContent = data.ip;
  document.getElementById('metric-cpu').textContent = data.cpu_percent.toFixed(1) + '%';
  document.getElementById('metric-memory').textContent = data.memory_percent.toFixed(1) + '%';
  const busyEl = document.getElementById('metric-busy');
  busyEl.textContent = data.busy ? '● 执行中' : '● 空闲';
  busyEl.className = data.busy ? 'is-busy' : 'is-idle';
  document.getElementById('uptime').textContent = formatUptime(data.uptime_secs);
}

function formatUptime(secs) {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0) return h + '时' + m + '分' + s + '秒';
  if (m > 0) return m + '分' + s + '秒';
  return s + '秒';
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const INPUTS_SUMMARY_MAX = 48;
let inputsPopoverEl = null;
let inputsPopoverHideTimer = null;

function formatInputsSummary(inputs) {
  let raw;
  try {
    raw = JSON.stringify(inputs == null ? [] : inputs);
  } catch (e) {
    raw = String(inputs);
  }
  if (raw.length <= INPUTS_SUMMARY_MAX) return raw;
  return raw.slice(0, INPUTS_SUMMARY_MAX) + '…';
}

function formatInputsPretty(inputs) {
  try {
    return JSON.stringify(inputs == null ? [] : inputs, null, 2);
  } catch (e) {
    return String(inputs);
  }
}

function ensureInputsPopover() {
  if (!inputsPopoverEl) {
    inputsPopoverEl = document.createElement('pre');
    inputsPopoverEl.className = 'inputs-popover mono';
    inputsPopoverEl.hidden = true;
    document.body.appendChild(inputsPopoverEl);
    inputsPopoverEl.addEventListener('mouseenter', () => {
      if (inputsPopoverHideTimer) {
        clearTimeout(inputsPopoverHideTimer);
        inputsPopoverHideTimer = null;
      }
    });
    inputsPopoverEl.addEventListener('mouseleave', scheduleHideInputsPopover);
  }
  return inputsPopoverEl;
}

function scheduleHideInputsPopover() {
  if (inputsPopoverHideTimer) clearTimeout(inputsPopoverHideTimer);
  inputsPopoverHideTimer = setTimeout(() => {
    if (inputsPopoverEl) inputsPopoverEl.hidden = true;
  }, 150);
}

function attachInputsHover(cell, inputs) {
  cell.classList.add('inputs-cell');
  const summary = document.createElement('span');
  summary.className = 'inputs-summary mono';
  summary.textContent = formatInputsSummary(inputs);
  cell.appendChild(summary);
  cell.addEventListener('mouseenter', () => {
    if (inputsPopoverHideTimer) {
      clearTimeout(inputsPopoverHideTimer);
      inputsPopoverHideTimer = null;
    }
    const pop = ensureInputsPopover();
    pop.textContent = formatInputsPretty(inputs);
    const rect = summary.getBoundingClientRect();
    pop.hidden = false;
    const top = Math.min(rect.bottom + 6, window.innerHeight - 80);
    const left = Math.min(Math.max(8, rect.left), window.innerWidth - 340);
    pop.style.top = top + 'px';
    pop.style.left = left + 'px';
  });
  cell.addEventListener('mouseleave', scheduleHideInputsPopover);
}

/** Strip spaces and a matching pair of surrounding quotes from pasted paths. */
function normalizeFsPath(raw) {
  let s = String(raw == null ? '' : raw).trim();
  if (s.length >= 2) {
    const a = s[0];
    const b = s[s.length - 1];
    if ((a === '"' && b === '"') || (a === "'" && b === "'")) {
      s = s.slice(1, -1).trim();
    }
  }
  return s;
}

function viStemFromPath(viPath) {
  return String(viPath || '').replace(/^.*[\\/]/, '').replace(/\.vi$/i, '');
}

function defaultLvNameFromPath() {
  const pathEl = document.getElementById('lv-vi-path');
  const nameEl = document.getElementById('lv-name');
  if (!pathEl || !nameEl) return;
  if (nameEl.value.trim() !== '') return;
  const stem = viStemFromPath(normalizeFsPath(pathEl.value));
  if (stem) nameEl.value = stem;
}

async function registerNow() {
  const msg = document.getElementById('register-msg');
  msg.hidden = false;
  msg.textContent = '注册中…';
  msg.className = 'msg status-rail-msg';
  try {
    const resp = await fetch('/api/register-now', { method: 'POST' });
    const data = await resp.json();
    if (resp.ok) {
      msg.textContent = '注册成功';
      msg.className = 'msg status-rail-msg ok';
    } else {
      msg.textContent = '注册失败: ' + (data.error || resp.status);
      msg.className = 'msg status-rail-msg err';
    }
  } catch (e) {
    msg.textContent = '注册失败: ' + e.message;
    msg.className = 'msg status-rail-msg err';
  }
}

document.getElementById('register-btn').addEventListener('click', registerNow);

async function loadLabviewConfig() {
  const resp = await fetch('/api/labview/config');
  if (!resp.ok) return;
  const data = await resp.json();
  document.getElementById('lv-cli').textContent = data.cli_path;
  document.getElementById('lv-getinfo').textContent = data.getinfo_path;
}

function showLvMsg(text, ok) {
  const msg = document.getElementById('lv-msg');
  msg.hidden = false;
  msg.textContent = text;
  msg.className = ok ? 'msg ok' : 'msg err';
}

/** Last inspected / loaded LabVIEW outputs schema (registered with template). */
let lvOutputs = [];

function isJsonScalar(value) {
  return value !== null && typeof value === 'object';
}

function renderInputsTable(inputs) {
  const tbody = document.getElementById('lv-inputs-body');
  tbody.innerHTML = '';
  if (!inputs || inputs.length === 0) {
    tbody.innerHTML = '<tr><td colspan="3" class="empty">无输入参数</td></tr>';
    return;
  }
  for (const inp of inputs) {
    const row = document.createElement('tr');
    const name = escapeHtml(inp.name || '');
    const className = escapeHtml(inp.className || '');
    const val = inp.value;
    let valueCell;
    if (isJsonScalar(val)) {
      valueCell =
        '<textarea class="lv-value lv-value-json mono" data-name="' +
        escapeHtml(inp.name) +
        '" data-class="' +
        className +
        '" rows="2">' +
        escapeHtml(JSON.stringify(val)) +
        '</textarea>';
    } else {
      valueCell =
        '<input class="lv-value mono" data-name="' +
        escapeHtml(inp.name) +
        '" data-class="' +
        className +
        '" type="text" value="' +
        escapeHtml(val == null ? '' : String(val)) +
        '">';
    }
    row.innerHTML =
      '<td>' + name + '</td>' +
      '<td class="mono">' + className + '</td>' +
      '<td>' + valueCell + '</td>';
    tbody.appendChild(row);
  }
}

function collectInputsFromTable() {
  const inputs = [];
  document.querySelectorAll('#lv-inputs-body .lv-value').forEach(function (el) {
    const name = el.getAttribute('data-name');
    const className = el.getAttribute('data-class') || '';
    let value;
    if (el.tagName === 'TEXTAREA') {
      try {
        value = JSON.parse(el.value);
      } catch (e) {
        throw new Error('参数 ' + name + ' JSON 无效: ' + e.message);
      }
    } else if (el.value.trim() === '') {
      value = null;
    } else if (/^-?\d+(\.\d+)?$/.test(el.value.trim())) {
      value = Number(el.value);
    } else if (el.value.trim() === 'true' || el.value.trim() === 'false') {
      value = el.value.trim() === 'true';
    } else {
      value = el.value;
    }
    inputs.push({ name: name, className: className, value: value });
  });
  return inputs;
}

function readRunOptions() {
  const showFp = document.getElementById('lv-show-fp').checked;
  const timeoutRaw = document.getElementById('lv-timeout').value.trim();
  const opts = { show_front_panel: showFp };
  if (timeoutRaw !== '') {
    const n = parseInt(timeoutRaw, 10);
    if (!Number.isFinite(n) || n <= 0) {
      throw new Error('超时必须是正整数');
    }
    opts.timeout_secs = n;
  }
  return opts;
}

async function inspectVi() {
  const pathEl = document.getElementById('lv-vi-path');
  const viPath = normalizeFsPath(pathEl.value);
  pathEl.value = viPath;
  if (!viPath) {
    showLvMsg('请输入 VI 路径', false);
    return;
  }
  defaultLvNameFromPath();
  showLvMsg('查询中…', true);
  document.getElementById('lv-run-out').hidden = true;
  try {
    const resp = await fetch('/api/labview/inspect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vi_path: viPath }),
    });
    const data = await resp.json();
    document.getElementById('lv-json-raw').textContent = JSON.stringify(data, null, 2);
    if (!resp.ok) {
      const err = data.error && (data.error.message || data.error) || resp.status;
      showLvMsg('查询失败: ' + err, false);
      return;
    }
    renderInputsTable(data.inputs || []);
    lvOutputs = Array.isArray(data.outputs) ? data.outputs : [];
    showLvMsg('参数已加载（入参 ' + (data.inputs || []).length + ' / 出参 ' + lvOutputs.length + '）', true);
  } catch (e) {
    showLvMsg('查询失败: ' + e.message, false);
  }
}

async function runVi() {
  const pathEl = document.getElementById('lv-vi-path');
  const viPath = normalizeFsPath(pathEl.value);
  pathEl.value = viPath;
  if (!viPath) {
    showLvMsg('请输入 VI 路径', false);
    return;
  }
  let inputs;
  try {
    inputs = collectInputsFromTable();
  } catch (e) {
    showLvMsg(e.message, false);
    return;
  }
  let opts;
  try {
    opts = readRunOptions();
  } catch (e) {
    showLvMsg(e.message, false);
    return;
  }
  showLvMsg('试跑中…', true);
  const outEl = document.getElementById('lv-run-out');
  outEl.hidden = false;
  outEl.textContent = '…';
  try {
    const resp = await fetch('/api/labview/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ vi_path: viPath, inputs: inputs }, opts)),
    });
    const data = await resp.json();
    outEl.textContent = JSON.stringify(data, null, 2);
    if (!resp.ok) {
      const err = data.error && (data.error.message || data.error) || resp.status;
      showLvMsg('试跑失败: ' + err, false);
      return;
    }
    showLvMsg('试跑完成', true);
  } catch (e) {
    outEl.textContent = e.message;
    showLvMsg('试跑失败: ' + e.message, false);
  }
}

async function registerViTemplate() {
  const pathEl = document.getElementById('lv-vi-path');
  const viPath = normalizeFsPath(pathEl.value);
  pathEl.value = viPath;
  if (!viPath) {
    showLvMsg('请输入 VI 路径', false);
    return;
  }
  defaultLvNameFromPath();
  const name = document.getElementById('lv-name').value.trim();
  if (!name) {
    showLvMsg('请输入名称', false);
    return;
  }
  let inputs;
  try {
    inputs = collectInputsFromTable();
  } catch (e) {
    showLvMsg(e.message, false);
    return;
  }
  let opts;
  try {
    opts = readRunOptions();
  } catch (e) {
    showLvMsg(e.message, false);
    return;
  }
  showLvMsg('注册中…', true);
  try {
    const resp = await fetch('/api/labview/register-template', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({
        vi_path: viPath,
        inputs: inputs,
        outputs: lvOutputs,
        name: name,
      }, opts)),
    });
    const data = await resp.json();
    if (!resp.ok) {
      const err = data.error && (data.error.message || data.error) || resp.status;
      showLvMsg('注册失败: ' + err, false);
      return;
    }
    showLvMsg('已注册: ' + (data.name || data.id), true);
    await loadSeqRegistered();
  } catch (e) {
    showLvMsg('注册失败: ' + e.message, false);
  }
}

function loadTemplateToEditor(t) {
  document.getElementById('lv-vi-path').value = t.vi_path || '';
  document.getElementById('lv-name').value = t.name || '';
  renderInputsTable(t.inputs || []);
  lvOutputs = Array.isArray(t.outputs) ? t.outputs : [];
  document.getElementById('lv-show-fp').checked = !!t.show_front_panel;
  const timeoutEl = document.getElementById('lv-timeout');
  if (t.timeout_secs != null && t.timeout_secs > 0) {
    timeoutEl.value = String(t.timeout_secs);
  } else {
    timeoutEl.value = '';
  }
  document.getElementById('lv-json-raw').textContent = JSON.stringify(t, null, 2);
  document.getElementById('lv-run-out').hidden = true;
  showLvMsg('已加载到编辑区: ' + (t.name || t.id), true);
}

function delayMsFromInputs(inputs) {
  if (!Array.isArray(inputs)) return null;
  for (let i = 0; i < inputs.length; i++) {
    if (inputs[i] && inputs[i].name === 'delay_ms' && inputs[i].value != null) {
      const n = Number(inputs[i].value);
      if (Number.isFinite(n) && n >= 0) return Math.round(n);
    }
  }
  return null;
}

async function refreshTemplateLists() {
  await loadSeqRegistered();
}

document.getElementById('lv-inspect-btn').addEventListener('click', inspectVi);
document.getElementById('lv-run-btn').addEventListener('click', runVi);
document.getElementById('lv-register-btn').addEventListener('click', registerViTemplate);
document.getElementById('lv-vi-path').addEventListener('blur', defaultLvNameFromPath);

// --- Sequence page ---

let seqRegistered = [];
let seqSelected = [];
let seqRunning = false;
let seqPaused = false;
let seqStepResults = {};
let seqDragIndex = null;

function showPage(page) {
  const workbench = document.getElementById('page-workbench');
  const general = document.getElementById('page-general');
  const sequence = document.getElementById('page-sequence');
  workbench.hidden = page !== 'workbench';
  if (general) general.hidden = page !== 'general';
  sequence.hidden = page !== 'sequence';
  document.querySelectorAll('.page-tabs .tab').forEach(function (btn) {
    btn.classList.toggle('active', btn.getAttribute('data-page') === page);
  });
  if (page === 'sequence') {
    loadSequencePage();
  } else if (page === 'general') {
    fetchGeneralDelayTemplates();
  }
}

document.querySelectorAll('.page-tabs .tab').forEach(function (btn) {
  btn.addEventListener('click', function () {
    showPage(btn.getAttribute('data-page'));
  });
});

function showSeqMsg(text, ok) {
  const msg = document.getElementById('seq-msg');
  msg.hidden = false;
  msg.textContent = text;
  msg.className = ok ? 'msg ok' : 'msg err';
}

function setSeqControlsDisabled(disabled) {
  seqRunning = disabled && !seqPaused;
  const runBtn = document.getElementById('seq-run-btn');
  const contBtn = document.getElementById('seq-continue-btn');
  const abortBtn = document.getElementById('seq-abort-btn');
  const snEl = document.getElementById('seq-sn');
  const woEl = document.getElementById('seq-work-order');
  if (runBtn) runBtn.disabled = disabled || seqPaused || !seqSelected.length;
  if (contBtn) contBtn.disabled = !seqPaused;
  if (abortBtn) abortBtn.disabled = !seqPaused;
  if (snEl) snEl.disabled = disabled || seqPaused;
  if (woEl) woEl.disabled = disabled || seqPaused;
  document.querySelectorAll('#seq-registered-body button, #seq-selected-body button').forEach(function (btn) {
    if (btn.classList.contains('seq-spec-btn')) return;
    btn.disabled = disabled || seqPaused;
  });
  document.querySelectorAll('#seq-selected-body input[type="checkbox"], #seq-selected-body select').forEach(function (el) {
    el.disabled = disabled || seqPaused;
  });
  document.querySelectorAll('#seq-selected-body tr[data-index]').forEach(function (row) {
    row.draggable = !disabled && !seqPaused;
  });
}

function formatSpecSummary(limits) {
  if (!Array.isArray(limits) || limits.length === 0) return '未设置';
  if (limits.length === 1 && limits[0] && limits[0].output) {
    return '1 项 · ' + limits[0].output;
  }
  return limits.length + ' 项';
}

function formatStepStatus(status) {
  const map = { pass: '通过', fail: '失败', ok: 'OK', error: '错误', skipped: '跳过' };
  return map[status] || status || '—';
}

function formatMeasuredSummary(measured) {
  if (measured == null) return '—';
  try {
    const raw = JSON.stringify(measured);
    return raw.length <= 32 ? raw : raw.slice(0, 32) + '…';
  } catch (e) {
    return String(measured);
  }
}

function updateSeqOverall(data) {
  const el = document.getElementById('seq-overall');
  if (!el) return;
  const parts = [];
  if (data && data.overall) parts.push('总体: ' + data.overall);
  if (data && data.sn) parts.push('SN: ' + data.sn);
  el.textContent = parts.join(' · ');
}

function applyStepResults(steps) {
  seqStepResults = {};
  if (!Array.isArray(steps)) return;
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const pos = step.position != null ? step.position : i;
    seqStepResults[pos] = step;
  }
}

let specEditIndex = null;

function outputNamesFromSchema(outputs) {
  if (!Array.isArray(outputs)) return [];
  const names = [];
  for (let i = 0; i < outputs.length; i++) {
    const o = outputs[i];
    if (!o) continue;
    if (typeof o === 'string' && o.trim()) names.push(o.trim());
    else if (o.name && String(o.name).trim()) names.push(String(o.name).trim());
  }
  return names;
}

function resolveStepOutputNames(item) {
  let names = outputNamesFromSchema(item && item.outputs);
  if (names.length) return names;
  const tid = item && item.vi_template_id;
  if (tid == null) return [];
  for (let i = 0; i < seqRegistered.length; i++) {
    if (String(seqRegistered[i].id) === String(tid)) {
      return outputNamesFromSchema(seqRegistered[i].outputs);
    }
  }
  return [];
}

function renderSpecModalRows(limits, outputNames) {
  const tbody = document.getElementById('spec-modal-body');
  tbody.innerHTML = '';
  const rows = Array.isArray(limits) && limits.length ? limits : [{ output: '', min: null, max: null, unit: '' }];
  for (let i = 0; i < rows.length; i++) {
    const lim = rows[i] || {};
    const tr = document.createElement('tr');
    const select = document.createElement('select');
    select.className = 'spec-output-select';
    const blank = document.createElement('option');
    blank.value = '';
    blank.textContent = outputNames.length ? '选择输出…' : '手动输入';
    select.appendChild(blank);
    for (let j = 0; j < outputNames.length; j++) {
      const opt = document.createElement('option');
      opt.value = outputNames[j];
      opt.textContent = outputNames[j];
      if (lim.output === outputNames[j]) opt.selected = true;
      select.appendChild(opt);
    }
    const custom = document.createElement('option');
    custom.value = '__custom__';
    custom.textContent = '自定义…';
    select.appendChild(custom);
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'spec-output-custom mono';
    nameInput.placeholder = '输出名';
    nameInput.value = lim.output || '';
    nameInput.hidden = outputNames.indexOf(lim.output) >= 0 || !lim.output;
    if (lim.output && outputNames.indexOf(lim.output) < 0) {
      select.value = '__custom__';
      nameInput.hidden = false;
    }
    select.addEventListener('change', function () {
      if (select.value === '__custom__') {
        nameInput.hidden = false;
        nameInput.focus();
      } else {
        nameInput.hidden = true;
        nameInput.value = select.value;
      }
    });
    const outCell = document.createElement('td');
    outCell.appendChild(select);
    outCell.appendChild(nameInput);
    const minInput = document.createElement('input');
    minInput.type = 'number';
    minInput.step = 'any';
    minInput.className = 'spec-min mono';
    minInput.value = lim.min == null ? '' : String(lim.min);
    const maxInput = document.createElement('input');
    maxInput.type = 'number';
    maxInput.step = 'any';
    maxInput.className = 'spec-max mono';
    maxInput.value = lim.max == null ? '' : String(lim.max);
    const unitInput = document.createElement('input');
    unitInput.type = 'text';
    unitInput.className = 'spec-unit mono';
    unitInput.value = lim.unit || '';
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.textContent = '删';
    rm.addEventListener('click', function () {
      tr.remove();
      if (!tbody.children.length) renderSpecModalRows([], outputNames);
    });
    tr.appendChild(outCell);
    const tdMin = document.createElement('td'); tdMin.appendChild(minInput); tr.appendChild(tdMin);
    const tdMax = document.createElement('td'); tdMax.appendChild(maxInput); tr.appendChild(tdMax);
    const tdUnit = document.createElement('td'); tdUnit.appendChild(unitInput); tr.appendChild(tdUnit);
    const tdRm = document.createElement('td'); tdRm.appendChild(rm); tr.appendChild(tdRm);
    tbody.appendChild(tr);
  }
}

function collectSpecModalLimits() {
  const rows = document.querySelectorAll('#spec-modal-body tr');
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const tr = rows[i];
    const select = tr.querySelector('.spec-output-select');
    const custom = tr.querySelector('.spec-output-custom');
    let name = '';
    if (select && select.value && select.value !== '__custom__') name = select.value;
    else if (custom) name = custom.value.trim();
    if (!name) continue;
    const minRaw = tr.querySelector('.spec-min').value.trim();
    const maxRaw = tr.querySelector('.spec-max').value.trim();
    const unit = tr.querySelector('.spec-unit').value.trim();
    const lim = { output: name, min: null, max: null };
    if (minRaw !== '') lim.min = Number(minRaw);
    if (maxRaw !== '') lim.max = Number(maxRaw);
    if (unit) lim.unit = unit;
    out.push(lim);
  }
  return out;
}

function openSpecEditor(index) {
  const item = seqSelected[index];
  if (!item) return;
  specEditIndex = index;
  const names = resolveStepOutputNames(item);
  const hint = document.getElementById('spec-modal-hint');
  hint.textContent = names.length
    ? ('可选输出: ' + names.join(', '))
    : '该步骤尚未注册输出参数；可手动填写输出名，或重新注册模板后再设置 Spec。';
  renderSpecModalRows(item.limits || [], names);
  document.getElementById('spec-modal').hidden = false;
}

function closeSpecModal() {
  document.getElementById('spec-modal').hidden = true;
  specEditIndex = null;
}

async function editLimitsAt(index) {
  if (seqRunning || seqPaused) return;
  openSpecEditor(index);
}

document.getElementById('spec-add-row-btn').addEventListener('click', function () {
  if (specEditIndex == null) return;
  const item = seqSelected[specEditIndex];
  const names = resolveStepOutputNames(item);
  const current = collectSpecModalLimits();
  current.push({ output: '', min: null, max: null, unit: '' });
  renderSpecModalRows(current, names);
});

document.getElementById('spec-cancel-btn').addEventListener('click', closeSpecModal);

document.getElementById('spec-save-btn').addEventListener('click', async function () {
  if (specEditIndex == null) return;
  const item = seqSelected[specEditIndex];
  if (!item) { closeSpecModal(); return; }
  item.limits = collectSpecModalLimits();
  closeSpecModal();
  renderSeqSelected();
  await saveQueue();
});

async function loadSequencePage() {
  await Promise.all([loadSeqRegistered(), loadQueue()]);
}

async function loadSeqRegistered() {
  const tbody = document.getElementById('seq-registered-body');
  try {
    const resp = await fetch('/api/labview/all-templates');
    const data = await resp.json();
    if (!resp.ok) {
      const err = data.error && (data.error.message || data.error) || resp.status;
      tbody.innerHTML =
        '<tr><td colspan="6" class="empty">加载失败: ' + escapeHtml(String(err)) + '</td></tr>';
      return;
    }
    seqRegistered = Array.isArray(data) ? data : [];
    renderSeqRegistered();
  } catch (e) {
    tbody.innerHTML =
      '<tr><td colspan="6" class="empty">加载失败: ' + escapeHtml(e.message) + '</td></tr>';
  }
}

function renderSeqRegistered() {
  const tbody = document.getElementById('seq-registered-body');
  tbody.innerHTML = '';
  if (!seqRegistered.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty">暂无中心已注册功能</td></tr>';
    return;
  }
  for (let i = 0; i < seqRegistered.length; i++) {
    const t = seqRegistered[i];
    const row = document.createElement('tr');
    const name = escapeHtml(t.name || t.id || '—');
    const origin = escapeHtml(t.origin_agent_name || '—');
    const viPath = escapeHtml(t.vi_path || '—');
    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.textContent = '添加';
    addBtn.disabled = seqRunning || seqPaused;
    addBtn.addEventListener('click', function () {
      addToQueue(t);
    });
    const actions = document.createElement('td');
    actions.appendChild(addBtn);
    row.innerHTML =
      '<td class="mono">' + escapeHtml(String(t.id ?? '—')) + '</td>' +
      '<td>' + name + '</td>' +
      '<td>' + origin + '</td>' +
      '<td class="mono">' + viPath + '</td>' +
      '<td class="inputs-cell-host"></td>';
    attachInputsHover(row.querySelector('.inputs-cell-host'), t.inputs);
    row.appendChild(actions);
    tbody.appendChild(row);
  }
}

async function loadQueue() {
  try {
    const resp = await fetch('/api/labview/run-queue');
    const data = await resp.json();
    if (!resp.ok) {
      const err = data.error && (data.error.message || data.error) || resp.status;
      showSeqMsg('加载队列失败: ' + err, false);
      seqSelected = [];
    } else {
      seqSelected = Array.isArray(data.items) ? data.items : [];
    }
    renderSeqSelected();
  } catch (e) {
    showSeqMsg('加载队列失败: ' + e.message, false);
    seqSelected = [];
    renderSeqSelected();
  }
}

function renderSeqSelected() {
  const tbody = document.getElementById('seq-selected-body');
  tbody.innerHTML = '';
  if (!seqSelected.length) {
    tbody.innerHTML = '<tr><td colspan="12" class="empty">队列为空，从左侧添加</td></tr>';
    setSeqControlsDisabled(false);
    return;
  }
  for (let i = 0; i < seqSelected.length; i++) {
    const item = seqSelected[i];
    const row = document.createElement('tr');
    row.setAttribute('data-index', String(i));
    row.draggable = !seqRunning && !seqPaused;
    row.className = 'seq-row';
    const pos = item.position != null ? item.position : i;
    const stepResult = seqStepResults[pos];
    const name = escapeHtml(item.name || item.vi_template_id || '—');
    const idCol = escapeHtml(String(item.vi_template_id ?? '—'));
    const kind = escapeHtml(item.kind || 'labview');
    const enabled = item.enabled !== false;
    const breakpoint = !!item.breakpoint;
    const failPolicy = item.fail_policy === 'continue' ? 'continue' : 'stop';
    const limits = Array.isArray(item.limits) ? item.limits : [];

    row.innerHTML =
      '<td class="mono">' + (i + 1) + '</td>' +
      '<td class="seq-check-cell"></td>' +
      '<td class="seq-check-cell"></td>' +
      '<td class="mono">' + idCol + '</td>' +
      '<td>' + name + '</td>' +
      '<td class="mono">' + kind + '</td>' +
      '<td class="inputs-cell-host"></td>' +
      '<td class="seq-spec-cell"></td>' +
      '<td class="seq-fail-cell"></td>' +
      '<td class="seq-result-cell mono">' + escapeHtml(stepResult ? formatStepStatus(stepResult.status) : '—') + '</td>' +
      '<td class="seq-measured-cell mono">' + escapeHtml(stepResult ? formatMeasuredSummary(stepResult.measured) : '—') + '</td>';

    attachInputsHover(row.querySelector('.inputs-cell-host'), item.inputs);

    const enabledCb = document.createElement('input');
    enabledCb.type = 'checkbox';
    enabledCb.checked = enabled;
    enabledCb.title = '启用';
    enabledCb.disabled = seqRunning || seqPaused;
    enabledCb.addEventListener('change', async function () {
      item.enabled = enabledCb.checked;
      await saveQueue();
    });
    row.querySelector('.seq-check-cell').appendChild(enabledCb);

    const bpCb = document.createElement('input');
    bpCb.type = 'checkbox';
    bpCb.checked = breakpoint;
    bpCb.title = '断点';
    bpCb.disabled = seqRunning || seqPaused;
    bpCb.addEventListener('change', async function () {
      item.breakpoint = bpCb.checked;
      await saveQueue();
    });
    row.querySelectorAll('.seq-check-cell')[1].appendChild(bpCb);

    const specBtn = document.createElement('button');
    specBtn.type = 'button';
    specBtn.className = 'seq-spec-btn';
    specBtn.textContent = formatSpecSummary(limits);
    specBtn.title = '点击编辑 Spec';
    specBtn.disabled = seqRunning || seqPaused;
    specBtn.addEventListener('click', function () { editLimitsAt(i); });
    row.querySelector('.seq-spec-cell').appendChild(specBtn);

    const failSel = document.createElement('select');
    failSel.innerHTML = '<option value="stop">停止</option><option value="continue">继续</option>';
    failSel.value = failPolicy;
    failSel.disabled = seqRunning || seqPaused;
    failSel.addEventListener('change', async function () {
      item.fail_policy = failSel.value === 'continue' ? 'continue' : 'stop';
      await saveQueue();
    });
    row.querySelector('.seq-fail-cell').appendChild(failSel);

    const actions = document.createElement('td');
    actions.className = 'seq-row-actions';
    const upBtn = document.createElement('button');
    upBtn.type = 'button';
    upBtn.textContent = '↑';
    upBtn.title = '上移';
    upBtn.disabled = seqRunning || seqPaused || i === 0;
    upBtn.addEventListener('click', function () { moveQueueItem(i, -1); });
    const downBtn = document.createElement('button');
    downBtn.type = 'button';
    downBtn.textContent = '↓';
    downBtn.title = '下移';
    downBtn.disabled = seqRunning || seqPaused || i === seqSelected.length - 1;
    downBtn.addEventListener('click', function () { moveQueueItem(i, 1); });
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.textContent = '移除';
    removeBtn.disabled = seqRunning || seqPaused;
    removeBtn.addEventListener('click', function () { removeFromQueue(i); });
    actions.appendChild(upBtn);
    actions.appendChild(document.createTextNode(' '));
    actions.appendChild(downBtn);
    actions.appendChild(document.createTextNode(' '));
    actions.appendChild(removeBtn);
    row.appendChild(actions);
    row.addEventListener('dragstart', onSeqDragStart);
    row.addEventListener('dragover', onSeqDragOver);
    row.addEventListener('dragleave', onSeqDragLeave);
    row.addEventListener('drop', onSeqDrop);
    row.addEventListener('dragend', onSeqDragEnd);
    tbody.appendChild(row);
  }
  setSeqControlsDisabled(seqRunning);
}

async function saveQueue() {
  const body = {
    items: seqSelected.map(function (item) {
      return {
        vi_template_id: item.vi_template_id,
        enabled: item.enabled !== false,
        breakpoint: !!item.breakpoint,
        fail_policy: item.fail_policy === 'continue' ? 'continue' : 'stop',
        limits: Array.isArray(item.limits) ? item.limits : [],
        note: item.note || '',
      };
    }),
  };
  try {
    const resp = await fetch('/api/labview/run-queue', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await resp.json();
    if (!resp.ok) {
      const err = data.error && (data.error.message || data.error) || resp.status;
      showSeqMsg('保存失败: ' + err, false);
      await loadQueue();
      return false;
    }
    if (Array.isArray(data.items)) {
      seqSelected = data.items;
    }
    renderSeqSelected();
    return true;
  } catch (e) {
    showSeqMsg('保存失败: ' + e.message, false);
    await loadQueue();
    return false;
  }
}

async function addToQueue(template) {
  const templateId = template.id;
  if (!templateId) {
    showSeqMsg('模板缺少 ID', false);
    return;
  }
  seqSelected.push({
    vi_template_id: templateId,
    name: template.name || templateId,
    kind: template.kind || 'labview',
    vi_path: template.vi_path || '',
    inputs: template.inputs || [],
    enabled: true,
    breakpoint: false,
    fail_policy: 'stop',
    limits: [],
    note: '',
  });
  renderSeqSelected();
  await saveQueue();
}

async function removeFromQueue(index) {
  seqSelected.splice(index, 1);
  renderSeqSelected();
  await saveQueue();
}

async function moveQueueItem(index, delta) {
  const newIndex = index + delta;
  if (newIndex < 0 || newIndex >= seqSelected.length) return;
  const item = seqSelected.splice(index, 1)[0];
  seqSelected.splice(newIndex, 0, item);
  renderSeqSelected();
  await saveQueue();
}

function onSeqDragStart(e) {
  if (seqRunning || seqPaused) {
    e.preventDefault();
    return;
  }
  const row = e.currentTarget;
  seqDragIndex = parseInt(row.getAttribute('data-index'), 10);
  row.classList.add('seq-dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', String(seqDragIndex));
}

function onSeqDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  e.currentTarget.classList.add('seq-drag-over');
}

function onSeqDragLeave(e) {
  e.currentTarget.classList.remove('seq-drag-over');
}

async function onSeqDrop(e) {
  e.preventDefault();
  const targetRow = e.currentTarget;
  targetRow.classList.remove('seq-drag-over');
  if (seqDragIndex == null || seqRunning || seqPaused) return;
  const dropIndex = parseInt(targetRow.getAttribute('data-index'), 10);
  if (seqDragIndex === dropIndex) return;
  const item = seqSelected.splice(seqDragIndex, 1)[0];
  // After removal, indices after seqDragIndex shift down by one.
  const insertAt = seqDragIndex < dropIndex ? dropIndex - 1 : dropIndex;
  seqSelected.splice(insertAt, 0, item);
  seqDragIndex = null;
  renderSeqSelected();
  await saveQueue();
}

function onSeqDragEnd(e) {
  e.currentTarget.classList.remove('seq-dragging');
  document.querySelectorAll('.seq-drag-over').forEach(function (el) {
    el.classList.remove('seq-drag-over');
  });
  seqDragIndex = null;
}

function renderSeqResults(data) {
  const container = document.getElementById('seq-results');
  container.innerHTML = '';
  if (!data || !data.steps || !data.steps.length) return;
  const heading = document.createElement('h3');
  heading.textContent = '执行结果';
  container.appendChild(heading);
  const list = document.createElement('div');
  list.className = 'seq-results-list';
  for (let i = 0; i < data.steps.length; i++) {
    const step = data.steps[i];
    const row = document.createElement('div');
    row.className = 'seq-step ' + (step.ok ? 'seq-step-ok' : 'seq-step-fail');
    const label = document.createElement('span');
    label.className = 'seq-step-label';
    label.textContent = (step.position != null ? step.position + 1 : i + 1) + '. ' + (step.name || step.template_id || '—');
    const status = document.createElement('span');
    status.className = 'seq-step-status';
    status.textContent = step.ok ? '成功' : '失败';
    row.appendChild(label);
    row.appendChild(status);
    if (!step.ok && step.error) {
      const errEl = document.createElement('div');
      errEl.className = 'seq-step-error mono';
      errEl.textContent = step.error;
      row.appendChild(errEl);
    }
    if (step.ok && step.result != null) {
      const details = document.createElement('details');
      details.className = 'seq-step-details';
      const summary = document.createElement('summary');
      summary.textContent = '结果 JSON';
      const pre = document.createElement('pre');
      pre.className = 'mono lv-pre';
      pre.textContent = JSON.stringify(step.result, null, 2);
      details.appendChild(summary);
      details.appendChild(pre);
      row.appendChild(details);
    }
    list.appendChild(row);
  }
  container.appendChild(list);
}

function handleSequenceResponse(data) {
  applyStepResults(data.steps);
  updateSeqOverall(data);
  if (data.sn) {
    const snEl = document.getElementById('seq-sn');
    if (snEl) snEl.value = data.sn;
  }
  renderSeqResults(data);
  renderSeqSelected();
  if (data.pause) {
    seqPaused = true;
    showSeqMsg('断点暂停: ' + (data.pause.message || 'breakpoint'), true);
    setSeqControlsDisabled(false);
    return 'paused';
  }
  seqPaused = false;
  if (data.overall === 'aborted') {
    showSeqMsg('已中止', false);
    return 'aborted';
  }
  if (data.stopped) {
    showSeqMsg('执行中止于第 ' + ((data.failed_at != null ? data.failed_at : 0) + 1) + ' 步', false);
    return 'stopped';
  }
  if (data.overall === 'pass' || data.overall === 'ok') {
    showSeqMsg('全部执行成功', true);
    return 'done';
  }
  showSeqMsg('执行完成 · 总体: ' + (data.overall || '—'), data.overall === 'pass');
  return 'done';
}

async function runSequence() {
  if ((seqRunning && !seqPaused) || !seqSelected.length) return;
  seqPaused = false;
  setSeqControlsDisabled(true);
  document.getElementById('seq-results').innerHTML = '';
  showSeqMsg('执行中…', true);
  const snRaw = document.getElementById('seq-sn').value.trim();
  const woRaw = document.getElementById('seq-work-order').value.trim();
  const payload = {};
  if (snRaw) payload.sn = snRaw;
  if (woRaw) payload.work_order = woRaw;
  try {
    const resp = await fetch('/api/labview/run-sequence', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await resp.json();
    if (!resp.ok) {
      const err = data.error && (data.error.message || data.error) || resp.status;
      showSeqMsg('执行失败: ' + err, false);
      return;
    }
    handleSequenceResponse(data);
  } catch (e) {
    showSeqMsg('执行失败: ' + e.message, false);
  } finally {
    if (!seqPaused) {
      setSeqControlsDisabled(false);
    }
    renderSeqRegistered();
  }
}

async function continueSequence() {
  if (!seqPaused) return;
  const contBtn = document.getElementById('seq-continue-btn');
  const abortBtn = document.getElementById('seq-abort-btn');
  if (contBtn) contBtn.disabled = true;
  if (abortBtn) abortBtn.disabled = true;
  setSeqControlsDisabled(true);
  showSeqMsg('继续执行…', true);
  try {
    const resp = await fetch('/api/labview/run-sequence/continue', { method: 'POST' });
    const data = await resp.json();
    if (!resp.ok) {
      const err = data.error && (data.error.message || data.error) || resp.status;
      showSeqMsg('继续失败: ' + err, false);
      seqPaused = false;
      return;
    }
    handleSequenceResponse(data);
  } catch (e) {
    showSeqMsg('继续失败: ' + e.message, false);
    seqPaused = false;
  } finally {
    if (!seqPaused) {
      setSeqControlsDisabled(false);
    }
  }
}

async function abortSequence() {
  if (!seqPaused) return;
  const contBtn = document.getElementById('seq-continue-btn');
  const abortBtn = document.getElementById('seq-abort-btn');
  if (contBtn) contBtn.disabled = true;
  if (abortBtn) abortBtn.disabled = true;
  showSeqMsg('中止中…', true);
  try {
    const resp = await fetch('/api/labview/run-sequence/abort', { method: 'POST' });
    const data = await resp.json();
    if (!resp.ok) {
      const err = data.error && (data.error.message || data.error) || resp.status;
      showSeqMsg('中止失败: ' + err, false);
      return;
    }
    handleSequenceResponse(data);
    seqPaused = false;
  } catch (e) {
    showSeqMsg('中止失败: ' + e.message, false);
    seqPaused = false;
  } finally {
    setSeqControlsDisabled(false);
  }
}


function showGenDelayMsg(text, ok) {
  const msg = document.getElementById('gen-delay-msg');
  if (!msg) return;
  msg.hidden = false;
  msg.textContent = text;
  msg.className = 'msg ' + (ok ? 'ok' : 'err');
}

function showGenCenterMsg(text, ok) {
  const msg = document.getElementById('gen-center-msg');
  if (!msg) return;
  msg.hidden = false;
  msg.textContent = text;
  msg.className = 'msg ' + (ok ? 'ok' : 'err');
}

async function runGeneralDelay() {
  const ms = Number(document.getElementById('gen-delay-ms').value);
  if (!Number.isFinite(ms) || ms < 0) {
    showGenDelayMsg('请输入有效的延迟毫秒数', false);
    return;
  }
  const outEl = document.getElementById('gen-delay-out');
  outEl.hidden = false;
  outEl.textContent = '…';
  showGenDelayMsg('试跑中…', true);
  try {
    const resp = await fetch('/api/general/delay/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ delay_ms: Math.round(ms) }),
    });
    const data = await resp.json();
    outEl.textContent = JSON.stringify(data, null, 2);
    if (!resp.ok) {
      const err = data.error && (data.error.message || data.error) || resp.status;
      showGenDelayMsg('试跑失败: ' + err, false);
      return;
    }
    showGenDelayMsg('试跑完成 (' + Math.round(ms) + ' ms)', true);
  } catch (e) {
    outEl.textContent = e.message;
    showGenDelayMsg('试跑失败: ' + e.message, false);
  }
}

async function registerGeneralDelay() {
  const name = String(document.getElementById('gen-delay-name').value || '').trim();
  const ms = Number(document.getElementById('gen-delay-ms').value);
  if (!name) {
    showGenDelayMsg('名称不能为空', false);
    return;
  }
  if (!Number.isFinite(ms) || ms < 0) {
    showGenDelayMsg('请输入有效的延迟毫秒数', false);
    return;
  }
  showGenDelayMsg('注册中…', true);
  try {
    const resp = await fetch('/api/general/delay/register-template', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name, delay_ms: Math.round(ms) }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      const err = data.error && (data.error.message || data.error) || resp.status;
      showGenDelayMsg('注册失败: ' + err, false);
      return;
    }
    showGenDelayMsg('已注册: ' + (data.name || name) + ' (ID ' + data.id + ')', true);
    await fetchGeneralDelayTemplates();
  } catch (e) {
    showGenDelayMsg('注册失败: ' + e.message, false);
  }
}

function renderGeneralDelayTemplates(templates) {
  const tbody = document.getElementById('gen-center-body');
  if (!tbody) return;
  tbody.innerHTML = '';
  if (!templates || templates.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty">暂无已注册延迟功能</td></tr>';
    return;
  }
  for (let i = 0; i < templates.length; i++) {
    const t = templates[i];
    const row = document.createElement('tr');
    const ms = delayMsFromInputs(t.inputs);
    row.innerHTML =
      '<td class="mono">' + escapeHtml(String(t.id ?? '—')) + '</td>' +
      '<td>' + escapeHtml(t.name || '—') + '</td>' +
      '<td>' + escapeHtml(t.origin_agent_name || '—') + '</td>' +
      '<td class="mono">' + escapeHtml(ms != null ? String(ms) : '—') + '</td>';
    const loadBtn = document.createElement('button');
    loadBtn.type = 'button';
    loadBtn.textContent = '加载到编辑区';
    loadBtn.addEventListener('click', function () {
      document.getElementById('gen-delay-name').value = t.name || '';
      const dms = delayMsFromInputs(t.inputs);
      document.getElementById('gen-delay-ms').value = dms != null ? String(dms) : '1000';
      showGenDelayMsg('已加载到编辑区: ' + (t.name || t.id), true);
    });
    const actions = document.createElement('td');
    actions.appendChild(loadBtn);
    row.appendChild(actions);
    tbody.appendChild(row);
  }
}

async function trialGeneralDelayTemplate(t) {
  const ms = delayMsFromInputs(t.inputs);
  if (ms == null) {
    showGenCenterMsg('模板缺少 delay_ms', false);
    return;
  }
  showGenCenterMsg('试跑中: ' + (t.name || t.id) + '…', true);
  try {
    const resp = await fetch('/api/general/delay/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ delay_ms: ms }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      const err = data.error && (data.error.message || data.error) || resp.status;
      showGenCenterMsg('试跑失败: ' + err, false);
      return;
    }
    showGenCenterMsg('试跑完成: ' + (t.name || t.id) + ' (' + ms + ' ms)', true);
  } catch (e) {
    showGenCenterMsg('试跑失败: ' + e.message, false);
  }
}

async function fetchGeneralDelayTemplates() {
  const tbody = document.getElementById('gen-center-body');
  if (!tbody) return;
  try {
    const resp = await fetch('/api/general/delay/templates');
    const data = await resp.json();
    if (!resp.ok) {
      const err = data.error && (data.error.message || data.error) || resp.status;
      tbody.innerHTML = '<tr><td colspan="5" class="empty">加载失败: ' + escapeHtml(String(err)) + '</td></tr>';
      return;
    }
    renderGeneralDelayTemplates(Array.isArray(data) ? data : []);
  } catch (e) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty">加载失败: ' + escapeHtml(e.message) + '</td></tr>';
  }
}

document.getElementById('seq-run-btn').addEventListener('click', runSequence);
const seqContinueBtn = document.getElementById('seq-continue-btn');
const seqAbortBtn = document.getElementById('seq-abort-btn');
if (seqContinueBtn) seqContinueBtn.addEventListener('click', continueSequence);
if (seqAbortBtn) seqAbortBtn.addEventListener('click', abortSequence);

fetchStatus();
loadLabviewConfig();
refreshTemplateLists();
const genRunBtn = document.getElementById('gen-delay-run-btn');
const genRegBtn = document.getElementById('gen-delay-register-btn');
if (genRunBtn) genRunBtn.addEventListener('click', runGeneralDelay);
if (genRegBtn) genRegBtn.addEventListener('click', registerGeneralDelay);
setInterval(fetchStatus, POLL_MS);

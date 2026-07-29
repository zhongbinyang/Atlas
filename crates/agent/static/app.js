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
    showLvMsg('参数已加载', true);
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
    refreshTemplateLists();
  } catch (e) {
    showLvMsg('注册失败: ' + e.message, false);
  }
}

function showCenterAllMsg(text, ok) {
  const msg = document.getElementById('lv-center-all-msg');
  if (!msg) return;
  msg.hidden = false;
  msg.textContent = text;
  msg.className = ok ? 'msg ok' : 'msg err';
}

function loadTemplateToEditor(t) {
  document.getElementById('lv-vi-path').value = t.vi_path || '';
  document.getElementById('lv-name').value = t.name || '';
  renderInputsTable(t.inputs || []);
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

async function renameRegisteredTemplate(t) {
  const current = t.name || '';
  const next = prompt('重命名', current);
  if (next == null) return;
  const name = String(next).trim();
  if (!name) {
    showCenterAllMsg('名称不能为空', false);
    return;
  }
  if (name === current) return;
  showCenterAllMsg('重命名中…', true);
  try {
    const resp = await fetch('/api/labview/templates/' + encodeURIComponent(t.id), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name }),
    });
    const data = await resp.json().catch(function () { return {}; });
    if (!resp.ok) {
      const err = data.error && (data.error.message || data.error) || resp.status;
      showCenterAllMsg('重命名失败: ' + err, false);
      return;
    }
    showCenterAllMsg('已重命名: ' + (data.name || name), true);
    await refreshTemplateLists();
  } catch (e) {
    showCenterAllMsg('重命名失败: ' + e.message, false);
  }
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

async function trialRegisteredTemplate(t) {
  if (t.kind === 'delay' || t.vi_path === '__builtin__/delay') {
    const ms = delayMsFromInputs(t.inputs);
    if (ms == null) {
      showCenterAllMsg('模板缺少 delay_ms', false);
      return;
    }
    showCenterAllMsg('延迟试跑中: ' + (t.name || t.id) + '…', true);
    try {
      const resp = await fetch('/api/general/delay/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ delay_ms: ms }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        const err = data.error && (data.error.message || data.error) || resp.status;
        showCenterAllMsg('试跑失败: ' + err, false);
        return;
      }
      showCenterAllMsg('试跑完成: ' + (t.name || t.id) + ' (' + ms + ' ms)', true);
    } catch (e) {
      showCenterAllMsg('试跑失败: ' + e.message, false);
    }
    return;
  }
  const viPath = t.vi_path;
  if (!viPath) {
    showCenterAllMsg('模板缺少 VI 路径', false);
    return;
  }
  const opts = { show_front_panel: !!t.show_front_panel };
  if (t.timeout_secs != null && t.timeout_secs > 0) {
    opts.timeout_secs = t.timeout_secs;
  }
  showCenterAllMsg('试跑中: ' + (t.name || t.id) + '…', true);
  const outEl = document.getElementById('lv-run-out');
  outEl.hidden = false;
  outEl.textContent = '…';
  try {
    const resp = await fetch('/api/labview/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        vi_path: viPath,
        inputs: t.inputs || [],
        show_front_panel: opts.show_front_panel,
        timeout_secs: opts.timeout_secs,
      }),
    });
    const data = await resp.json();
    outEl.textContent = JSON.stringify(data, null, 2);
    if (!resp.ok) {
      const err = data.error && (data.error.message || data.error) || resp.status;
      showCenterAllMsg('试跑失败: ' + err, false);
      return;
    }
    showCenterAllMsg('试跑完成: ' + (t.name || t.id), true);
  } catch (e) {
    outEl.textContent = e.message;
    showCenterAllMsg('试跑失败: ' + e.message, false);
  }
}

function renderCenterAllTemplates(templates) {
  const tbody = document.getElementById('lv-center-all-body');
  if (!tbody) return;
  tbody.innerHTML = '';
  if (!templates || templates.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty">中心暂无已注册功能</td></tr>';
    return;
  }
  for (let i = 0; i < templates.length; i++) {
    const t = templates[i];
    const row = document.createElement('tr');
    const originCol = escapeHtml(t.origin_agent_name || '—');
    row.innerHTML =
      '<td class="mono">' + escapeHtml(String(t.id ?? '—')) + '</td>' +
      '<td>' + escapeHtml(t.name || t.id || '—') + '</td>' +
      '<td>' + originCol + '</td>' +
      '<td class="mono">' + escapeHtml(t.vi_path || '—') + '</td>' +
      '<td class="inputs-cell-host"></td>';
    attachInputsHover(row.querySelector('.inputs-cell-host'), t.inputs);
    const trialBtn = document.createElement('button');
    trialBtn.type = 'button';
    trialBtn.textContent = '试跑';
    trialBtn.addEventListener('click', function () {
      trialRegisteredTemplate(t);
    });
    const renameBtn = document.createElement('button');
    renameBtn.type = 'button';
    renameBtn.textContent = '重命名';
    renameBtn.addEventListener('click', function () {
      renameRegisteredTemplate(t);
    });
    const loadBtn = document.createElement('button');
    loadBtn.type = 'button';
    loadBtn.textContent = '加载到编辑区';
    loadBtn.addEventListener('click', function () {
      loadTemplateToEditor(t);
    });
    const actions = document.createElement('td');
    actions.appendChild(trialBtn);
    actions.appendChild(document.createTextNode(' '));
    actions.appendChild(renameBtn);
    actions.appendChild(document.createTextNode(' '));
    actions.appendChild(loadBtn);
    row.appendChild(actions);
    tbody.appendChild(row);
  }
}

async function fetchCenterAllTemplates() {
  const tbody = document.getElementById('lv-center-all-body');
  if (!tbody) return;
  try {
    const resp = await fetch('/api/labview/all-templates');
    const data = await resp.json();
    if (!resp.ok) {
      const err = data.error && (data.error.message || data.error) || resp.status;
      tbody.innerHTML =
        '<tr><td colspan="6" class="empty">加载失败: ' + escapeHtml(String(err)) + '</td></tr>';
      showCenterAllMsg('加载失败: ' + err, false);
      return;
    }
    renderCenterAllTemplates(Array.isArray(data) ? data : []);
    const msg = document.getElementById('lv-center-all-msg');
    if (msg && msg.className.indexOf('err') === -1) msg.hidden = true;
  } catch (e) {
    tbody.innerHTML =
      '<tr><td colspan="6" class="empty">加载失败: ' + escapeHtml(e.message) + '</td></tr>';
    showCenterAllMsg('加载失败: ' + e.message, false);
  }
}

async function refreshTemplateLists() {
  await Promise.all([fetchCenterAllTemplates(), loadSeqRegistered()]);
}

document.getElementById('lv-inspect-btn').addEventListener('click', inspectVi);
document.getElementById('lv-run-btn').addEventListener('click', runVi);
document.getElementById('lv-register-btn').addEventListener('click', registerViTemplate);
document.getElementById('lv-vi-path').addEventListener('blur', defaultLvNameFromPath);

// --- Sequence page ---

let seqRegistered = [];
let seqSelected = [];
let seqRunning = false;
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
  } else if (page === 'workbench') {
    fetchCenterAllTemplates();
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
  seqRunning = disabled;
  document.getElementById('seq-run-btn').disabled = disabled;
  document.querySelectorAll('#seq-registered-body button, #seq-selected-body button').forEach(function (btn) {
    btn.disabled = disabled;
  });
  document.querySelectorAll('#seq-selected-body tr[data-index]').forEach(function (row) {
    row.draggable = !disabled;
  });
}

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
    addBtn.disabled = seqRunning;
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
    tbody.innerHTML = '<tr><td colspan="5" class="empty">队列为空，从左侧添加</td></tr>';
    document.getElementById('seq-run-btn').disabled = seqRunning;
    return;
  }
  for (let i = 0; i < seqSelected.length; i++) {
    const item = seqSelected[i];
    const row = document.createElement('tr');
    row.setAttribute('data-index', String(i));
    row.draggable = !seqRunning;
    row.className = 'seq-row';
    const name = escapeHtml(item.name || item.vi_template_id || '—');
    const idCol = escapeHtml(String(item.vi_template_id ?? '—'));
    row.innerHTML =
      '<td class="mono">' + (i + 1) + '</td>' +
      '<td class="mono">' + idCol + '</td>' +
      '<td>' + name + '</td>' +
      '<td class="inputs-cell-host"></td>';
    attachInputsHover(row.querySelector('.inputs-cell-host'), item.inputs);
    const actions = document.createElement('td');
    actions.className = 'seq-row-actions';
    const upBtn = document.createElement('button');
    upBtn.type = 'button';
    upBtn.textContent = '↑';
    upBtn.title = '上移';
    upBtn.disabled = seqRunning || i === 0;
    upBtn.addEventListener('click', function () { moveQueueItem(i, -1); });
    const downBtn = document.createElement('button');
    downBtn.type = 'button';
    downBtn.textContent = '↓';
    downBtn.title = '下移';
    downBtn.disabled = seqRunning || i === seqSelected.length - 1;
    downBtn.addEventListener('click', function () { moveQueueItem(i, 1); });
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.textContent = '移除';
    removeBtn.disabled = seqRunning;
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
  document.getElementById('seq-run-btn').disabled = seqRunning || !seqSelected.length;
}

async function saveQueue() {
  const body = {
    items: seqSelected.map(function (item) {
      return { vi_template_id: item.vi_template_id };
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
    vi_path: template.vi_path || '',
    inputs: template.inputs || [],
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
  if (seqRunning) {
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
  if (seqDragIndex == null || seqRunning) return;
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

async function runSequence() {
  if (seqRunning || !seqSelected.length) return;
  setSeqControlsDisabled(true);
  document.getElementById('seq-results').innerHTML = '';
  showSeqMsg('执行中…', true);
  try {
    const resp = await fetch('/api/labview/run-sequence', { method: 'POST' });
    const data = await resp.json();
    if (!resp.ok) {
      const err = data.error && (data.error.message || data.error) || resp.status;
      showSeqMsg('执行失败: ' + err, false);
      return;
    }
    renderSeqResults(data);
    if (data.stopped) {
      showSeqMsg('执行中止于第 ' + ((data.failed_at != null ? data.failed_at : 0) + 1) + ' 步', false);
    } else {
      showSeqMsg('全部执行成功', true);
    }
  } catch (e) {
    showSeqMsg('执行失败: ' + e.message, false);
  } finally {
    setSeqControlsDisabled(false);
    renderSeqRegistered();
    renderSeqSelected();
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
    const trialBtn = document.createElement('button');
    trialBtn.type = 'button';
    trialBtn.textContent = '试跑';
    trialBtn.addEventListener('click', function () { trialGeneralDelayTemplate(t); });
    const renameBtn = document.createElement('button');
    renameBtn.type = 'button';
    renameBtn.textContent = '重命名';
    renameBtn.addEventListener('click', async function () {
      await renameRegisteredTemplate(t);
      await fetchGeneralDelayTemplates();
    });
    const loadBtn = document.createElement('button');
    loadBtn.type = 'button';
    loadBtn.textContent = '加载';
    loadBtn.addEventListener('click', function () {
      document.getElementById('gen-delay-name').value = t.name || '';
      const dms = delayMsFromInputs(t.inputs);
      document.getElementById('gen-delay-ms').value = dms != null ? String(dms) : '1000';
      showGenDelayMsg('已加载: ' + (t.name || t.id), true);
    });
    const actions = document.createElement('td');
    actions.appendChild(trialBtn);
    actions.appendChild(document.createTextNode(' '));
    actions.appendChild(renameBtn);
    actions.appendChild(document.createTextNode(' '));
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

fetchStatus();
loadLabviewConfig();
refreshTemplateLists();
const genRunBtn = document.getElementById('gen-delay-run-btn');
const genRegBtn = document.getElementById('gen-delay-register-btn');
if (genRunBtn) genRunBtn.addEventListener('click', runGeneralDelay);
if (genRegBtn) genRegBtn.addEventListener('click', registerGeneralDelay);
setInterval(fetchStatus, POLL_MS);

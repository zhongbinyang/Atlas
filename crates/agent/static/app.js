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
  busyEl.className = 'metric-busy ' + (data.busy ? 'is-busy' : 'is-idle');
  document.getElementById('uptime').textContent = formatUptime(data.uptime_secs);
}

async function fetchTasks() {
  const resp = await fetch('/api/tasks');
  if (!resp.ok) return;
  const tasks = await resp.json();
  const tbody = document.getElementById('tasks-body');
  tbody.innerHTML = '';
  if (tasks.length === 0) {
    const row = document.createElement('tr');
    row.innerHTML = '<td colspan="4" class="empty">暂无任务</td>';
    tbody.appendChild(row);
    return;
  }
  for (const t of tasks) {
    const row = document.createElement('tr');
    const exitCode = t.exit_code != null ? String(t.exit_code) : '—';
    row.innerHTML =
      '<td>' + escapeHtml(t.id) + '</td>' +
      '<td>' + escapeHtml(t.command) + '</td>' +
      '<td>' + escapeHtml(t.status) + '</td>' +
      '<td>' + escapeHtml(exitCode) + '</td>';
    tbody.appendChild(row);
  }
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

async function registerNow() {
  const msg = document.getElementById('register-msg');
  msg.hidden = false;
  msg.textContent = '注册中…';
  msg.className = 'msg';
  try {
    const resp = await fetch('/api/register-now', { method: 'POST' });
    const data = await resp.json();
    if (resp.ok) {
      msg.textContent = '注册成功';
      msg.className = 'msg ok';
    } else {
      msg.textContent = '注册失败: ' + (data.error || resp.status);
      msg.className = 'msg err';
    }
  } catch (e) {
    msg.textContent = '注册失败: ' + e.message;
    msg.className = 'msg err';
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
  const stem = viPath.replace(/^.*[\\/]/, '').replace(/\.vi$/i, '');
  showLvMsg('注册中…', true);
  try {
    const resp = await fetch('/api/labview/register-template', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({
        vi_path: viPath,
        inputs: inputs,
        name: stem || undefined,
      }, opts)),
    });
    const data = await resp.json();
    if (!resp.ok) {
      const err = data.error && (data.error.message || data.error) || resp.status;
      showLvMsg('注册失败: ' + err, false);
      return;
    }
    showLvMsg('已注册: ' + (data.name || data.id), true);
    fetchRegisteredTemplates();
  } catch (e) {
    showLvMsg('注册失败: ' + e.message, false);
  }
}

function showRegisteredMsg(text, ok) {
  const msg = document.getElementById('lv-registered-msg');
  msg.hidden = false;
  msg.textContent = text;
  msg.className = ok ? 'msg ok' : 'msg err';
}

function loadTemplateToEditor(t) {
  document.getElementById('lv-vi-path').value = t.vi_path || '';
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

async function trialRegisteredTemplate(t) {
  const viPath = t.vi_path;
  if (!viPath) {
    showRegisteredMsg('模板缺少 VI 路径', false);
    return;
  }
  const opts = { show_front_panel: !!t.show_front_panel };
  if (t.timeout_secs != null && t.timeout_secs > 0) {
    opts.timeout_secs = t.timeout_secs;
  }
  showRegisteredMsg('试跑中: ' + (t.name || t.id) + '…', true);
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
      showRegisteredMsg('试跑失败: ' + err, false);
      return;
    }
    showRegisteredMsg('试跑完成: ' + (t.name || t.id), true);
  } catch (e) {
    outEl.textContent = e.message;
    showRegisteredMsg('试跑失败: ' + e.message, false);
  }
}

function renderRegisteredTemplates(templates) {
  const tbody = document.getElementById('lv-registered-body');
  tbody.innerHTML = '';
  if (!templates || templates.length === 0) {
    tbody.innerHTML = '<tr><td colspan="3" class="empty">暂无已注册功能</td></tr>';
    return;
  }
  for (let i = 0; i < templates.length; i++) {
    const t = templates[i];
    const row = document.createElement('tr');
    const name = escapeHtml(t.name || t.id || '—');
    const viPath = escapeHtml(t.vi_path || '—');
    const trialBtn = document.createElement('button');
    trialBtn.type = 'button';
    trialBtn.textContent = '试跑';
    trialBtn.addEventListener('click', function () {
      trialRegisteredTemplate(t);
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
    actions.appendChild(loadBtn);
    row.innerHTML =
      '<td>' + name + '</td>' +
      '<td class="mono">' + viPath + '</td>';
    row.appendChild(actions);
    tbody.appendChild(row);
  }
}

async function fetchRegisteredTemplates() {
  const tbody = document.getElementById('lv-registered-body');
  try {
    const resp = await fetch('/api/labview/registered-templates');
    const data = await resp.json();
    if (!resp.ok) {
      const err = data.error && (data.error.message || data.error) || resp.status;
      tbody.innerHTML =
        '<tr><td colspan="3" class="empty">加载失败: ' + escapeHtml(String(err)) + '</td></tr>';
      showRegisteredMsg('加载失败: ' + err, false);
      return;
    }
    renderRegisteredTemplates(Array.isArray(data) ? data : []);
    document.getElementById('lv-registered-msg').hidden = true;
  } catch (e) {
    tbody.innerHTML =
      '<tr><td colspan="3" class="empty">加载失败: ' + escapeHtml(e.message) + '</td></tr>';
    showRegisteredMsg('加载失败: ' + e.message, false);
  }
}

document.getElementById('lv-inspect-btn').addEventListener('click', inspectVi);
document.getElementById('lv-run-btn').addEventListener('click', runVi);
document.getElementById('lv-register-btn').addEventListener('click', registerViTemplate);

// --- Sequence page ---

let seqRegistered = [];
let seqSelected = [];
let seqRunning = false;
let seqDragIndex = null;

function showPage(page) {
  const workbench = document.getElementById('page-workbench');
  const sequence = document.getElementById('page-sequence');
  workbench.hidden = page !== 'workbench';
  sequence.hidden = page !== 'sequence';
  document.querySelectorAll('.page-tabs .tab').forEach(function (btn) {
    btn.classList.toggle('active', btn.getAttribute('data-page') === page);
  });
  if (page === 'sequence') {
    loadSequencePage();
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
    const resp = await fetch('/api/labview/registered-templates');
    const data = await resp.json();
    if (!resp.ok) {
      const err = data.error && (data.error.message || data.error) || resp.status;
      tbody.innerHTML =
        '<tr><td colspan="3" class="empty">加载失败: ' + escapeHtml(String(err)) + '</td></tr>';
      return;
    }
    seqRegistered = Array.isArray(data) ? data : [];
    renderSeqRegistered();
  } catch (e) {
    tbody.innerHTML =
      '<tr><td colspan="3" class="empty">加载失败: ' + escapeHtml(e.message) + '</td></tr>';
  }
}

function renderSeqRegistered() {
  const tbody = document.getElementById('seq-registered-body');
  tbody.innerHTML = '';
  if (!seqRegistered.length) {
    tbody.innerHTML = '<tr><td colspan="3" class="empty">暂无已注册功能</td></tr>';
    return;
  }
  for (let i = 0; i < seqRegistered.length; i++) {
    const t = seqRegistered[i];
    const row = document.createElement('tr');
    const name = escapeHtml(t.name || t.id || '—');
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
    row.innerHTML = '<td>' + name + '</td><td class="mono">' + viPath + '</td>';
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
    tbody.innerHTML = '<tr><td colspan="3" class="empty">队列为空，从左侧添加</td></tr>';
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
    row.innerHTML = '<td class="mono">' + (i + 1) + '</td><td>' + name + '</td>';
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

document.getElementById('seq-run-btn').addEventListener('click', runSequence);

fetchStatus();
fetchTasks();
loadLabviewConfig();
fetchRegisteredTemplates();
setInterval(fetchStatus, POLL_MS);
setInterval(fetchTasks, POLL_MS);

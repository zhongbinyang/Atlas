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

fetchStatus();
fetchTasks();
loadLabviewConfig();
fetchRegisteredTemplates();
setInterval(fetchStatus, POLL_MS);
setInterval(fetchTasks, POLL_MS);

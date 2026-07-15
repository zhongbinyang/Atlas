const POLL_MS = 2000;

let agents = [];
let templates = [];
let tasks = [];
let selectedTaskId = null;
let historyAgentId = null;
let historyOffset = 0;
const HISTORY_LIMIT = 50;

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function statusClass(status) {
  if (status === 'online') return 'status-online';
  if (status === 'offline') return 'status-offline';
  return '';
}

function showMsg(el, text, ok) {
  el.hidden = false;
  el.textContent = text;
  el.className = ok ? 'msg ok' : 'msg err';
}

async function fetchAgents() {
  const resp = await fetch('/api/agents');
  if (!resp.ok) return;
  agents = await resp.json();
  renderAgents();
  updateAgentSelects();
}

function formatByteSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function openShotModal() {
  document.getElementById('shot-modal').hidden = false;
}

function closeShotModal() {
  document.getElementById('shot-modal').hidden = true;
  document.getElementById('shot-img').removeAttribute('src');
}

function openShotHistoryModal() {
  document.getElementById('shot-history-modal').hidden = false;
}

function closeShotHistoryModal() {
  document.getElementById('shot-history-modal').hidden = true;
  historyAgentId = null;
  historyOffset = 0;
}

function showScreenshotImage(id) {
  document.getElementById('shot-img').src =
    '/api/screenshots/' + encodeURIComponent(id) + '/image?' + Date.now();
  openShotModal();
}

async function takeScreenshot(agentId) {
  const resp = await fetch('/api/agents/' + encodeURIComponent(agentId) + '/screenshots', {
    method: 'POST',
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    alert(err.error || ('截图失败: ' + resp.status));
    return;
  }
  const meta = await resp.json();
  showScreenshotImage(meta.id);
}

async function openHistory(agentId, offset = 0) {
  historyAgentId = agentId;
  historyOffset = offset;
  const agent = agents.find(a => a.id === agentId);
  const title = document.getElementById('shot-history-title');
  title.textContent = '截图历史' + (agent ? ' — ' + agent.name : '');

  const resp = await fetch(
    '/api/agents/' + encodeURIComponent(agentId) +
      '/screenshots?limit=' + HISTORY_LIMIT + '&offset=' + offset
  );
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    alert(err.error || ('加载历史失败: ' + resp.status));
    return;
  }
  const data = await resp.json();
  renderHistory(data.items, data.total, offset);
  openShotHistoryModal();
}

function renderHistory(items, total, offset) {
  const tbody = document.getElementById('shot-history-body');
  tbody.innerHTML = '';
  if (items.length === 0) {
    tbody.innerHTML = '<tr><td colspan="3" class="empty">暂无截图</td></tr>';
  } else {
    for (const item of items) {
      const row = document.createElement('tr');
      row.innerHTML =
        '<td>' + escapeHtml(item.created_at) + '</td>' +
        '<td>' + escapeHtml(formatByteSize(item.byte_size)) + '</td>' +
        '<td><button type="button" class="btn-sm btn-view-shot" data-id="' +
          escapeHtml(item.id) + '">查看</button></td>';
      row.querySelector('.btn-view-shot').addEventListener('click', () => {
        showScreenshotImage(item.id);
      });
      tbody.appendChild(row);
    }
  }

  const pager = document.getElementById('shot-history-pager');
  const prevBtn = document.getElementById('shot-history-prev');
  const nextBtn = document.getElementById('shot-history-next');
  const pageInfo = document.getElementById('shot-history-page-info');

  if (total > items.length || offset > 0) {
    pager.hidden = false;
    const start = offset + 1;
    const end = offset + items.length;
    pageInfo.textContent = start + '–' + end + ' / ' + total;
    prevBtn.disabled = offset === 0;
    nextBtn.disabled = offset + items.length >= total;
  } else {
    pager.hidden = true;
  }
}

function renderAgents() {
  const tbody = document.getElementById('agents-body');
  tbody.innerHTML = '';
  if (agents.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty">暂无 Agent</td></tr>';
    return;
  }
  for (const a of agents) {
    const row = document.createElement('tr');
    const busy = a.busy ? '<span class="status-busy">是</span>' : '否';
    row.innerHTML =
      '<td>' + escapeHtml(a.name) + '</td>' +
      '<td>' + escapeHtml(a.ip) + ':' + a.port + '</td>' +
      '<td class="' + statusClass(a.status) + '">' + escapeHtml(a.status) + '</td>' +
      '<td>' + a.cpu_percent.toFixed(1) + '%</td>' +
      '<td>' + a.memory_percent.toFixed(1) + '%</td>' +
      '<td>' + busy + '</td>' +
      '<td>' +
        '<button type="button" class="btn-sm btn-shot" data-id="' + escapeHtml(a.id) + '">截图</button>' +
        '<button type="button" class="btn-sm btn-history" data-id="' + escapeHtml(a.id) + '">历史</button>' +
      '</td>';
    row.querySelector('.btn-shot').addEventListener('click', () => takeScreenshot(a.id));
    row.querySelector('.btn-history').addEventListener('click', () => openHistory(a.id));
    tbody.appendChild(row);
  }
}

async function fetchTemplates() {
  const resp = await fetch('/api/templates');
  if (!resp.ok) return;
  templates = await resp.json();
  renderTemplates();
  updateTemplateSelect();
}

function renderTemplates() {
  const tbody = document.getElementById('templates-body');
  tbody.innerHTML = '';
  if (templates.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty">暂无模板</td></tr>';
    return;
  }
  for (const t of templates) {
    const row = document.createElement('tr');
    row.innerHTML =
      '<td>' + escapeHtml(t.name) + '</td>' +
      '<td>' + escapeHtml(t.shell) + '</td>' +
      '<td>' + escapeHtml(t.command) + '</td>' +
      '<td>' + t.timeout_secs + 's</td>' +
      '<td><button type="button" class="btn-danger btn-sm" data-id="' + escapeHtml(t.id) + '">删除</button></td>';
    row.querySelector('button').addEventListener('click', () => deleteTemplate(t.id));
    tbody.appendChild(row);
  }
}

async function deleteTemplate(id) {
  if (!confirm('确定删除此模板？')) return;
  const resp = await fetch('/api/templates/' + encodeURIComponent(id), { method: 'DELETE' });
  if (resp.ok || resp.status === 204) {
    await fetchTemplates();
  } else {
    const data = await resp.json().catch(() => ({}));
    alert('删除失败: ' + (data.error || resp.status));
  }
}

document.getElementById('template-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = document.getElementById('template-msg');
  const body = {
    name: document.getElementById('tpl-name').value.trim(),
    shell: document.getElementById('tpl-shell').value,
    command: document.getElementById('tpl-command').value.trim(),
    workdir: document.getElementById('tpl-workdir').value.trim() || null,
    timeout_secs: parseInt(document.getElementById('tpl-timeout').value, 10) || 300,
  };
  try {
    const resp = await fetch('/api/templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await resp.json().catch(() => ({}));
    if (resp.ok) {
      showMsg(msg, '模板创建成功', true);
      e.target.reset();
      document.getElementById('tpl-timeout').value = '300';
      await fetchTemplates();
    } else {
      showMsg(msg, '创建失败: ' + (data.error || resp.status), false);
    }
  } catch (err) {
    showMsg(msg, '创建失败: ' + err.message, false);
  }
});

function updateAgentSelects() {
  const sel = document.getElementById('task-agent');
  const prev = sel.value;
  sel.innerHTML = '<option value="">— 选择 Agent —</option>';
  for (const a of agents) {
    const opt = document.createElement('option');
    opt.value = a.id;
    opt.textContent = a.name + ' (' + a.ip + ')';
    sel.appendChild(opt);
  }
  if (prev && agents.some(a => a.id === prev)) sel.value = prev;
}

function updateTemplateSelect() {
  const sel = document.getElementById('task-template');
  const prev = sel.value;
  sel.innerHTML = '<option value="">— 选择模板 —</option>';
  for (const t of templates) {
    const opt = document.createElement('option');
    opt.value = t.id;
    opt.textContent = t.name;
    sel.appendChild(opt);
  }
  if (prev && templates.some(t => t.id === prev)) sel.value = prev;
}

function syncTaskFormMode() {
  const isAdhoc = document.getElementById('task-source').value === 'adhoc';
  document.getElementById('task-template').disabled = isAdhoc;
  document.getElementById('task-shell').disabled = !isAdhoc;
  document.getElementById('task-command').disabled = !isAdhoc;
  document.getElementById('task-workdir').disabled = !isAdhoc;
  document.getElementById('task-timeout').disabled = !isAdhoc;
}

document.getElementById('task-source').addEventListener('change', syncTaskFormMode);

document.getElementById('task-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = document.getElementById('task-msg');
  const agentId = document.getElementById('task-agent').value;
  if (!agentId) {
    showMsg(msg, '请选择 Agent', false);
    return;
  }
  const isAdhoc = document.getElementById('task-source').value === 'adhoc';
  const body = { agent_id: agentId };
  if (isAdhoc) {
    const command = document.getElementById('task-command').value.trim();
    if (!command) {
      showMsg(msg, '请输入命令', false);
      return;
    }
    body.command = command;
    body.shell = document.getElementById('task-shell').value;
    const workdir = document.getElementById('task-workdir').value.trim();
    if (workdir) body.workdir = workdir;
    body.timeout_secs = parseInt(document.getElementById('task-timeout').value, 10) || 300;
  } else {
    const templateId = document.getElementById('task-template').value;
    if (!templateId) {
      showMsg(msg, '请选择模板', false);
      return;
    }
    body.template_id = templateId;
  }
  try {
    const resp = await fetch('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await resp.json().catch(() => ({}));
    if (resp.ok) {
      showMsg(msg, '任务已提交', true);
      await fetchTasks();
      if (data.id) showTaskDetail(data.id);
    } else {
      showMsg(msg, '提交失败: ' + (data.error || resp.status), false);
    }
  } catch (err) {
    showMsg(msg, '提交失败: ' + err.message, false);
  }
});

async function fetchTasks() {
  const resp = await fetch('/api/tasks');
  if (!resp.ok) return;
  tasks = await resp.json();
  renderTasks();
  if (selectedTaskId) {
    const t = tasks.find(x => x.id === selectedTaskId);
    if (t) renderTaskDetail(t);
  }
}

function renderTasks() {
  const tbody = document.getElementById('tasks-body');
  tbody.innerHTML = '';
  if (tasks.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty">暂无任务</td></tr>';
    return;
  }
  for (const t of tasks) {
    const row = document.createElement('tr');
    row.className = 'clickable';
    if (t.id === selectedTaskId) row.style.background = '#eef4ff';
    const agent = agents.find(a => a.id === t.agent_id);
    const agentName = agent ? agent.name : t.agent_id.slice(0, 8);
    const exitCode = t.exit_code != null ? String(t.exit_code) : '—';
    row.innerHTML =
      '<td>' + escapeHtml(t.id.slice(0, 8)) + '…</td>' +
      '<td>' + escapeHtml(agentName) + '</td>' +
      '<td>' + escapeHtml(t.command) + '</td>' +
      '<td>' + escapeHtml(t.status) + '</td>' +
      '<td>' + escapeHtml(exitCode) + '</td>';
    row.addEventListener('click', () => showTaskDetail(t.id));
    tbody.appendChild(row);
  }
}

async function showTaskDetail(id) {
  selectedTaskId = id;
  const resp = await fetch('/api/tasks/' + encodeURIComponent(id));
  if (!resp.ok) return;
  const t = await resp.json();
  renderTaskDetail(t);
  renderTasks();
}

function renderTaskDetail(t) {
  const section = document.getElementById('task-detail-section');
  section.hidden = false;
  const meta = document.getElementById('task-detail-meta');
  meta.innerHTML =
    '<dt>ID</dt><dd>' + escapeHtml(t.id) + '</dd>' +
    '<dt>Agent</dt><dd>' + escapeHtml(t.agent_id) + '</dd>' +
    '<dt>来源</dt><dd>' + escapeHtml(t.source) + '</dd>' +
    '<dt>Shell</dt><dd>' + escapeHtml(t.shell) + '</dd>' +
    '<dt>命令</dt><dd>' + escapeHtml(t.command) + '</dd>' +
    '<dt>状态</dt><dd>' + escapeHtml(t.status) + '</dd>' +
    '<dt>退出码</dt><dd>' + (t.exit_code != null ? t.exit_code : '—') + '</dd>' +
    '<dt>创建时间</dt><dd>' + escapeHtml(t.created_at) + '</dd>' +
    '<dt>开始时间</dt><dd>' + escapeHtml(t.started_at || '—') + '</dd>' +
    '<dt>结束时间</dt><dd>' + escapeHtml(t.finished_at || '—') + '</dd>';
  document.getElementById('task-stdout').textContent = t.stdout || '(空)';
  document.getElementById('task-stderr').textContent = t.stderr || '(空)';
}

document.getElementById('close-detail').addEventListener('click', () => {
  selectedTaskId = null;
  document.getElementById('task-detail-section').hidden = true;
  renderTasks();
});

document.getElementById('refresh-btn').addEventListener('click', refreshAll);

document.getElementById('shot-close').addEventListener('click', closeShotModal);
document.getElementById('shot-history-close').addEventListener('click', closeShotHistoryModal);

document.querySelectorAll('.modal-backdrop').forEach(el => {
  el.addEventListener('click', () => {
    const id = el.getAttribute('data-close');
    if (id === 'shot-modal') closeShotModal();
    else if (id === 'shot-history-modal') closeShotHistoryModal();
  });
});

document.getElementById('shot-history-prev').addEventListener('click', () => {
  if (historyAgentId && historyOffset > 0) {
    openHistory(historyAgentId, Math.max(0, historyOffset - HISTORY_LIMIT));
  }
});

document.getElementById('shot-history-next').addEventListener('click', () => {
  if (historyAgentId) {
    openHistory(historyAgentId, historyOffset + HISTORY_LIMIT);
  }
});

async function refreshAll() {
  await Promise.all([fetchAgents(), fetchTemplates(), fetchTasks()]);
}

syncTaskFormMode();
refreshAll();
setInterval(refreshAll, POLL_MS);

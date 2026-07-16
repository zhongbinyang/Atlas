const POLL_MS = 2000;

let agents = [];
let templates = [];
let viTemplates = [];
let tasks = [];
let selectedTaskId = null;
let historyAgentId = null;
let historyOffset = 0;
let viLabviewConfig = null;
let distributeTemplate = null;
const HISTORY_LIMIT = 50;
let filesAgentId = null;
let filesPath = '';

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

function viStemFromPath(viPath) {
  return String(viPath || '').replace(/^.*[\\/]/, '').replace(/\.vi$/i, '');
}

function defaultViNameFromPath() {
  const pathEl = document.getElementById('vi-vi-path');
  const nameEl = document.getElementById('vi-name');
  if (!pathEl || !nameEl) return;
  if (nameEl.value.trim() !== '') return;
  const stem = viStemFromPath(normalizeFsPath(pathEl.value));
  if (stem) nameEl.value = stem;
}

function agentStatusKind(a) {
  if (a.status === 'offline') return 'offline';
  if (a.busy) return 'busy';
  return 'ok';
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
  updateViAgentSelect();
  updateViTemplatesAgentFilter();
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

function openFilesModal() {
  document.getElementById('files-modal').hidden = false;
}

function closeFilesModal() {
  document.getElementById('files-modal').hidden = true;
  filesAgentId = null;
  filesPath = '';
}

function openFilePreviewModal() {
  document.getElementById('file-preview-modal').hidden = false;
}

function closeFilePreviewModal() {
  document.getElementById('file-preview-modal').hidden = true;
  document.getElementById('file-preview-pre').hidden = true;
  document.getElementById('file-preview-pre').textContent = '';
  document.getElementById('file-preview-img').hidden = true;
  document.getElementById('file-preview-img').removeAttribute('src');
}

function openDistributeModal(t) {
  distributeTemplate = t;
  document.getElementById('vi-distribute-title').textContent = '分发 — ' + t.name;
  const container = document.getElementById('vi-distribute-agents');
  container.innerHTML = '';
  const others = agents.filter(a => a.id !== t.agent_id);
  if (others.length === 0) {
    container.innerHTML = '<p class="empty">无其他 Agent 可分发</p>';
  } else {
    for (const a of others) {
      const label = document.createElement('label');
      label.className = 'lv-check';
      const rb = document.createElement('input');
      rb.type = 'radio';
      rb.name = 'vi-distribute-target';
      rb.value = a.id;
      label.appendChild(rb);
      label.appendChild(document.createTextNode(a.name || a.id.slice(0, 8)));
      container.appendChild(label);
    }
  }
  document.getElementById('vi-distribute-path').value = '';
  document.getElementById('vi-distribute-results').textContent = '';
  document.getElementById('vi-distribute-modal').hidden = false;
}

function closeDistributeModal() {
  document.getElementById('vi-distribute-modal').hidden = true;
  distributeTemplate = null;
  document.getElementById('vi-distribute-results').textContent = '';
}

async function submitDistribute() {
  if (!distributeTemplate) return;
  const selected = document.querySelector('#vi-distribute-agents input[type=radio]:checked');
  const resultsEl = document.getElementById('vi-distribute-results');
  if (!selected) {
    resultsEl.textContent = '请选择一个目标 Agent';
    return;
  }
  const pathRaw = normalizeFsPath(document.getElementById('vi-distribute-path').value);
  const body = {
    target_agent_id: selected.value,
    vi_path: pathRaw || null,
  };
  resultsEl.textContent = '分发中…';
  try {
    const resp = await fetch(
      '/api/vi-templates/' + encodeURIComponent(distributeTemplate.id) + '/distribute',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
    const data = await resp.json();
    if (!resp.ok) {
      resultsEl.textContent = '分发失败: ' + (data.error || resp.status);
      return;
    }
    const agent = agents.find(a => a.id === data.agent_id);
    const agentName = data.agent_name || (agent ? agent.name : null) ||
      (data.agent_id ? data.agent_id.slice(0, 8) : '—');
    const idShort = data.id ? data.id.slice(0, 8) + '…' : '';
    resultsEl.textContent = '已挪至 ' + agentName +
      (idShort ? '（id: ' + idShort + '）' : '') +
      '；源机不再持有该模板';
    await fetchViTemplates();
  } catch (e) {
    resultsEl.textContent = '分发失败: ' + e.message;
  }
}

function joinFilesPath(base, name) {
  return base ? base + '/' + name : name;
}

function fileContentUrl(relPath, download) {
  let url = '/api/agents/' + encodeURIComponent(filesAgentId) +
    '/files/content?path=' + encodeURIComponent(relPath);
  if (download) url += '&download=1';
  return url;
}

async function openFiles(agentId) {
  filesAgentId = agentId;
  filesPath = '';
  const agent = agents.find(a => a.id === agentId);
  const title = document.getElementById('files-title');
  title.textContent = '文件' + (agent ? ' — ' + agent.name : '');
  await loadFiles();
  openFilesModal();
}

async function loadFiles() {
  const q = filesPath ? ('?path=' + encodeURIComponent(filesPath)) : '';
  const resp = await fetch('/api/agents/' + encodeURIComponent(filesAgentId) + '/files' + q);
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    alert(err.error || ('加载文件失败: ' + resp.status));
    return;
  }
  const data = await resp.json();
  renderFilesCrumb(data.path || filesPath);
  renderFiles(data.entries || []);
}

function renderFilesCrumb(path) {
  const crumb = document.getElementById('files-crumb');
  crumb.innerHTML = '';
  const root = document.createElement('a');
  root.textContent = '根目录';
  root.addEventListener('click', () => {
    filesPath = '';
    loadFiles();
  });
  crumb.appendChild(root);

  if (!path) return;
  const parts = path.split('/').filter(Boolean);
  let acc = '';
  for (const part of parts) {
    const sep = document.createElement('span');
    sep.className = 'crumb-sep';
    sep.textContent = '/';
    crumb.appendChild(sep);

    acc = joinFilesPath(acc, part);
    const link = document.createElement('a');
    link.textContent = part;
    const target = acc;
    link.addEventListener('click', () => {
      filesPath = target;
      loadFiles();
    });
    crumb.appendChild(link);
  }
}

function renderFiles(entries) {
  const tbody = document.getElementById('files-body');
  tbody.innerHTML = '';
  if (entries.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" class="empty">暂无文件</td></tr>';
    return;
  }

  const sorted = entries.slice().sort((a, b) => {
    if (a.kind === 'dir' && b.kind !== 'dir') return -1;
    if (a.kind !== 'dir' && b.kind === 'dir') return 1;
    return a.name.localeCompare(b.name);
  });

  for (const entry of sorted) {
    const row = document.createElement('tr');
    const isDir = entry.kind === 'dir';
    const ext = entry.ext || '';
    const relPath = joinFilesPath(filesPath, entry.name);
    const size = isDir ? '—' : formatByteSize(entry.size || 0);
    const kindLabel = isDir ? '目录' : (ext || '文件');

    let actions = '';
    if (isDir) {
      actions = '<button type="button" class="btn-sm btn-files-open">打开</button>';
    } else if (ext === 'txt' || ext === 'gif') {
      actions =
        '<button type="button" class="btn-sm btn-files-preview">预览</button>' +
        '<button type="button" class="btn-sm btn-files-download">下载</button>';
    }

    row.innerHTML =
      '<td>' + escapeHtml(entry.name) + '</td>' +
      '<td>' + escapeHtml(kindLabel) + '</td>' +
      '<td>' + escapeHtml(size) + '</td>' +
      '<td>' + actions + '</td>';

    const openBtn = row.querySelector('.btn-files-open');
    if (openBtn) {
      openBtn.addEventListener('click', () => {
        filesPath = relPath;
        loadFiles();
      });
    }

    const previewBtn = row.querySelector('.btn-files-preview');
    if (previewBtn) {
      previewBtn.addEventListener('click', () => previewFile(relPath, ext, entry.name));
    }

    const downloadBtn = row.querySelector('.btn-files-download');
    if (downloadBtn) {
      downloadBtn.addEventListener('click', () => downloadFile(relPath));
    }

    tbody.appendChild(row);
  }
}

function previewFile(relPath, ext, name) {
  const pre = document.getElementById('file-preview-pre');
  const img = document.getElementById('file-preview-img');
  document.getElementById('file-preview-title').textContent = '预览 — ' + name;
  const url = fileContentUrl(relPath, false);

  if (ext === 'gif') {
    pre.hidden = true;
    pre.textContent = '';
    img.hidden = false;
    img.src = url;
    openFilePreviewModal();
    return;
  }

  img.hidden = true;
  img.removeAttribute('src');
  pre.hidden = false;
  pre.textContent = '加载中…';
  openFilePreviewModal();

  fetch(url)
    .then(r => {
      if (!r.ok) throw new Error('加载失败: ' + r.status);
      return r.text();
    })
    .then(t => { pre.textContent = t; })
    .catch(err => { pre.textContent = err.message; });
}

function downloadFile(relPath) {
  window.open(fileContentUrl(relPath, true), '_blank');
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
    const kind = agentStatusKind(a);
    const label =
      kind === 'offline' ? '离线' : kind === 'busy' ? '在线 · 执行中' : '在线 · 空闲';
    const offline = kind === 'offline';
    const dis = offline ? ' disabled' : '';
    row.innerHTML =
      '<td class="mono">' + escapeHtml(a.name) + '</td>' +
      '<td class="mono">' + escapeHtml(a.ip) + ':' + a.port + '</td>' +
      '<td><span class="status-dot status-' + kind + '"></span>' + label + '</td>' +
      '<td class="mono">' + a.cpu_percent.toFixed(1) + '%</td>' +
      '<td class="mono">' + a.memory_percent.toFixed(1) + '%</td>' +
      '<td>' + (a.busy ? '是' : '否') + '</td>' +
      '<td class="row-actions">' +
        '<button type="button" class="btn-sm btn-shot" data-id="' + escapeHtml(a.id) + '"' + dis + '>截图</button>' +
        '<button type="button" class="btn-sm btn-history" data-id="' + escapeHtml(a.id) + '"' + dis + '>历史</button>' +
        '<button type="button" class="btn-sm btn-files" data-id="' + escapeHtml(a.id) + '"' + dis + '>文件</button>' +
      '</td>';
    if (!offline) {
      row.querySelector('.btn-shot').addEventListener('click', () => takeScreenshot(a.id));
      row.querySelector('.btn-history').addEventListener('click', () => openHistory(a.id));
      row.querySelector('.btn-files').addEventListener('click', () => openFiles(a.id));
    }
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
    if (t.id === selectedTaskId) row.classList.add('row-selected');
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
  document.getElementById('task-detail-section').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
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
document.getElementById('files-close').addEventListener('click', closeFilesModal);
document.getElementById('file-preview-close').addEventListener('click', closeFilePreviewModal);
document.getElementById('vi-distribute-close').addEventListener('click', closeDistributeModal);
document.getElementById('vi-distribute-cancel').addEventListener('click', closeDistributeModal);
document.getElementById('vi-distribute-submit').addEventListener('click', submitDistribute);

document.querySelectorAll('.modal-backdrop').forEach(el => {
  el.addEventListener('click', () => {
    const id = el.getAttribute('data-close');
    if (id === 'shot-modal') closeShotModal();
    else if (id === 'shot-history-modal') closeShotHistoryModal();
    else if (id === 'files-modal') closeFilesModal();
    else if (id === 'file-preview-modal') closeFilePreviewModal();
    else if (id === 'vi-distribute-modal') closeDistributeModal();
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

function showView(name) {
  const views = {
    machines: document.getElementById('view-machines'),
    jobs: document.getElementById('view-jobs'),
    vi: document.getElementById('view-vi'),
  };
  const navs = {
    machines: document.getElementById('nav-machines'),
    jobs: document.getElementById('nav-jobs'),
    vi: document.getElementById('nav-vi'),
  };
  for (const key of Object.keys(views)) {
    const active = name === key;
    views[key].hidden = !active;
    views[key].classList.toggle('view-active', active);
    navs[key].classList.toggle('active', active);
  }
}

document.getElementById('nav-machines').addEventListener('click', () => showView('machines'));
document.getElementById('nav-jobs').addEventListener('click', () => showView('jobs'));
document.getElementById('nav-vi').addEventListener('click', () => showView('vi'));
showView('machines');

async function refreshAll() {
  await Promise.all([fetchAgents(), fetchTemplates(), fetchTasks(), fetchViTemplates()]);
}

function updateViTemplatesAgentFilter() {
  const sel = document.getElementById('vi-templates-agent-filter');
  if (!sel) return;
  const prev = sel.value;
  sel.innerHTML = '<option value="">全部</option>';
  for (const a of agents) {
    const opt = document.createElement('option');
    opt.value = a.id;
    opt.textContent = a.name + ' (' + a.ip + ')';
    sel.appendChild(opt);
  }
  if (prev && agents.some(a => a.id === prev)) sel.value = prev;
}

function updateViAgentSelect() {
  const sel = document.getElementById('vi-agent');
  if (!sel) return;
  const prev = sel.value;
  sel.innerHTML = '<option value="">— 选择 Agent —</option>';
  for (const a of agents) {
    if (a.status === 'offline') continue;
    const opt = document.createElement('option');
    opt.value = a.id;
    opt.textContent = a.name + ' (' + a.ip + ')';
    sel.appendChild(opt);
  }
  if (prev && agents.some(a => a.id === prev && a.status !== 'offline')) {
    sel.value = prev;
    loadViLabviewConfig(prev);
  } else {
    viLabviewConfig = null;
    document.getElementById('vi-cli').textContent = '—';
    document.getElementById('vi-getinfo').textContent = '—';
  }
}

async function loadViLabviewConfig(agentId) {
  if (!agentId) {
    viLabviewConfig = null;
    document.getElementById('vi-cli').textContent = '—';
    document.getElementById('vi-getinfo').textContent = '—';
    return;
  }
  const resp = await fetch('/api/agents/' + encodeURIComponent(agentId) + '/labview/config');
  if (!resp.ok) {
    viLabviewConfig = null;
    document.getElementById('vi-cli').textContent = '—';
    document.getElementById('vi-getinfo').textContent = '—';
    return;
  }
  viLabviewConfig = await resp.json();
  document.getElementById('vi-cli').textContent = viLabviewConfig.cli_path;
  document.getElementById('vi-getinfo').textContent = viLabviewConfig.getinfo_path;
}

function showViMsg(text, ok) {
  showMsg(document.getElementById('vi-msg'), text, ok);
}

function showViTemplatesMsg(text, ok) {
  showMsg(document.getElementById('vi-templates-msg'), text, ok);
}

function isJsonScalar(value) {
  return value !== null && typeof value === 'object';
}

function renderViInputsTable(inputs) {
  const tbody = document.getElementById('vi-inputs-body');
  tbody.innerHTML = '';
  if (!inputs || inputs.length === 0) {
    tbody.innerHTML = '<tr><td colspan="3" class="empty">无输入参数</td></tr>';
    return;
  }
  for (const inp of inputs) {
    const row = document.createElement('tr');
    const name = escapeHtml(inp.name || '');
    const className = escapeHtml(inp.className || inp.type || '');
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

function collectViInputsFromTable() {
  const inputs = [];
  document.querySelectorAll('#vi-inputs-body .lv-value').forEach(function (el) {
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

function readViRunOptions() {
  const showFp = document.getElementById('vi-show-fp').checked;
  const timeoutRaw = document.getElementById('vi-timeout').value.trim();
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

function selectedViAgentId() {
  return document.getElementById('vi-agent').value;
}

function requireViAgent() {
  const agentId = selectedViAgentId();
  if (!agentId) throw new Error('请选择 Agent');
  return agentId;
}

async function inspectVi() {
  let agentId;
  try {
    agentId = requireViAgent();
  } catch (e) {
    showViMsg(e.message, false);
    return;
  }
  const pathEl = document.getElementById('vi-vi-path');
  const viPath = normalizeFsPath(pathEl.value);
  pathEl.value = viPath;
  if (!viPath) {
    showViMsg('请输入 VI 路径', false);
    return;
  }
  defaultViNameFromPath();
  showViMsg('查询中…', true);
  document.getElementById('vi-run-out').hidden = true;
  try {
    const resp = await fetch('/api/agents/' + encodeURIComponent(agentId) + '/labview/inspect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vi_path: viPath }),
    });
    const data = await resp.json();
    document.getElementById('vi-json-raw').textContent = JSON.stringify(data, null, 2);
    if (!resp.ok) {
      const err = data.error && (data.error.message || data.error) || resp.status;
      showViMsg('查询失败: ' + err, false);
      return;
    }
    renderViInputsTable(data.inputs || data.controls || []);
    showViMsg('参数已加载', true);
  } catch (e) {
    showViMsg('查询失败: ' + e.message, false);
  }
}

async function runVi() {
  let agentId;
  try {
    agentId = requireViAgent();
  } catch (e) {
    showViMsg(e.message, false);
    return;
  }
  const pathEl = document.getElementById('vi-vi-path');
  const viPath = normalizeFsPath(pathEl.value);
  pathEl.value = viPath;
  if (!viPath) {
    showViMsg('请输入 VI 路径', false);
    return;
  }
  let inputs;
  try {
    inputs = collectViInputsFromTable();
  } catch (e) {
    showViMsg(e.message, false);
    return;
  }
  let opts;
  try {
    opts = readViRunOptions();
  } catch (e) {
    showViMsg(e.message, false);
    return;
  }
  showViMsg('试跑中…', true);
  const outEl = document.getElementById('vi-run-out');
  outEl.hidden = false;
  outEl.textContent = '…';
  try {
    const resp = await fetch('/api/agents/' + encodeURIComponent(agentId) + '/labview/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ vi_path: viPath, inputs: inputs }, opts)),
    });
    const data = await resp.json();
    outEl.textContent = JSON.stringify(data, null, 2);
    if (!resp.ok) {
      const err = data.error && (data.error.message || data.error) || resp.status;
      showViMsg('试跑失败: ' + err, false);
      return;
    }
    showViMsg('试跑完成', true);
  } catch (e) {
    outEl.textContent = e.message;
    showViMsg('试跑失败: ' + e.message, false);
  }
}

async function registerViTemplate() {
  let agentId;
  try {
    agentId = requireViAgent();
  } catch (e) {
    showViMsg(e.message, false);
    return;
  }
  if (!viLabviewConfig) {
    showViMsg('Agent LabVIEW 配置未加载', false);
    return;
  }
  const pathEl = document.getElementById('vi-vi-path');
  const viPath = normalizeFsPath(pathEl.value);
  pathEl.value = viPath;
  if (!viPath) {
    showViMsg('请输入 VI 路径', false);
    return;
  }
  defaultViNameFromPath();
  const name = document.getElementById('vi-name').value.trim();
  if (!name) {
    showViMsg('请输入名称', false);
    return;
  }
  let inputs;
  try {
    inputs = collectViInputsFromTable();
  } catch (e) {
    showViMsg(e.message, false);
    return;
  }
  let opts;
  try {
    opts = readViRunOptions();
  } catch (e) {
    showViMsg(e.message, false);
    return;
  }
  showViMsg('注册中…', true);
  try {
    const body = Object.assign({
      agent_id: agentId,
      vi_path: viPath,
      cli_path: viLabviewConfig.cli_path,
      getinfo_path: viLabviewConfig.getinfo_path,
      inputs: inputs,
      name: name,
    }, opts);
    const resp = await fetch('/api/vi-templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await resp.json();
    if (!resp.ok) {
      showViMsg('注册失败: ' + (data.error || resp.status), false);
      return;
    }
    showViMsg('已注册: ' + (data.name || data.id), true);
    await fetchViTemplates();
  } catch (e) {
    showViMsg('注册失败: ' + e.message, false);
  }
}

async function fetchViTemplates() {
  const filterEl = document.getElementById('vi-templates-agent-filter');
  let url = '/api/vi-templates';
  if (filterEl && filterEl.value) {
    url += '?agent_id=' + encodeURIComponent(filterEl.value);
  }
  const resp = await fetch(url);
  if (!resp.ok) return;
  viTemplates = await resp.json();
  renderViTemplates();
}

function renderViTemplates() {
  const tbody = document.getElementById('vi-templates-body');
  if (!tbody) return;
  tbody.innerHTML = '';
  if (viTemplates.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty">暂无 VI 模板</td></tr>';
    return;
  }
  for (const t of viTemplates) {
    const row = document.createElement('tr');
    const agentCol = t.agent_name || t.agent_id.slice(0, 8);
    const originCol = t.origin_agent_name || '—';
    const timeout = t.timeout_secs != null ? t.timeout_secs + 's' : '—';
    row.innerHTML =
      '<td>' + escapeHtml(t.name) + '</td>' +
      '<td>' + escapeHtml(agentCol) + '</td>' +
      '<td>' + escapeHtml(originCol) + '</td>' +
      '<td class="mono">' + escapeHtml(t.vi_path) + '</td>' +
      '<td>' + escapeHtml(timeout) + '</td>' +
      '<td class="row-actions">' +
        '<button type="button" class="btn-sm btn-vi-trial">试跑</button>' +
        '<button type="button" class="btn-sm btn-vi-rename">重命名</button>' +
        '<button type="button" class="btn-sm btn-vi-distribute">分发</button>' +
        '<button type="button" class="btn-sm btn-danger btn-vi-delete">删除</button>' +
      '</td>';
    row.querySelector('.btn-vi-trial').addEventListener('click', () => trialRunViTemplate(t));
    row.querySelector('.btn-vi-rename').addEventListener('click', () => renameViTemplate(t));
    row.querySelector('.btn-vi-distribute').addEventListener('click', () => openDistributeModal(t));
    row.querySelector('.btn-vi-delete').addEventListener('click', () => deleteViTemplate(t.id));
    tbody.appendChild(row);
  }
}

async function renameViTemplate(t) {
  const current = t.name || '';
  const next = prompt('重命名', current);
  if (next == null) return;
  const name = String(next).trim();
  if (!name) {
    showViTemplatesMsg('名称不能为空', false);
    return;
  }
  if (name === current) return;
  showViTemplatesMsg('重命名中…', true);
  try {
    const resp = await fetch('/api/vi-templates/' + encodeURIComponent(t.id), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      showViTemplatesMsg('重命名失败: ' + (data.error || resp.status), false);
      return;
    }
    showViTemplatesMsg('已重命名: ' + (data.name || name), true);
    await fetchViTemplates();
  } catch (e) {
    showViTemplatesMsg('重命名失败: ' + e.message, false);
  }
}

async function trialRunViTemplate(t) {
  showViTemplatesMsg('试跑中…', true);
  const outEl = document.getElementById('vi-run-out');
  outEl.hidden = false;
  outEl.textContent = '…';
  const body = {
    vi_path: t.vi_path,
    inputs: t.inputs,
    show_front_panel: t.show_front_panel,
  };
  if (t.timeout_secs != null) body.timeout_secs = t.timeout_secs;
  try {
    const resp = await fetch('/api/agents/' + encodeURIComponent(t.agent_id) + '/labview/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await resp.json();
    outEl.textContent = JSON.stringify(data, null, 2);
    if (!resp.ok) {
      const err = data.error && (data.error.message || data.error) || resp.status;
      showViTemplatesMsg('试跑失败: ' + err, false);
      return;
    }
    showViTemplatesMsg('试跑完成: ' + t.name, true);
    showView('vi');
  } catch (e) {
    outEl.textContent = e.message;
    showViTemplatesMsg('试跑失败: ' + e.message, false);
  }
}

async function deleteViTemplate(id) {
  if (!confirm('确定删除此 VI 模板？')) return;
  const resp = await fetch('/api/vi-templates/' + encodeURIComponent(id), { method: 'DELETE' });
  if (resp.ok || resp.status === 204) {
    showViTemplatesMsg('已删除', true);
    await fetchViTemplates();
  } else {
    const data = await resp.json().catch(() => ({}));
    showViTemplatesMsg('删除失败: ' + (data.error || resp.status), false);
  }
}

document.getElementById('vi-agent').addEventListener('change', (e) => {
  loadViLabviewConfig(e.target.value);
});
document.getElementById('vi-inspect-btn').addEventListener('click', inspectVi);
document.getElementById('vi-run-btn').addEventListener('click', runVi);
document.getElementById('vi-register-btn').addEventListener('click', registerViTemplate);
document.getElementById('vi-vi-path').addEventListener('blur', defaultViNameFromPath);
document.getElementById('vi-templates-agent-filter').addEventListener('change', fetchViTemplates);

syncTaskFormMode();
refreshAll();
setInterval(refreshAll, POLL_MS);

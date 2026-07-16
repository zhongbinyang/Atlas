const POLL_MS = 2000;

let agents = [];
let viTemplates = [];
let historyAgentId = null;
let historyOffset = 0;
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

function parseRoute() {
  const raw = (location.hash || '#/machines').replace(/^#\/?/, '');
  const parts = raw.split('/').filter(Boolean);
  if (parts[0] === 'agents' && parts[1]) {
    return { name: 'agent', agentId: decodeURIComponent(parts[1]) };
  }
  if (parts[0] === 'functions') return { name: 'functions' };
  return { name: 'machines' };
}

function setHash(path) {
  const next = '#/' + path.replace(/^\//, '');
  if (location.hash === next) applyRoute(parseRoute());
  else location.hash = next;
}

function showView(id) {
  ['view-machines', 'view-agent-detail', 'view-functions'].forEach((vid) => {
    const el = document.getElementById(vid);
    if (!el) return;
    const on = vid === id;
    el.hidden = !on;
    el.classList.toggle('view-active', on);
  });
  document.getElementById('nav-machines')?.classList.toggle('active', id === 'view-machines' || id === 'view-agent-detail');
  document.getElementById('nav-functions')?.classList.toggle('active', id === 'view-functions');
}

async function applyRoute(route) {
  if (route.name === 'functions') {
    showView('view-functions');
    await fetchAgents();
    await fetchViTemplates();
    return;
  }
  if (route.name === 'agent') {
    showView('view-agent-detail');
    await fetchAgents();
    renderAgentDetail(route.agentId);
    return;
  }
  showView('view-machines');
  await fetchAgents();
}

async function fetchAgents() {
  const resp = await fetch('/api/agents');
  if (!resp.ok) return;
  agents = await resp.json();
  renderAgents();
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

function statusLabel(a) {
  if (a.status === 'offline') return '离线';
  return a.busy ? '在线·忙碌' : '在线·空闲';
}

function renderAgents() {
  const grid = document.getElementById('agents-grid');
  const empty = document.getElementById('agents-empty');
  if (!grid) return;
  grid.innerHTML = '';
  if (!agents.length) {
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  for (const a of agents) {
    const kind = agentStatusKind(a);
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'agent-card' + (kind === 'offline' ? ' agent-card-offline' : '');
    card.innerHTML =
      '<div class="agent-card-title">' + escapeHtml(a.name) + '</div>' +
      '<div class="agent-card-meta mono">' + escapeHtml(a.ip + ':' + a.port) + '</div>' +
      '<div class="agent-card-status"><span class="dot ' + kind + '"></span>' +
      escapeHtml(statusLabel(a)) + '</div>' +
      '<div class="agent-card-metrics">' +
      '<span>CPU ' + escapeHtml(String(a.cpu_percent.toFixed(1))) + '%</span>' +
      '<span>内存 ' + escapeHtml(String(a.memory_percent.toFixed(1))) + '%</span>' +
      '</div>';
    card.addEventListener('click', () => setHash('agents/' + encodeURIComponent(a.id)));
    grid.appendChild(card);
  }
}

function renderAgentDetail(agentId) {
  const a = agents.find((x) => x.id === agentId);
  if (!a) {
    setHash('machines');
    return;
  }
  document.getElementById('agent-detail-name').textContent = a.name;
  const bar = document.getElementById('agent-detail-status');
  const seen = a.last_seen_at ? escapeHtml(a.last_seen_at) : '—';
  bar.innerHTML =
    '<div><span class="label">状态</span><div><span class="dot ' + agentStatusKind(a) + '"></span> ' +
    escapeHtml(statusLabel(a)) + '</div></div>' +
    '<div><span class="label">地址</span><div class="mono">' + escapeHtml(a.ip + ':' + a.port) + '</div></div>' +
    '<div><span class="label">CPU</span><div class="mono">' + escapeHtml(a.cpu_percent.toFixed(1)) + '%</div></div>' +
    '<div><span class="label">内存</span><div class="mono">' + escapeHtml(a.memory_percent.toFixed(1)) + '%</div></div>' +
    '<div><span class="label">忙碌</span><div>' + (a.busy ? '是' : '否') + '</div></div>' +
    '<div><span class="label">最近见面</span><div class="mono">' + seen + '</div></div>';
  const actions = document.getElementById('agent-detail-actions');
  actions.innerHTML =
    '<button type="button" class="btn-primary" id="detail-shot">截图</button>' +
    '<button type="button" class="btn-sm" id="detail-history">历史</button>' +
    '<button type="button" class="btn-sm" id="detail-files">文件</button>';
  document.getElementById('detail-shot').onclick = () => takeScreenshot(a.id);
  document.getElementById('detail-history').onclick = () => openHistory(a.id);
  document.getElementById('detail-files').onclick = () => openFiles(a.id);
}

document.getElementById('refresh-btn').addEventListener('click', refreshCurrent);

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

document.getElementById('nav-machines').addEventListener('click', () => setHash('machines'));
document.getElementById('nav-functions').addEventListener('click', () => setHash('functions'));
document.getElementById('agent-detail-back').addEventListener('click', () => setHash('machines'));

window.addEventListener('hashchange', () => applyRoute(parseRoute()));

async function refreshCurrent() {
  await applyRoute(parseRoute());
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

function showViTemplatesMsg(text, ok) {
  showMsg(document.getElementById('vi-templates-msg'), text, ok);
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
    tbody.innerHTML = '<tr><td colspan="6" class="empty">暂无已注册功能，请在机台端注册</td></tr>';
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
        '<button type="button" class="btn-sm btn-vi-rename">重命名</button>' +
        '<button type="button" class="btn-sm btn-vi-distribute">分发</button>' +
        '<button type="button" class="btn-sm btn-danger btn-vi-delete">删除</button>' +
      '</td>';
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

document.getElementById('vi-templates-agent-filter').addEventListener('change', fetchViTemplates);

applyRoute(parseRoute());
refreshCurrent();
setInterval(refreshCurrent, POLL_MS);

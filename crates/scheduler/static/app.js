const POLL_MS = 2000;

let agents = [];
let viTemplates = [];
let sequenceTemplates = [];
let historyAgentId = null;
let historyOffset = 0;
const HISTORY_LIMIT = 50;
let filesAgentId = null;
let filesPath = '';
let inputsPopoverEl = null;
let inputsPopoverHideTimer = null;

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const INPUTS_SUMMARY_MAX = 48;

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
  if (parts[0] === 'sequences') return { name: 'sequences' };
  return { name: 'machines' };
}

function setHash(path) {
  const next = '#/' + path.replace(/^\//, '');
  if (location.hash === next) applyRoute(parseRoute());
  else location.hash = next;
}

function showView(id) {
  ['view-machines', 'view-agent-detail', 'view-functions', 'view-sequences'].forEach((vid) => {
    const el = document.getElementById(vid);
    if (!el) return;
    const on = vid === id;
    el.hidden = !on;
    el.classList.toggle('view-active', on);
  });
  document.getElementById('nav-machines')?.classList.toggle('active', id === 'view-machines' || id === 'view-agent-detail');
  document.getElementById('nav-functions')?.classList.toggle('active', id === 'view-functions');
  document.getElementById('nav-sequences')?.classList.toggle('active', id === 'view-sequences');
}

async function applyRoute(route) {
  if (route.name === 'sequences') {
    showView('view-sequences');
    await fetchAgents();
    await fetchSequenceTemplates();
    return;
  }
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
  updateSequenceTargetAgents();
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
    card.className = 'agent-card agent-card-' + kind;
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
  bar.className = 'status-rail';
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
  const offline = a.status === 'offline';
  const dis = offline ? ' disabled' : '';
  actions.innerHTML =
    '<button type="button" class="btn-primary" id="detail-shot"' + dis + '>截图</button>' +
    '<button type="button" class="btn-sm" id="detail-history"' + dis + '>历史</button>' +
    '<button type="button" class="btn-sm" id="detail-files"' + dis + '>文件</button>';
  if (!offline) {
    document.getElementById('detail-shot').onclick = () => takeScreenshot(a.id);
    document.getElementById('detail-history').onclick = () => openHistory(a.id);
    document.getElementById('detail-files').onclick = () => openFiles(a.id);
  }
}

document.getElementById('refresh-btn').addEventListener('click', refreshCurrent);

document.getElementById('shot-close').addEventListener('click', closeShotModal);
document.getElementById('shot-history-close').addEventListener('click', closeShotHistoryModal);
document.getElementById('files-close').addEventListener('click', closeFilesModal);
document.getElementById('file-preview-close').addEventListener('click', closeFilePreviewModal);

document.querySelectorAll('.modal-backdrop').forEach(el => {
  el.addEventListener('click', () => {
    const id = el.getAttribute('data-close');
    if (id === 'shot-modal') closeShotModal();
    else if (id === 'shot-history-modal') closeShotHistoryModal();
    else if (id === 'files-modal') closeFilesModal();
    else if (id === 'file-preview-modal') closeFilePreviewModal();
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
document.getElementById('nav-sequences').addEventListener('click', () => setHash('sequences'));
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

function updateSequenceTargetAgents() {
  const sel = document.getElementById('sequence-target-agent');
  if (!sel) return;
  const prev = sel.value;
  sel.innerHTML = '<option value="">请选择机台</option>';
  for (const a of agents) {
    const opt = document.createElement('option');
    opt.value = a.id;
    opt.textContent = a.name + ' (' + a.ip + ')';
    sel.appendChild(opt);
  }
  if (prev && agents.some(a => a.id === prev)) sel.value = prev;
}

function showSequenceTemplatesMsg(text, ok) {
  showMsg(document.getElementById('sequence-templates-msg'), text, ok);
}

function templateSourceLabel(source) {
  return source === 'general' ? '通用' : 'VI';
}

function templateKindLabel(kind) {
  return kind === 'delay' ? '延迟' : (kind === 'labview' ? 'VI' : (kind || '—'));
}

function templateConfigSummary(t) {
  if (t._source === 'general') {
    if (t.kind === 'delay') {
      const inputs = Array.isArray(t.inputs) ? t.inputs : [];
      const delayInput = inputs.find((item) => item && item.name === 'delay_ms');
      if (delayInput && delayInput.value != null) {
        return 'delay_ms=' + String(delayInput.value);
      }
    }
    return '—';
  }
  const timeout = t.timeout_secs != null ? ' | 超时 ' + t.timeout_secs + 's' : '';
  return (t.vi_path || '—') + timeout;
}

async function fetchViTemplates() {
  const agentFilterEl = document.getElementById('vi-templates-agent-filter');
  const sourceFilterEl = document.getElementById('vi-templates-source-filter');
  const agentId = agentFilterEl && agentFilterEl.value ? agentFilterEl.value : '';
  const source = sourceFilterEl && sourceFilterEl.value ? sourceFilterEl.value : '';
  const query = agentId ? ('?agent_id=' + encodeURIComponent(agentId)) : '';
  const reqs = [];
  if (!source || source === 'labview') reqs.push(fetch('/api/vi-templates' + query));
  if (!source || source === 'general') reqs.push(fetch('/api/general-templates' + query));
  const responses = await Promise.all(reqs);
  const merged = [];
  for (const resp of responses) {
    if (!resp.ok) continue;
    const data = await resp.json();
    if (!Array.isArray(data)) continue;
    const inferredSource = resp.url.indexOf('/api/general-templates') >= 0 ? 'general' : 'labview';
    for (const item of data) {
      merged.push(Object.assign({}, item, { _source: inferredSource }));
    }
  }
  viTemplates = merged;
  renderViTemplates();
}

function renderViTemplates() {
  const viBody = document.getElementById('vi-templates-body');
  const generalBody = document.getElementById('general-templates-body');
  const viGroup = document.getElementById('functions-vi-group');
  const generalGroup = document.getElementById('functions-general-group');
  if (!viBody || !generalBody) return;
  viBody.innerHTML = '';
  generalBody.innerHTML = '';

  const viOnly = viTemplates.filter((t) => t._source !== 'general');
  const generalOnly = viTemplates.filter((t) => t._source === 'general');

  if (viGroup) viGroup.hidden = false;
  if (generalGroup) generalGroup.hidden = false;

  if (viOnly.length === 0) {
    viBody.innerHTML = '<tr><td colspan="8" class="empty">暂无已注册 VI 功能</td></tr>';
  }
  if (generalOnly.length === 0) {
    generalBody.innerHTML = '<tr><td colspan="8" class="empty">暂无已注册通用功能</td></tr>';
  }

  for (const t of viTemplates) {
    const row = document.createElement('tr');
    const originCol = t.origin_agent_name || '—';
    const kindLabel = templateKindLabel(t.kind);
    const sourceLabel = templateSourceLabel(t._source);
    const configCol = templateConfigSummary(t);
    row.innerHTML =
      '<td class="mono">' + escapeHtml(String(t.id)) + '</td>' +
      '<td><span class="kind-badge kind-' + escapeHtml(t._source || 'labview') + '">' + escapeHtml(sourceLabel) + '</span></td>' +
      '<td>' + escapeHtml(t.name) + '</td>' +
      '<td>' + escapeHtml(kindLabel) + '</td>' +
      '<td>' + escapeHtml(originCol) + '</td>' +
      '<td class="mono">' + escapeHtml(configCol) + '</td>' +
      '<td class="inputs-cell-host"></td>' +
      '<td class="row-actions">' +
        (t._source === 'labview'
          ? '<button type="button" class="btn-sm btn-vi-edit">修改</button>'
          : '') +
        '<button type="button" class="btn-sm btn-danger btn-template-delete">删除</button>' +
      '</td>';
    attachInputsHover(row.querySelector('.inputs-cell-host'), t.inputs);
    const editBtn = row.querySelector('.btn-vi-edit');
    if (editBtn) editBtn.addEventListener('click', () => editViTemplate(t));
    row.querySelector('.btn-template-delete').addEventListener('click', () => deleteTemplate(t));
    if (t._source === 'general') {
      generalBody.appendChild(row);
    } else {
      viBody.appendChild(row);
    }
  }

  const sourceFilterEl = document.getElementById('vi-templates-source-filter');
  const source = sourceFilterEl && sourceFilterEl.value ? sourceFilterEl.value : '';
  if (viGroup) viGroup.hidden = source === 'general';
  if (generalGroup) generalGroup.hidden = source === 'labview';
}

async function editViTemplate(t) {
  const current = t.name || '';
  const next = prompt('修改名称', current);
  if (next == null) return;
  const name = String(next).trim();
  if (!name) {
    showViTemplatesMsg('名称不能为空', false);
    return;
  }
  if (name === current) return;
  showViTemplatesMsg('修改中…', true);
  try {
    const resp = await fetch('/api/vi-templates/' + encodeURIComponent(t.id), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      showViTemplatesMsg('修改失败: ' + (data.error || resp.status), false);
      return;
    }
    showViTemplatesMsg('已修改: ' + (data.name || name), true);
    await fetchViTemplates();
  } catch (e) {
    showViTemplatesMsg('修改失败: ' + e.message, false);
  }
}

async function deleteViTemplate(t) {
  const label = t.name || t.id || '此模板';
  if (!confirm('确定删除「' + label + '」？相关序列队列中的引用也会清除。')) return;
  showViTemplatesMsg('删除中…', true);
  try {
    const resp = await fetch('/api/vi-templates/' + encodeURIComponent(t.id), {
      method: 'DELETE',
    });
    if (resp.ok || resp.status === 204) {
      showViTemplatesMsg('已删除', true);
      await fetchViTemplates();
      return;
    }
    const data = await resp.json().catch(() => ({}));
    showViTemplatesMsg('删除失败: ' + (data.error || resp.status), false);
  } catch (e) {
    showViTemplatesMsg('删除失败: ' + e.message, false);
  }
}

async function deleteGeneralTemplate(t) {
  const label = t.name || t.id || '此模板';
  if (!confirm('确定删除「' + label + '」？相关序列队列中的引用也会清除。')) return;
  showViTemplatesMsg('删除中…', true);
  try {
    const resp = await fetch('/api/general-templates/' + encodeURIComponent(t.id), {
      method: 'DELETE',
    });
    if (resp.ok || resp.status === 204) {
      showViTemplatesMsg('已删除', true);
      await fetchViTemplates();
      return;
    }
    const data = await resp.json().catch(() => ({}));
    showViTemplatesMsg('删除失败: ' + (data.error || resp.status), false);
  } catch (e) {
    showViTemplatesMsg('删除失败: ' + e.message, false);
  }
}

async function deleteTemplate(t) {
  if (t._source === 'general') return deleteGeneralTemplate(t);
  return deleteViTemplate(t);
}

async function fetchSequenceTemplates() {
  const tbody = document.getElementById('sequence-templates-body');
  if (!tbody) return;
  try {
    const resp = await fetch('/api/sequence-templates');
    const data = await resp.json();
    if (!resp.ok) {
      const err = data.error && (data.error.message || data.error) || resp.status;
      tbody.innerHTML = '<tr><td colspan="7" class="empty">加载失败: ' + escapeHtml(String(err)) + '</td></tr>';
      return;
    }
    sequenceTemplates = Array.isArray(data) ? data : [];
    renderSequenceTemplates();
  } catch (e) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty">加载失败: ' + escapeHtml(e.message) + '</td></tr>';
  }
}

function renderSequenceTemplates() {
  const tbody = document.getElementById('sequence-templates-body');
  if (!tbody) return;
  tbody.innerHTML = '';
  if (!sequenceTemplates.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty">暂无序列模板</td></tr>';
    return;
  }
  for (const t of sequenceTemplates) {
    const row = document.createElement('tr');
    row.innerHTML =
      '<td class="mono">' + escapeHtml(String(t.id)) + '</td>' +
      '<td>' + escapeHtml(t.name || '—') + '</td>' +
      '<td class="mono">' + escapeHtml(String(t.step_count || 0)) + '</td>' +
      '<td>' + escapeHtml(t.created_by_agent_name || '—') + '</td>' +
      '<td>' + escapeHtml(t.last_run_overall || '—') + '</td>' +
      '<td>' + escapeHtml(t.last_run_at || '—') + '</td>';
    const actions = document.createElement('td');
    const loadBtn = document.createElement('button');
    loadBtn.type = 'button';
    loadBtn.className = 'btn-sm';
    loadBtn.textContent = '加载到机台';
    loadBtn.addEventListener('click', () => loadSequenceTemplateToAgent(t));
    const viewBtn = document.createElement('button');
    viewBtn.type = 'button';
    viewBtn.className = 'btn-sm';
    viewBtn.textContent = '查看结果';
    viewBtn.addEventListener('click', () => openSequenceLastRun(t));
    actions.appendChild(loadBtn);
    actions.appendChild(document.createTextNode(' '));
    actions.appendChild(viewBtn);
    row.appendChild(actions);
    tbody.appendChild(row);
  }
}

async function loadSequenceTemplateToAgent(t) {
  const sel = document.getElementById('sequence-target-agent');
  const agentId = sel && sel.value ? sel.value : '';
  if (!agentId) {
    showSequenceTemplatesMsg('请先选择目标机台', false);
    return;
  }
  showSequenceTemplatesMsg('加载中…', true);
  try {
    const resp = await fetch('/api/sequence-templates/' + encodeURIComponent(t.id) + '/load-to-agent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: agentId }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      showSequenceTemplatesMsg('加载失败: ' + (data.error || resp.status), false);
      return;
    }
    showSequenceTemplatesMsg('已加载到机台: ' + (t.name || t.id), true);
  } catch (e) {
    showSequenceTemplatesMsg('加载失败: ' + e.message, false);
  }
}

function openSequenceLastRunModal(title, payload) {
  document.getElementById('sequence-last-run-title').textContent = title;
  document.getElementById('sequence-last-run-pre').textContent = JSON.stringify(payload, null, 2);
  document.getElementById('sequence-last-run-modal').hidden = false;
}

async function openSequenceLastRun(t) {
  try {
    const resp = await fetch('/api/sequence-templates/' + encodeURIComponent(t.id) + '/last-run');
    const data = await resp.json();
    if (!resp.ok) {
      showSequenceTemplatesMsg('查看结果失败: ' + ((data && data.error) || resp.status), false);
      return;
    }
    openSequenceLastRunModal('最近一次结果 · ' + (t.name || t.id), data);
  } catch (e) {
    showSequenceTemplatesMsg('查看结果失败: ' + e.message, false);
  }
}

document.getElementById('vi-templates-agent-filter').addEventListener('change', fetchViTemplates);
document.getElementById('vi-templates-source-filter').addEventListener('change', fetchViTemplates);
document.getElementById('sequence-last-run-close').addEventListener('click', function () {
  document.getElementById('sequence-last-run-modal').hidden = true;
});

applyRoute(parseRoute());
setInterval(refreshCurrent, POLL_MS);

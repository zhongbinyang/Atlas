const POLL_MS = 2000;
const dashboardRuntime = window.AtlasDashboardRuntime;

let agents = [];
let lastAgentsRefreshAt = null;
let viTemplates = [];
let sequenceTemplates = [];
let inputsPopoverEl = null;
let inputsPopoverHideTimer = null;
const toastMessages = dashboardRuntime.createToastController(document.getElementById('toast'));
const dialogController = dashboardRuntime.createDialogController({
  document,
  fallback: () => document.querySelector('.view-tabs [aria-current="page"]'),
});

const requestAgents = dashboardRuntime.createRequestDeduper(async () => {
  const resp = await fetch('/api/agents');
  if (!resp.ok) return false;
  const nextAgents = await resp.json();
  if (!Array.isArray(nextAgents)) return false;
  agents = nextAgents;
  lastAgentsRefreshAt = new Date();
  return true;
});

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
  if (location.hash === next) applyCurrentRoute();
  else location.hash = next;
}

function showToast(text, kind) {
  toastMessages.show(text, kind);
}

function showView(id) {
  ['view-machines', 'view-agent-detail', 'view-functions', 'view-sequences'].forEach((vid) => {
    const el = document.getElementById(vid);
    if (!el) return;
    const on = vid === id;
    el.hidden = !on;
    el.classList.toggle('view-active', on);
  });
  const currentNav = id === 'view-functions'
    ? 'nav-functions'
    : (id === 'view-sequences' ? 'nav-sequences' : 'nav-machines');
  ['nav-machines', 'nav-functions', 'nav-sequences'].forEach((navId) => {
    const tab = document.getElementById(navId);
    if (!tab) return;
    const current = navId === currentNav;
    tab.classList.toggle('active', current);
    if (current) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  });
}

async function applyRoute(route, isCurrent) {
  if (route.name === 'sequences') {
    showView('view-sequences');
    await fetchAgents();
    if (!isCurrent()) return;
    renderAgents();
    updateViTemplatesAgentFilter();
    await fetchSequenceTemplates(isCurrent);
    if (!isCurrent()) return;
    return;
  }
  if (route.name === 'functions') {
    showView('view-functions');
    await fetchAgents();
    if (!isCurrent()) return;
    renderAgents();
    updateViTemplatesAgentFilter();
    await fetchViTemplates(isCurrent);
    if (!isCurrent()) return;
    return;
  }
  if (route.name === 'agent') {
    showView('view-agent-detail');
    await fetchAgents();
    if (!isCurrent()) return;
    renderAgentDetail(route.agentId);
    return;
  }
  showView('view-machines');
  await fetchAgents();
  if (!isCurrent()) return;
  renderAgents();
}

const runRoute = dashboardRuntime.createLatestTaskRunner(applyRoute, {
  onError: (error) => console.error('dashboard route load failed', error),
});

function applyCurrentRoute() {
  return runRoute(parseRoute());
}

async function fetchAgents() {
  await requestAgents();
}

function statusLabel(a) {
  if (a.status === 'offline') return '离线';
  return a.busy ? '在线·忙碌' : '在线·空闲';
}
function createAgentCard() {
  const card = document.createElement('button');
  card.type = 'button';

  const title = document.createElement('div');
  title.className = 'agent-card-title';
  const meta = document.createElement('div');
  meta.className = 'agent-card-meta mono';
  const status = document.createElement('div');
  status.className = 'agent-card-status';
  const dot = document.createElement('span');
  const statusText = document.createElement('span');
  status.append(dot, statusText);
  const metrics = document.createElement('div');
  metrics.className = 'agent-card-metrics';
  const cpu = document.createElement('span');
  const memory = document.createElement('span');
  metrics.append(cpu, memory);
  card.append(title, meta, status, metrics);
  card._atlasFields = { title, meta, dot, statusText, cpu, memory };
  card.addEventListener('click', () => {
    setHash('agents/' + encodeURIComponent(card.dataset.agentId));
  });
  return card;
}

function updateAgentCard(card, agent) {
  const kind = agentStatusKind(agent);
  const fields = card._atlasFields;
  card.dataset.agentId = agent.id;
  card.className = 'agent-card agent-card-' + kind;
  fields.title.textContent = agent.name;
  fields.meta.textContent = agent.ip + ':' + agent.port;
  fields.dot.className = 'dot ' + kind;
  fields.statusText.textContent = statusLabel(agent);
  fields.cpu.textContent = 'CPU ' + agent.cpu_percent.toFixed(1) + '%';
  fields.memory.textContent = '内存 ' + agent.memory_percent.toFixed(1) + '%';
}

function renderAgents() {
  const grid = document.getElementById('agents-grid');
  const empty = document.getElementById('agents-empty');
  if (!grid) return;
  const telemetry = dashboardRuntime.getAgentTelemetry(agents, getAgentTelemetryFilters());
  renderMachineTelemetry(telemetry.summary);
  empty.hidden = telemetry.visibleAgents.length !== 0;
  empty.textContent = agents.length === 0 ? '暂无机台' : '没有匹配机台';
  dashboardRuntime.reconcileKeyedChildren(grid, telemetry.visibleAgents, {
    getKey: (agent) => agent.id,
    getNodeKey: (card) => card.dataset.agentId,
    createNode: createAgentCard,
    updateNode: updateAgentCard,
  });
}

function getAgentTelemetryFilters() {
  return {
    query: document.getElementById('agent-search').value,
    status: document.getElementById('agent-status-filter').value,
    sort: document.getElementById('agent-sort').value,
    abnormalOnly: document.getElementById('agent-abnormal-only').checked,
  };
}

function renderMachineTelemetry(summary) {
  document.getElementById('agents-total').textContent = summary.total;
  document.getElementById('agents-online').textContent = summary.online;
  document.getElementById('agents-busy').textContent = summary.busy;
  document.getElementById('agents-offline').textContent = summary.offline;
  document.getElementById('agents-last-refresh').textContent = lastAgentsRefreshAt
    ? '最近刷新 · ' + lastAgentsRefreshAt.toLocaleTimeString('zh-CN')
    : '尚未刷新';
  renderAutoRefreshStatus();
}

function renderAutoRefreshStatus() {
  const status = document.getElementById('agents-auto-refresh');
  if (status) status.textContent = document.hidden ? '自动刷新已暂停' : '自动刷新 · 2 秒';
}

function createDetailField(label, mono) {
  const field = document.createElement('div');
  const labelEl = document.createElement('span');
  labelEl.className = 'label';
  labelEl.textContent = label;
  const value = document.createElement('div');
  if (mono) value.className = 'mono';
  field.append(labelEl, value);
  return { field, value };
}

function ensureAgentDetailFields() {
  const bar = document.getElementById('agent-detail-status');
  if (bar._atlasFields) return bar._atlasFields;

  const status = createDetailField('状态', false);
  const statusDot = document.createElement('span');
  const statusText = document.createElement('span');
  status.value.append(statusDot, document.createTextNode(' '), statusText);
  const address = createDetailField('地址', true);
  const cpu = createDetailField('CPU', true);
  const memory = createDetailField('内存', true);
  const busy = createDetailField('忙碌', false);
  const lastSeen = createDetailField('最后心跳', true);
  bar.append(
    status.field,
    address.field,
    cpu.field,
    memory.field,
    busy.field,
    lastSeen.field,
  );
  bar._atlasFields = {
    statusDot,
    statusText,
    address: address.value,
    cpu: cpu.value,
    memory: memory.value,
    busy: busy.value,
    lastSeen: lastSeen.value,
  };
  return bar._atlasFields;
}

function renderAgentDetail(agentId) {
  const a = agents.find((x) => x.id === agentId);
  if (!a) {
    setHash('machines');
    return;
  }
  document.getElementById('agent-detail-name').textContent = a.name;
  const fields = ensureAgentDetailFields();
  fields.statusDot.className = 'dot ' + agentStatusKind(a);
  fields.statusText.textContent = statusLabel(a);
  fields.address.textContent = a.ip + ':' + a.port;
  fields.cpu.textContent = a.cpu_percent.toFixed(1) + '%';
  fields.memory.textContent = a.memory_percent.toFixed(1) + '%';
  fields.busy.textContent = a.busy ? '是' : '否';
  fields.lastSeen.textContent = dashboardRuntime.formatAgentHeartbeat(a.last_seen_at);
}

document.getElementById('refresh-btn').addEventListener('click', refreshCurrent);

function renderAgentsFromTelemetryControl() {
  if (parseRoute().name === 'machines') renderAgents();
}

document.getElementById('agent-search').addEventListener('input', renderAgentsFromTelemetryControl);
document.getElementById('agent-status-filter').addEventListener('change', renderAgentsFromTelemetryControl);
document.getElementById('agent-sort').addEventListener('change', renderAgentsFromTelemetryControl);
document.getElementById('agent-abnormal-only').addEventListener('change', renderAgentsFromTelemetryControl);
document.addEventListener('visibilitychange', renderAutoRefreshStatus);

document.querySelectorAll('.modal-backdrop').forEach(el => {
  el.addEventListener('click', () => {
    const id = el.getAttribute('data-close');
    if (id === 'confirm-modal') dialogController.close(document.getElementById('confirm-modal'));
  });
});

document.getElementById('nav-machines').addEventListener('click', () => setHash('machines'));
document.getElementById('nav-functions').addEventListener('click', () => setHash('functions'));
document.getElementById('nav-sequences').addEventListener('click', () => setHash('sequences'));
document.getElementById('agent-detail-back').addEventListener('click', () => setHash('machines'));

window.addEventListener('hashchange', applyCurrentRoute);

function refreshCurrent() {
  return applyCurrentRoute();
}

async function refreshDynamic() {
  const route = parseRoute();
  if (route.name !== 'machines' && route.name !== 'agent') return;

  await fetchAgents();
  const currentRoute = parseRoute();
  if (currentRoute.name !== route.name) return;
  if (route.name === 'agent' && currentRoute.agentId !== route.agentId) return;
  if (route.name === 'agent') renderAgentDetail(route.agentId);
  else renderAgents();
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

const viTemplateOperationMessages =
  dashboardRuntime.createMessageChannel(document.getElementById('vi-templates-msg'));
const viTemplateLoadMessages =
  dashboardRuntime.createMessageChannel(document.getElementById('vi-templates-load-msg'));
const sequenceTemplateOperationMessages =
  dashboardRuntime.createMessageChannel(document.getElementById('sequence-templates-msg'));
const sequenceTemplateLoadMessages =
  dashboardRuntime.createMessageChannel(document.getElementById('sequence-templates-load-msg'));

function showViTemplatesMsg(text, ok) {
  viTemplateOperationMessages.show(text, ok);
}

function showSequenceTemplatesMsg(text, ok) {
  sequenceTemplateOperationMessages.show(text, ok);
}

function loadErrorMessage(error) {
  return error && error.message ? error.message : String(error);
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

async function requestViTemplates() {
  const agentFilterEl = document.getElementById('vi-templates-agent-filter');
  const sourceFilterEl = document.getElementById('vi-templates-source-filter');
  const agentId = agentFilterEl && agentFilterEl.value ? agentFilterEl.value : '';
  const source = sourceFilterEl && sourceFilterEl.value ? sourceFilterEl.value : '';
  const query = agentId ? ('?agent_id=' + encodeURIComponent(agentId)) : '';
  const requests = [];
  if (!source || source === 'labview') {
    requests.push({ source: 'labview', response: fetch('/api/vi-templates' + query) });
  }
  if (!source || source === 'general') {
    requests.push({ source: 'general', response: fetch('/api/general-templates' + query) });
  }
  const groups = await Promise.all(requests.map(async (request) => {
    const resp = await request.response;
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const data = await resp.json();
    if (!Array.isArray(data)) throw new Error('响应格式无效');
    return data.map((item) => Object.assign({}, item, { _source: request.source }));
  }));
  return groups.flat();
}

const loadViTemplates = dashboardRuntime.createLatestResourceLoader({
  load: requestViTemplates,
  commit: (templates) => {
    viTemplates = templates;
    renderViTemplates();
    viTemplateLoadMessages.clearError();
  },
  onError: (error) => viTemplateLoadMessages.show('加载失败: ' + loadErrorMessage(error), false),
});

function isFunctionsRoute() {
  return parseRoute().name === 'functions';
}

function fetchViTemplates(shouldCommit = isFunctionsRoute) {
  return loadViTemplates(shouldCommit);
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
        '<button type="button" class="btn-sm btn-danger btn-template-delete">删除</button>' +
      '</td>';
    attachInputsHover(row.querySelector('.inputs-cell-host'), t.inputs);
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

function requestDeleteConfirmation(label, detail) {
  document.getElementById('confirm-title').textContent = '确认删除';
  document.getElementById('confirm-message').textContent =
    '确定删除「' + label + '」？' + detail;
  document.getElementById('confirm-confirm').textContent = '删除';
  return dialogController.confirm(document.getElementById('confirm-modal'));
}

async function deleteViTemplate(t) {
  const label = t.name || t.id || '此模板';
  if (!(await requestDeleteConfirmation(label, '相关序列队列中的引用也会清除。'))) return;
  showViTemplatesMsg('删除中…', true);
  try {
    const resp = await fetch('/api/vi-templates/' + encodeURIComponent(t.id), {
      method: 'DELETE',
    });
    if (resp.ok || resp.status === 204) {
      showViTemplatesMsg('已删除', true);
      showToast('功能模板已删除', 'success');
      await fetchViTemplates();
      return;
    }
    const data = await resp.json().catch(() => ({}));
    showViTemplatesMsg('删除失败: ' + (data.error || resp.status), false);
    showToast('删除功能模板失败: ' + (data.error || resp.status), 'error');
  } catch (e) {
    showViTemplatesMsg('删除失败: ' + e.message, false);
    showToast('删除功能模板失败: ' + e.message, 'error');
  }
}

async function deleteGeneralTemplate(t) {
  const label = t.name || t.id || '此模板';
  if (!(await requestDeleteConfirmation(label, '相关序列队列中的引用也会清除。'))) return;
  showViTemplatesMsg('删除中…', true);
  try {
    const resp = await fetch('/api/general-templates/' + encodeURIComponent(t.id), {
      method: 'DELETE',
    });
    if (resp.ok || resp.status === 204) {
      showViTemplatesMsg('已删除', true);
      showToast('功能模板已删除', 'success');
      await fetchViTemplates();
      return;
    }
    const data = await resp.json().catch(() => ({}));
    showViTemplatesMsg('删除失败: ' + (data.error || resp.status), false);
    showToast('删除功能模板失败: ' + (data.error || resp.status), 'error');
  } catch (e) {
    showViTemplatesMsg('删除失败: ' + e.message, false);
    showToast('删除功能模板失败: ' + e.message, 'error');
  }
}

async function deleteTemplate(t) {
  if (t._source === 'general') return deleteGeneralTemplate(t);
  return deleteViTemplate(t);
}

async function requestSequenceTemplates() {
  const resp = await fetch('/api/sequence-templates');
  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  const data = await resp.json();
  if (!Array.isArray(data)) throw new Error('响应格式无效');
  return data;
}

const loadSequenceTemplates = dashboardRuntime.createLatestResourceLoader({
  load: requestSequenceTemplates,
  commit: (templates) => {
    sequenceTemplates = templates;
    renderSequenceTemplates();
    sequenceTemplateLoadMessages.clearError();
  },
  onError: (error) => sequenceTemplateLoadMessages.show('加载失败: ' + loadErrorMessage(error), false),
});

function isSequencesRoute() {
  return parseRoute().name === 'sequences';
}

function fetchSequenceTemplates(shouldCommit = isSequencesRoute) {
  return loadSequenceTemplates(shouldCommit);
}

function renderSequenceTemplates() {
  const tbody = document.getElementById('sequence-templates-body');
  if (!tbody) return;
  tbody.innerHTML = '';
  if (!sequenceTemplates.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty">暂无序列模板</td></tr>';
    return;
  }
  for (const t of sequenceTemplates) {
    const row = document.createElement('tr');
    row.innerHTML =
      '<td class="mono">' + escapeHtml(String(t.id)) + '</td>' +
      '<td>' + escapeHtml(t.name || '—') + '</td>' +
      '<td class="mono">' + escapeHtml(String(t.step_count || 0)) + '</td>' +
      '<td>' + escapeHtml(t.created_by_agent_name || '—') + '</td>';
    const actions = document.createElement('td');
    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'btn-sm';
    delBtn.textContent = '删除';
    delBtn.addEventListener('click', () => deleteSequenceTemplate(t));
    actions.appendChild(delBtn);
    row.appendChild(actions);
    tbody.appendChild(row);
  }
}

async function deleteSequenceTemplate(t) {
  const label = t.name || t.id || '此模板';
  if (!(await requestDeleteConfirmation('序列模板「' + label + '」', ''))) return;
  showSequenceTemplatesMsg('删除中…', true);
  try {
    const resp = await fetch('/api/sequence-templates/' + encodeURIComponent(t.id), {
      method: 'DELETE',
    });
    if (resp.ok || resp.status === 204) {
      showSequenceTemplatesMsg('已删除', true);
      showToast('序列模板已删除', 'success');
      await fetchSequenceTemplates();
      return;
    }
    const data = await resp.json().catch(() => ({}));
    showSequenceTemplatesMsg('删除失败: ' + (data.error || resp.status), false);
    showToast('删除序列模板失败: ' + (data.error || resp.status), 'error');
  } catch (e) {
    showSequenceTemplatesMsg('删除失败: ' + e.message, false);
    showToast('删除序列模板失败: ' + e.message, 'error');
  }
}

const refreshViTemplatesFromFilter = dashboardRuntime.createSafeEventHandler(
  () => fetchViTemplates(),
  { onError: (error) => console.error('template filter refresh failed', error) },
);
document.getElementById('vi-templates-agent-filter').addEventListener('change', refreshViTemplatesFromFilter);
document.getElementById('vi-templates-source-filter').addEventListener('change', refreshViTemplatesFromFilter);

const refreshController = dashboardRuntime.createRefreshController({
  delayMs: POLL_MS,
  document,
  refresh: refreshDynamic,
  onError: (error) => console.error('automatic refresh failed', error),
});

dashboardRuntime.startDashboard(applyCurrentRoute, refreshController);

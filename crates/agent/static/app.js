const POLL_MS = 2000;
let lastAgentStatus = null;
let agentSettings = { units: [], variables: [] };
let varPickerEl = null;
let varPickerTarget = null;
let varPickerIndex = 0;
let varPickerNames = [];

const DEFAULT_UNIT_DESCRIPTIONS = {
  dBm: '光功率，相对 1 mW',
  dB: '相对量（消光比、回损、增益等）',
  nm: '波长',
  '°C': '温度（壳体/环境）',
  V: '电压（供电/监测）',
  mA: '电流（偏置、功耗）',
  mW: '光功率（毫瓦）',
  'µW': '光功率（微瓦）',
  Gbps: '线速率 / 比特率',
  ps: '时间或抖动（皮秒）',
  UI: 'Unit Interval（归一化抖动）',
  '%': '百分比',
};

const DEFAULT_VAR_DESCRIPTIONS = {
  Hostname: '本机主机名；打开配置或展开时按本机刷新',
  IP: '本机 IP；打开配置或展开时按本机刷新',
};

function normalizeSettingsUnit(u) {
  if (typeof u === 'string') {
    return {
      symbol: u,
      description: DEFAULT_UNIT_DESCRIPTIONS[u] || '',
    };
  }
  const symbol = String((u && u.symbol) || '').trim();
  let description = u && u.description != null ? String(u.description) : '';
  if (!description && DEFAULT_UNIT_DESCRIPTIONS[symbol]) {
    description = DEFAULT_UNIT_DESCRIPTIONS[symbol];
  }
  return { symbol: symbol, description: description };
}

function normalizeSettingsVar(v) {
  const name = String((v && v.name) || '');
  let description = v && v.description != null ? String(v.description) : '';
  if (!description && DEFAULT_VAR_DESCRIPTIONS[name]) {
    description = DEFAULT_VAR_DESCRIPTIONS[name];
  }
  return {
    name: name,
    value: v && v.value == null ? '' : String(v.value),
    description: description,
  };
}

function unitSymbols(list) {
  return (list || []).map(function (u) {
    return typeof u === 'string' ? u : (u && u.symbol) || '';
  }).filter(Boolean);
}

async function fetchStatus() {
  const resp = await fetch('/api/status');
  if (!resp.ok) return;
  const data = await resp.json();
  lastAgentStatus = data;
  document.getElementById('hostname').textContent = data.hostname;
  document.getElementById('ip').textContent = data.ip;
  document.getElementById('metric-cpu').textContent = data.cpu_percent.toFixed(1) + '%';
  document.getElementById('metric-memory').textContent = data.memory_percent.toFixed(1) + '%';
  const busyEl = document.getElementById('metric-busy');
  const busyText = data.busy
    ? ('● 执行中' + (data.busy_reason === 'sequence_paused' ? '（断点）' : ''))
    : '● 空闲';
  const busyClass = data.busy ? 'is-busy' : 'is-idle';
  busyEl.textContent = busyText;
  busyEl.className = busyClass;
  const summaryBusy = document.getElementById('machine-info-busy');
  if (summaryBusy) {
    summaryBusy.textContent = busyText;
    summaryBusy.className = 'machine-info-busy ' + busyClass;
  }
  document.getElementById('uptime').textContent = formatUptime(data.uptime_secs);
  updateMachineBusyActions(data);
  syncSequenceBusyFromStatus(data);
}

function updateMachineBusyActions(data) {
  const box = document.getElementById('machine-busy-actions');
  const detail = document.getElementById('machine-busy-detail');
  const btn = document.getElementById('force-release-btn');
  if (!box || !detail || !btn) return;
  if (!data.busy && !data.can_force_release) {
    box.hidden = true;
    detail.textContent = '';
    return;
  }
  if (!data.busy) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  detail.textContent = data.busy_message || '机台忙碌';
  btn.hidden = !data.can_force_release;
}

function syncSequenceBusyFromStatus(data) {
  const sequencePage = document.getElementById('page-sequence');
  const onSeqPage = sequencePage && !sequencePage.hidden;
  if (data.can_continue) {
    if (!seqPaused) {
      seqPaused = true;
      seqRunning = false;
      setSeqControlsDisabled(false);
      if (onSeqPage) {
        showSeqMsg(data.busy_message || '序列在断点处暂停，可继续或中止', true);
      }
    }
    return;
  }
  if (!data.busy && seqPaused) {
    seqPaused = false;
    seqRunning = false;
    setSeqControlsDisabled(false);
    return;
  }
  if (data.busy && data.busy_reason === 'sequence' && !seqPaused && !seqRunning && onSeqPage) {
    seqRunning = true;
    setSeqControlsDisabled(true);
    showSeqMsg(data.busy_message || '序列正在执行中…', true);
  }
}

async function forceReleaseSlot() {
  if (!window.confirm('确认强制释放机台占用？若仍有 LabVIEW/请求在跑，可能留下未结束的进程。')) {
    return;
  }
  try {
    const resp = await fetch('/api/slot/force-release', { method: 'POST' });
    const data = await resp.json();
    if (!resp.ok) {
      const err = data.error && (data.error.message || data.error) || resp.status;
      showSeqMsg('强制释放失败: ' + err, false);
      return;
    }
    seqPaused = false;
    seqRunning = false;
    setSeqControlsDisabled(false);
    showSeqMsg(data.message || '已强制释放占用', true);
    await fetchStatus();
  } catch (e) {
    showSeqMsg('强制释放失败: ' + e.message, false);
  }
}

function formatBusyConflictMessage(data) {
  if (data && data.busy_message) return data.busy_message;
  if (data && data.error) return String(data.error.message || data.error);
  return 'agent is busy';
}

let settingsDirty = false;
let settingsBaseline = '';
let settingsUndo = null;
let settingsUndoTimer = null;
let pendingDeviceCfgPreview = null;

function isSystemVarName(name) {
  return name === 'Hostname' || name === 'IP';
}

var DEVICE_CFG_ADDRESS_KEYS = {
  IP_Add: true,
  Com_Add: true,
  Intru_Com_Add: true,
  COM: true,
  EVB_SN: true,
  Port: true,
};

function sanitizeDeviceCfgIdent(raw) {
  var s = String(raw || '')
    .replace(/[^A-Za-z0-9_]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!s) return '';
  if (!/^[A-Za-z_]/.test(s)) s = 'V_' + s;
  if (s.length > 64) s = s.slice(0, 64).replace(/_+$/g, '');
  return s;
}

function normalizeDeviceCfgValue(raw) {
  var s = String(raw == null ? '' : raw).trim();
  if (
    (s.charAt(0) === '"' && s.charAt(s.length - 1) === '"') ||
    (s.charAt(0) === "'" && s.charAt(s.length - 1) === "'")
  ) {
    s = s.slice(1, -1).trim();
  }
  // Legacy quirk: trailing extra quote e.g. "192.168.6.13""
  if (s.charAt(s.length - 1) === '"' && s.indexOf('"') === s.length - 1) {
    s = s.slice(0, -1).trim();
  }
  return s;
}

function parseDeviceCfgIni(text) {
  var entries = [];
  var section = '';
  var lines = String(text || '').split(/\r?\n/);
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (!line) continue;
    if (line.charAt(0) === '#' || line.charAt(0) === ';' || line.indexOf('//') === 0) continue;
    if (line.indexOf('/*') === 0) continue;
    var sec = line.match(/^\[([^\]]+)\]$/);
    if (sec) {
      section = sec[1].trim();
      continue;
    }
    var eq = line.indexOf('=');
    if (eq < 0) continue;
    var key = line.slice(0, eq).trim();
    var value = line.slice(eq + 1).trim();
    if (!key || key.charAt(0) === '#') continue;
    entries.push({ section: section, key: key, value: value });
  }
  return entries;
}

function buildDeviceCfgImportPreview(text, existingVariables) {
  var existing = {};
  (existingVariables || []).forEach(function (v) {
    if (v && v.name) existing[v.name] = true;
  });
  var usedNames = {};
  var rows = [];
  var skipped = 0;
  var added = 0;
  var updated = 0;
  var entries = parseDeviceCfgIni(text);
  for (var i = 0; i < entries.length; i++) {
    var e = entries[i];
    if (!DEVICE_CFG_ADDRESS_KEYS[e.key]) {
      skipped += 1;
      continue;
    }
    var value = normalizeDeviceCfgValue(e.value);
    if (!value) {
      skipped += 1;
      continue;
    }
    var base = sanitizeDeviceCfgIdent(e.section + '_' + e.key);
    if (!base || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(base)) {
      skipped += 1;
      continue;
    }
    var name = base;
    var n = 2;
    while (usedNames[name] && usedNames[name] !== e.section + '\0' + e.key) {
      var suffix = '_' + n;
      name = (base.slice(0, Math.max(1, 64 - suffix.length)) + suffix).replace(/_+$/g, '');
      n += 1;
    }
    usedNames[name] = e.section + '\0' + e.key;
    var status = existing[name] ? 'update' : 'add';
    if (status === 'add') added += 1;
    else updated += 1;
    rows.push({
      name: name,
      value: value,
      description: '从 Device_CFG [' + e.section + '] ' + e.key + ' 导入',
      section: e.section,
      key: e.key,
      status: status,
    });
  }
  return {
    rows: rows,
    summary: { added: added, updated: updated, skipped: skipped },
  };
}

function mergeDeviceCfgPreviewIntoVariables(existingVariables, previewRows) {
  var byName = {};
  var out = (existingVariables || []).map(function (v) {
    var copy = {
      name: v.name || '',
      value: v.value == null ? '' : String(v.value),
      description: v.description || '',
    };
    byName[copy.name] = copy;
    return copy;
  });
  (previewRows || []).forEach(function (row) {
    if (!row || (row.status !== 'add' && row.status !== 'update')) return;
    if (byName[row.name]) {
      byName[row.name].value = row.value;
      byName[row.name].description = row.description || byName[row.name].description;
    } else {
      var nv = {
        name: row.name,
        value: row.value,
        description: row.description || '',
      };
      byName[row.name] = nv;
      out.push(nv);
    }
  });
  return out;
}

function statusLabelDeviceCfg(status) {
  if (status === 'add') return '新增';
  if (status === 'update') return '覆盖';
  return '跳过';
}

function closeDeviceCfgImportModal() {
  const modal = document.getElementById('device-cfg-import-modal');
  if (modal) modal.hidden = true;
  pendingDeviceCfgPreview = null;
}

function openDeviceCfgImportPreview(text) {
  const current = collectSettingsFromDom();
  const preview = buildDeviceCfgImportPreview(text, current.variables);
  pendingDeviceCfgPreview = preview;
  const summary = document.getElementById('device-cfg-import-summary');
  if (summary) {
    summary.textContent =
      '将新增' +
      preview.summary.added +
      ' 个、覆盖' +
      preview.summary.updated +
      ' 个；另跳过' +
      preview.summary.skipped +
      ' 行（非地址键或空值）。合并后请点保存。';
  }
  const tbody = document.getElementById('device-cfg-import-body');
  if (tbody) {
    tbody.innerHTML = '';
    if (!preview.rows.length) {
      tbody.innerHTML = '<tr><td colspan="4" class="empty">没有可导入的地址变量</td></tr>';
    } else {
      preview.rows.forEach(function (row) {
        const tr = document.createElement('tr');
        tr.innerHTML =
          '<td>' +
          statusLabelDeviceCfg(row.status) +
          '</td>' +
          '<td class="mono">' +
          escapeHtml(row.name) +
          '</td>' +
          '<td class="mono">' +
          escapeHtml(row.value) +
          '</td>' +
          '<td class="mono">' +
          escapeHtml('[' + row.section + '] ' + row.key) +
          '</td>';
        tbody.appendChild(tr);
      });
    }
  }
  const applyBtn = document.getElementById('device-cfg-import-apply-btn');
  if (applyBtn) applyBtn.disabled = !preview.rows.length;
  const modal = document.getElementById('device-cfg-import-modal');
  if (modal) modal.hidden = false;
}

function applyDeviceCfgImportPreview() {
  if (!pendingDeviceCfgPreview || !pendingDeviceCfgPreview.rows.length) {
    closeDeviceCfgImportModal();
    return;
  }
  const current = collectSettingsFromDom();
  const mergedVars = mergeDeviceCfgPreviewIntoVariables(
    current.variables,
    pendingDeviceCfgPreview.rows
  );
  agentSettings = {
    units: current.units,
    variables: mergedVars,
  };
  renderSettingsUnits();
  renderSettingsVars();
  markSettingsDirty();
  const n =
    pendingDeviceCfgPreview.summary.added + pendingDeviceCfgPreview.summary.updated;
  closeDeviceCfgImportModal();
  showSettingsMsg('已合并' + n + ' 个变量到编辑区，请保存', true);
}

function cloneSettingsData(data) {
  return {
    units: (data.units || []).map(function (u) {
      return { symbol: u.symbol || '', description: u.description || '' };
    }),
    variables: (data.variables || []).map(function (v) {
      return {
        name: v.name || '',
        value: v.value == null ? '' : String(v.value),
        description: v.description || '',
      };
    }),
  };
}

function settingsSnapshotKey(data) {
  return JSON.stringify(cloneSettingsData(data));
}

function setSettingsSyncStatus(kind, text) {
  const el = document.getElementById('settings-sync-status');
  if (!el) return;
  el.className = 'settings-sync-status ' + kind;
  el.textContent = text;
}

function markSettingsDirty() {
  settingsDirty = true;
  setSettingsSyncStatus('is-dirty', '未保存');
}

function markSettingsSynced(extra) {
  settingsDirty = false;
  settingsBaseline = settingsSnapshotKey(agentSettings);
  setSettingsSyncStatus('is-synced', extra || '已同步');
}

function updateSettingsCounts() {
  const unitsCount = document.getElementById('settings-units-count');
  const varsCount = document.getElementById('settings-vars-count');
  if (unitsCount) unitsCount.textContent = String((agentSettings.units || []).length);
  if (varsCount) varsCount.textContent = String((agentSettings.variables || []).length);
}

function showSettingsMsg(text, ok, undoAction) {
  const msg = document.getElementById('settings-msg');
  if (!msg) return;
  msg.hidden = false;
  msg.className = 'msg ' + (ok ? 'ok' : 'err');
  msg.textContent = '';
  msg.appendChild(document.createTextNode(text));
  if (undoAction) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'settings-msg-undo';
    btn.textContent = '撤销';
    btn.addEventListener('click', function () {
      undoAction();
    });
    msg.appendChild(btn);
  }
}

function clearSettingsUndo() {
  settingsUndo = null;
  if (settingsUndoTimer) {
    clearTimeout(settingsUndoTimer);
    settingsUndoTimer = null;
  }
}

function queueSettingsUndo(label, applyUndo) {
  clearSettingsUndo();
  settingsUndo = applyUndo;
  showSettingsMsg(label, true, function () {
    if (settingsUndo) settingsUndo();
    clearSettingsUndo();
    showSettingsMsg('已撤销', true);
  });
  settingsUndoTimer = setTimeout(function () {
    clearSettingsUndo();
  }, 8000);
}

async function fetchAgentSettings() {
  const resp = await fetch('/api/settings');
  const data = await resp.json().catch(function () { return {}; });
  if (!resp.ok) {
    const err = data.error && (data.error.message || data.error) || resp.status;
    throw new Error(String(err));
  }
  agentSettings = {
    units: Array.isArray(data.units) ? data.units.map(normalizeSettingsUnit).filter(function (u) { return u.symbol; }) : [],
    variables: Array.isArray(data.variables) ? data.variables.map(normalizeSettingsVar) : [],
  };
  return agentSettings;
}

function bindSettingsDirty(el) {
  if (!el) return;
  el.addEventListener('input', markSettingsDirty);
  el.addEventListener('change', markSettingsDirty);
}

function renderSettingsUnits() {
  const tbody = document.getElementById('settings-units-body');
  if (!tbody) return;
  tbody.innerHTML = '';
  updateSettingsCounts();
  if (!agentSettings.units.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 3;
    td.className = 'settings-empty';
    td.innerHTML = '<div>暂无单位</div>';
    const actions = document.createElement('div');
    actions.className = 'settings-empty-actions';
    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'btn-sm';
    addBtn.textContent = '添加单位';
    addBtn.addEventListener('click', addSettingsUnit);
    const restoreBtn = document.createElement('button');
    restoreBtn.type = 'button';
    restoreBtn.className = 'btn-sm';
    restoreBtn.textContent = '恢复光模块默认';
    restoreBtn.addEventListener('click', restoreDefaultUnits);
    actions.appendChild(addBtn);
    actions.appendChild(restoreBtn);
    td.appendChild(actions);
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }
  agentSettings.units.forEach(function (unit, idx) {
    const tr = document.createElement('tr');
    const symTd = document.createElement('td');
    const symInput = document.createElement('input');
    symInput.type = 'text';
    symInput.className = 'mono settings-unit-symbol';
    symInput.maxLength = 32;
    symInput.value = unit.symbol || '';
    symInput.setAttribute('aria-label', '单位');
    symInput.addEventListener('change', function () {
      agentSettings.units[idx].symbol = symInput.value.trim();
    });
    bindSettingsDirty(symInput);
    symTd.appendChild(symInput);

    const descTd = document.createElement('td');
    const descInput = document.createElement('input');
    descInput.type = 'text';
    descInput.className = 'settings-unit-desc';
    descInput.maxLength = 200;
    descInput.placeholder = '说明';
    descInput.value = unit.description || '';
    descInput.title = unit.description || '';
    descInput.setAttribute('aria-label', '单位说明');
    descInput.addEventListener('change', function () {
      agentSettings.units[idx].description = descInput.value;
      descInput.title = descInput.value;
    });
    bindSettingsDirty(descInput);
    descTd.appendChild(descInput);

    const rmTd = document.createElement('td');
    rmTd.className = 'settings-col-actions';
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'btn-sm';
    rm.textContent = '删';
    rm.addEventListener('click', function () {
      deleteSettingsUnit(idx);
    });
    rmTd.appendChild(rm);

    tr.appendChild(symTd);
    tr.appendChild(descTd);
    tr.appendChild(rmTd);
    tbody.appendChild(tr);
  });
}

function appendSettingsSectionRow(tbody, label, colspan) {
  const tr = document.createElement('tr');
  tr.className = 'settings-section-row';
  const td = document.createElement('td');
  td.colSpan = colspan;
  td.textContent = label;
  tr.appendChild(td);
  tbody.appendChild(tr);
}

function renderSettingsVars() {
  const tbody = document.getElementById('settings-vars-body');
  if (!tbody) return;
  tbody.innerHTML = '';
  updateSettingsCounts();
  if (!agentSettings.variables.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 4;
    td.className = 'settings-empty';
    td.innerHTML = '<div>暂无变量</div>';
    const actions = document.createElement('div');
    actions.className = 'settings-empty-actions';
    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'btn-sm';
    addBtn.textContent = '添加变量';
    addBtn.addEventListener('click', addSettingsVar);
    const seedBtn = document.createElement('button');
    seedBtn.type = 'button';
    seedBtn.className = 'btn-sm';
    seedBtn.textContent = '添加 Hostname / IP';
    seedBtn.addEventListener('click', seedSystemVariables);
    actions.appendChild(addBtn);
    actions.appendChild(seedBtn);
    td.appendChild(actions);
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }

  const systemIdx = [];
  const customIdx = [];
  agentSettings.variables.forEach(function (v, idx) {
    if (isSystemVarName(v.name)) systemIdx.push(idx);
    else customIdx.push(idx);
  });

  function renderVarRow(idx) {
    const v = agentSettings.variables[idx];
    const system = isSystemVarName(v.name);
    const tr = document.createElement('tr');
    if (system) tr.className = 'settings-row-system';

    const nameTd = document.createElement('td');
    if (system) {
      const wrap = document.createElement('span');
      wrap.className = 'mono settings-var-name';
      wrap.textContent = v.name || '';
      const tag = document.createElement('span');
      tag.className = 'settings-system-tag';
      tag.textContent = '系统';
      nameTd.appendChild(wrap);
      nameTd.appendChild(tag);
      const hidden = document.createElement('input');
      hidden.type = 'hidden';
      hidden.className = 'settings-var-name';
      hidden.value = v.name || '';
      nameTd.appendChild(hidden);
    } else {
      const nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.className = 'mono settings-var-name';
      nameInput.value = v.name || '';
      nameInput.setAttribute('aria-label', '变量名');
      nameInput.addEventListener('change', function () {
        agentSettings.variables[idx].name = nameInput.value.trim();
      });
      bindSettingsDirty(nameInput);
      nameTd.appendChild(nameInput);
    }

    const valTd = document.createElement('td');
    const valInput = document.createElement('input');
    valInput.type = 'text';
    valInput.className = 'mono settings-var-value';
    valInput.value = v.value == null ? '' : String(v.value);
    valInput.setAttribute('aria-label', '变量值');
    if (system) {
      valInput.readOnly = true;
      valInput.title = '系统变量，随本机自动刷新';
    } else {
      valInput.addEventListener('change', function () {
        agentSettings.variables[idx].value = valInput.value;
      });
      bindSettingsDirty(valInput);
    }
    valTd.appendChild(valInput);

    const descTd = document.createElement('td');
    const descInput = document.createElement('input');
    descInput.type = 'text';
    descInput.className = 'settings-var-desc';
    descInput.maxLength = 200;
    descInput.placeholder = '说明';
    descInput.value = v.description || '';
    descInput.title = v.description || '';
    descInput.setAttribute('aria-label', '变量说明');
    descInput.addEventListener('change', function () {
      agentSettings.variables[idx].description = descInput.value;
      descInput.title = descInput.value;
    });
    bindSettingsDirty(descInput);
    descTd.appendChild(descInput);

    const rmTd = document.createElement('td');
    rmTd.className = 'settings-col-actions';
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'btn-sm';
    rm.textContent = '删';
    rm.addEventListener('click', function () {
      deleteSettingsVar(idx);
    });
    rmTd.appendChild(rm);

    tr.appendChild(nameTd);
    tr.appendChild(valTd);
    tr.appendChild(descTd);
    tr.appendChild(rmTd);
    tbody.appendChild(tr);
  }

  if (systemIdx.length) {
    appendSettingsSectionRow(tbody, '系统', 4);
    systemIdx.forEach(renderVarRow);
  }
  if (customIdx.length) {
    appendSettingsSectionRow(tbody, '自定义', 4);
    customIdx.forEach(renderVarRow);
  } else if (systemIdx.length) {
    appendSettingsSectionRow(tbody, '自定义', 4);
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 4;
    td.className = 'settings-empty';
    td.textContent = '尚无自定义变量，可点右上角「+ 添加」';
    tr.appendChild(td);
    tbody.appendChild(tr);
  }
}

function deleteSettingsUnit(idx) {
  const removed = agentSettings.units[idx];
  if (!removed) return;
  if (!window.confirm('删除单位「' + (removed.symbol || '') + '」？')) return;
  agentSettings.units.splice(idx, 1);
  markSettingsDirty();
  renderSettingsUnits();
  queueSettingsUndo('已删除单位 ' + (removed.symbol || ''), function () {
    agentSettings.units.splice(idx, 0, removed);
    markSettingsDirty();
    renderSettingsUnits();
  });
}

function deleteSettingsVar(idx) {
  const removed = agentSettings.variables[idx];
  if (!removed) return;
  const label = removed.name || '（未命名）';
  const tip = isSystemVarName(removed.name)
    ? '删除系统变量「' + label + '」？之后可用「添加 Hostname / IP」恢复。'
    : '删除变量「' + label + '」？';
  if (!window.confirm(tip)) return;
  agentSettings.variables.splice(idx, 1);
  markSettingsDirty();
  renderSettingsVars();
  queueSettingsUndo('已删除变量 ' + label, function () {
    agentSettings.variables.splice(idx, 0, removed);
    markSettingsDirty();
    renderSettingsVars();
  });
}

function defaultOpticalUnits() {
  return Object.keys(DEFAULT_UNIT_DESCRIPTIONS).map(function (symbol) {
    return { symbol: symbol, description: DEFAULT_UNIT_DESCRIPTIONS[symbol] };
  });
}

function restoreDefaultUnits() {
  if (!window.confirm('用光模块常用单位覆盖当前单位列表？自定义单位将被替换。')) return;
  const prev = cloneSettingsData(agentSettings).units;
  agentSettings.units = defaultOpticalUnits();
  markSettingsDirty();
  renderSettingsUnits();
  queueSettingsUndo('已恢复默认单位', function () {
    agentSettings.units = prev;
    markSettingsDirty();
    renderSettingsUnits();
  });
}

function seedSystemVariables() {
  const host = (lastAgentStatus && lastAgentStatus.hostname) || '';
  const ip = (lastAgentStatus && lastAgentStatus.ip) || '';
  ['Hostname', 'IP'].forEach(function (name) {
    const exists = agentSettings.variables.some(function (v) { return v.name === name; });
    if (exists) return;
    agentSettings.variables.unshift({
      name: name,
      value: name === 'Hostname' ? host : ip,
      description: DEFAULT_VAR_DESCRIPTIONS[name] || '',
    });
  });
  markSettingsDirty();
  renderSettingsVars();
  showSettingsMsg('已添加系统变量 Hostname / IP', true);
}

async function loadAgentSettingsPage() {
  try {
    await fetchAgentSettings();
    renderSettingsUnits();
    renderSettingsVars();
    markSettingsSynced('已同步');
    showSettingsMsg(
      '已加载：' + agentSettings.units.length + ' 个单位，' + agentSettings.variables.length + ' 个变量',
      true
    );
  } catch (e) {
    agentSettings = { units: [], variables: [] };
    renderSettingsUnits();
    renderSettingsVars();
    settingsDirty = false;
    setSettingsSyncStatus('is-error', '加载失败');
    showSettingsMsg('加载失败: ' + e.message, false);
  }
}

function addSettingsUnit() {
  agentSettings.units.push({ symbol: '', description: '' });
  markSettingsDirty();
  renderSettingsUnits();
  const inputs = document.querySelectorAll('#settings-units-body .settings-unit-symbol');
  if (inputs.length) {
    const last = inputs[inputs.length - 1];
    last.focus();
    const scroll = document.querySelector('#settings-units-card .settings-table-scroll');
    if (scroll) scroll.scrollTop = scroll.scrollHeight;
  }
}

function addSettingsVar() {
  agentSettings.variables.push({ name: '', value: '', description: '' });
  markSettingsDirty();
  renderSettingsVars();
  const names = document.querySelectorAll('#settings-vars-body input.settings-var-name:not([type="hidden"])');
  if (names.length) {
    names[names.length - 1].focus();
    const scroll = document.querySelector('#settings-vars-card .settings-table-scroll');
    if (scroll) scroll.scrollTop = scroll.scrollHeight;
  }
}

function collectSettingsFromDom() {
  const units = [];
  document.querySelectorAll('#settings-units-body tr').forEach(function (tr) {
    const symEl = tr.querySelector('.settings-unit-symbol');
    const descEl = tr.querySelector('.settings-unit-desc');
    if (!symEl) return;
    const symbol = symEl.value.trim();
    if (!symbol) return;
    units.push({
      symbol: symbol,
      description: descEl ? descEl.value.trim() : '',
    });
  });
  const variables = [];
  document.querySelectorAll('#settings-vars-body tr').forEach(function (tr) {
    if (tr.classList.contains('settings-section-row')) return;
    const nameEl = tr.querySelector('.settings-var-name');
    const valEl = tr.querySelector('.settings-var-value');
    const descEl = tr.querySelector('.settings-var-desc');
    if (!nameEl) return;
    const name = nameEl.value.trim();
    if (!name) return;
    variables.push({
      name: name,
      value: valEl ? valEl.value : '',
      description: descEl ? descEl.value.trim() : '',
    });
  });
  return { units: units, variables: variables };
}

function validateSettingsPayload(payload) {
  const nameRe = /^[A-Za-z_][A-Za-z0-9_]*$/;
  const seenUnits = {};
  for (let i = 0; i < payload.units.length; i++) {
    const symbol = payload.units[i].symbol;
    if (symbol.length > 32) return '单位过长: ' + symbol;
    if ((payload.units[i].description || '').length > 200) return '单位说明过长: ' + symbol;
    if (seenUnits[symbol]) return '重复单位: ' + symbol;
    seenUnits[symbol] = true;
  }
  const seen = {};
  for (let i = 0; i < payload.variables.length; i++) {
    const name = payload.variables[i].name;
    if (!nameRe.test(name)) return '非法变量名: ' + name;
    if ((payload.variables[i].description || '').length > 200) return '变量说明过长: ' + name;
    if (seen[name]) return '重复变量: ' + name;
    seen[name] = true;
  }
  return null;
}

async function saveAgentSettings() {
  const payload = collectSettingsFromDom();
  const err = validateSettingsPayload(payload);
  if (err) {
    setSettingsSyncStatus('is-error', '校验失败');
    showSettingsMsg(err, false);
    return;
  }
  try {
    const resp = await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await resp.json().catch(function () { return {}; });
    if (!resp.ok) {
      const msg = data.error && (data.error.message || data.error) || resp.status;
      setSettingsSyncStatus('is-error', '同步失败');
      showSettingsMsg('保存失败: ' + msg, false);
      return;
    }
    agentSettings = {
      units: Array.isArray(data.units) ? data.units.map(normalizeSettingsUnit) : payload.units,
      variables: Array.isArray(data.variables) ? data.variables.map(normalizeSettingsVar) : payload.variables,
    };
    clearSettingsUndo();
    renderSettingsUnits();
    renderSettingsVars();
    markSettingsSynced('已同步');
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const ss = String(now.getSeconds()).padStart(2, '0');
    showSettingsMsg(
      '已保存到中心 · ' + agentSettings.units.length + ' 单位 / ' +
        agentSettings.variables.length + ' 变量 · ' + hh + ':' + mm + ':' + ss,
      true
    );
  } catch (e) {
    setSettingsSyncStatus('is-error', '同步失败');
    showSettingsMsg('保存失败: ' + e.message, false);
  }
}


function hideVarPicker() {
  if (varPickerEl) varPickerEl.hidden = true;
  varPickerTarget = null;
  varPickerIndex = 0;
  varPickerNames = [];
}

function ensureVarPicker() {
  if (varPickerEl) return varPickerEl;
  varPickerEl = document.createElement('ul');
  varPickerEl.className = 'var-picker';
  varPickerEl.id = 'var-picker';
  varPickerEl.hidden = true;
  varPickerEl.setAttribute('role', 'listbox');
  document.body.appendChild(varPickerEl);
  return varPickerEl;
}

function insertAtCaret(el, text) {
  const start = el.selectionStart != null ? el.selectionStart : el.value.length;
  const end = el.selectionEnd != null ? el.selectionEnd : start;
  const before = el.value.slice(0, start);
  const after = el.value.slice(end);
  el.value = before + text + after;
  const pos = start + text.length;
  if (el.setSelectionRange) el.setSelectionRange(pos, pos);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

/** Mirror-div caret coordinates relative to the viewport. */
function getCaretViewportPoint(el, position) {
  const rect = el.getBoundingClientRect();
  if (position == null) position = el.selectionStart != null ? el.selectionStart : 0;
  const style = window.getComputedStyle(el);
  const isInput = el.tagName === 'INPUT';

  if (isInput) {
    const mirror = document.createElement('div');
    mirror.style.cssText = [
      'position:absolute',
      'visibility:hidden',
      'white-space:pre',
      'top:0',
      'left:0',
      'pointer-events:none',
    ].join(';');
    [
      'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing',
      'textTransform', 'wordSpacing', 'textIndent', 'paddingLeft', 'borderLeftWidth',
    ].forEach(function (prop) {
      mirror.style[prop] = style[prop];
    });
    const text = (el.value || '').slice(0, position).replace(/ /g, '\u00a0');
    mirror.textContent = text;
    const marker = document.createElement('span');
    marker.textContent = '|';
    mirror.appendChild(marker);
    document.body.appendChild(mirror);
    const markerRect = marker.getBoundingClientRect();
    const mirrorRect = mirror.getBoundingClientRect();
    const xIn = markerRect.left - mirrorRect.left;
    document.body.removeChild(mirror);
    const scrollLeft = el.scrollLeft || 0;
    const paddingLeft = parseFloat(style.paddingLeft) || 0;
    const borderLeft = parseFloat(style.borderLeftWidth) || 0;
    const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2;
    const paddingTop = parseFloat(style.paddingTop) || 0;
    const borderTop = parseFloat(style.borderTopWidth) || 0;
    return {
      left: rect.left + borderLeft + paddingLeft + xIn - scrollLeft,
      top: rect.top + borderTop + paddingTop,
      height: lineHeight,
    };
  }

  const div = document.createElement('div');
  const props = [
    'direction', 'boxSizing', 'width', 'height', 'overflowX', 'overflowY',
    'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
    'borderStyle', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'fontStyle', 'fontVariant', 'fontWeight', 'fontStretch', 'fontSize',
    'fontSizeAdjust', 'lineHeight', 'fontFamily', 'textAlign', 'textTransform',
    'textIndent', 'textDecoration', 'letterSpacing', 'wordSpacing',
    'tabSize', 'MozTabSize', 'whiteSpace', 'wordWrap', 'wordBreak',
  ];
  div.style.position = 'absolute';
  div.style.visibility = 'hidden';
  div.style.whiteSpace = 'pre-wrap';
  div.style.wordWrap = 'break-word';
  div.style.top = '0';
  div.style.left = '-9999px';
  props.forEach(function (prop) {
    div.style[prop] = style[prop];
  });
  div.style.overflow = 'hidden';
  div.style.width = el.clientWidth + 'px';
  const value = el.value || '';
  div.textContent = value.slice(0, position);
  const span = document.createElement('span');
  span.textContent = value.slice(position) || '.';
  div.appendChild(span);
  document.body.appendChild(div);
  const coordinates = {
    left: rect.left - el.scrollLeft + span.offsetLeft,
    top: rect.top - el.scrollTop + span.offsetTop,
    height: parseFloat(style.lineHeight) || span.offsetHeight || parseFloat(style.fontSize) * 1.2,
  };
  document.body.removeChild(div);
  return coordinates;
}

function positionVarPicker(el) {
  const picker = ensureVarPicker();
  const caret = el.selectionStart != null ? el.selectionStart : (el.value || '').length;
  const point = getCaretViewportPoint(el, caret);
  picker.style.visibility = 'hidden';
  picker.hidden = false;
  const pw = picker.offsetWidth || 240;
  const ph = picker.offsetHeight || 160;
  let left = window.scrollX + point.left;
  let top = window.scrollY + point.top + point.height + 4;
  const maxLeft = window.scrollX + window.innerWidth - pw - 8;
  const maxTop = window.scrollY + window.innerHeight - ph - 8;
  if (left > maxLeft) left = Math.max(window.scrollX + 8, maxLeft);
  if (left < window.scrollX + 8) left = window.scrollX + 8;
  if (top > maxTop) {
    top = window.scrollY + point.top - ph - 4;
  }
  if (top < window.scrollY + 8) top = window.scrollY + 8;
  picker.style.left = left + 'px';
  picker.style.top = top + 'px';
  picker.style.visibility = '';
}

function applyVarPickerSelection() {
  if (!varPickerEl) return;
  const buttons = varPickerEl.querySelectorAll('button');
  buttons.forEach(function (btn, i) {
    const selected = i === varPickerIndex;
    btn.setAttribute('aria-selected', selected ? 'true' : 'false');
    if (selected) {
      btn.scrollIntoView({ block: 'nearest' });
    }
  });
}

function acceptVarPickerItem(el, name) {
  if (!el || !name) return;
  const val = el.value || '';
  const caret = el.selectionStart != null ? el.selectionStart : val.length;
  let start = caret;
  while (start > 0 && /[A-Za-z0-9_]/.test(val.charAt(start - 1))) start -= 1;
  // Trigger is `/` — replace `/` + optional filter with `${Name}`
  if (start > 0 && val.charAt(start - 1) === '/') start -= 1;
  const token = '${' + name + '}';
  el.value = val.slice(0, start) + token + val.slice(caret);
  const pos = start + token.length;
  if (el.setSelectionRange) el.setSelectionRange(pos, pos);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  hideVarPicker();
  el.focus();
}

function showVarPicker(el, filterPrefix) {
  const picker = ensureVarPicker();
  const vars = (agentSettings.variables || [])
    .filter(function (v) { return v && v.name; })
    .filter(function (v) {
      return !filterPrefix || v.name.toLowerCase().indexOf(filterPrefix.toLowerCase()) === 0;
    });
  picker.innerHTML = '';
  varPickerNames = vars.map(function (v) { return v.name; });
  if (!vars.length) {
    hideVarPicker();
    return;
  }
  if (varPickerIndex >= vars.length) varPickerIndex = 0;
  vars.forEach(function (v, i) {
    const name = v.name;
    const li = document.createElement('li');
    li.setAttribute('role', 'option');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('aria-selected', i === varPickerIndex ? 'true' : 'false');
    const token = '${' + name + '}';
    btn.textContent = v.description ? (token + ' — ' + v.description) : token;
    btn.addEventListener('mousedown', function (ev) {
      ev.preventDefault();
      acceptVarPickerItem(el, name);
    });
    li.appendChild(btn);
    picker.appendChild(li);
  });
  varPickerTarget = el;
  positionVarPicker(el);
  applyVarPickerSelection();
}

function isVarPickerOpenFor(el) {
  return varPickerEl && !varPickerEl.hidden && varPickerTarget === el && varPickerNames.length > 0;
}

function attachVarPicker(el) {
  if (!el || el.dataset.varPicker === '1') return;
  el.dataset.varPicker = '1';
  el.addEventListener('input', function () {
    const caret = el.selectionStart != null ? el.selectionStart : el.value.length;
    const before = el.value.slice(0, caret);
    const m = before.match(/\/([A-Za-z_][A-Za-z0-9_]*)?$/);
    if (m) {
      if (!isVarPickerOpenFor(el)) varPickerIndex = 0;
      showVarPicker(el, m[1] || '');
    } else {
      if (varPickerTarget === el) hideVarPicker();
    }
  });
  el.addEventListener('keydown', function (ev) {
    if (!isVarPickerOpenFor(el)) {
      if (ev.key === 'Escape') hideVarPicker();
      return;
    }
    if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      varPickerIndex = (varPickerIndex + 1) % varPickerNames.length;
      applyVarPickerSelection();
      return;
    }
    if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      varPickerIndex = (varPickerIndex - 1 + varPickerNames.length) % varPickerNames.length;
      applyVarPickerSelection();
      return;
    }
    if (ev.key === 'Enter' || ev.key === 'Tab') {
      ev.preventDefault();
      acceptVarPickerItem(el, varPickerNames[varPickerIndex]);
      return;
    }
    if (ev.key === 'Escape') {
      ev.preventDefault();
      hideVarPicker();
    }
  });
  el.addEventListener('keyup', function () {
    if (isVarPickerOpenFor(el)) positionVarPicker(el);
  });
  el.addEventListener('click', function () {
    if (isVarPickerOpenFor(el)) positionVarPicker(el);
  });
  el.addEventListener('blur', function () {
    setTimeout(function () {
      if (varPickerTarget === el) hideVarPicker();
    }, 150);
  });
}

function attachVarPickersIn(root) {
  if (!root) return;
  root.querySelectorAll('input.lv-value, textarea.lv-value, input.seq-input-edit, textarea.seq-input-edit, .spec-min, .spec-max, #gen-delay-ms, #api-url, #api-headers, #api-body, #api-headers-kv-body input').forEach(attachVarPicker);
}

async function ensureAgentSettingsLoaded() {
  if (agentSettings && (agentSettings.units.length || agentSettings.variables.length)) return;
  try {
    await fetchAgentSettings();
  } catch (e) {
    /* keep empty */
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

function isObjectLike(value) {
  return value !== null && typeof value === 'object';
}

function parseEditableInputValue(raw, className) {
  const text = String(raw == null ? '' : raw);
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const typeName = String(className || '').toLowerCase();
  if (typeName.indexOf('array') >= 0 || typeName.indexOf('cluster') >= 0 || typeName.indexOf('json') >= 0) {
    return JSON.parse(trimmed);
  }
  if (trimmed === 'true' || trimmed === 'false') return trimmed === 'true';
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  return text;
}

const viWorkbench = window.AgentViWorkbenchRuntime.createWorkbenchRuntime();

async function registerNow() {
  const msg = document.getElementById('register-msg');
  msg.hidden = false;
  msg.textContent = '注册中…';
  msg.className = 'msg topbar-msg';
  try {
    const resp = await fetch('/api/register-now', { method: 'POST' });
    const data = await resp.json();
    if (resp.ok) {
      msg.textContent = '注册成功';
      msg.className = 'msg topbar-msg ok';
    } else {
      msg.textContent = '注册失败: ' + (data.error || resp.status);
      msg.className = 'msg topbar-msg err';
    }
  } catch (e) {
    msg.textContent = '注册失败: ' + e.message;
    msg.className = 'msg topbar-msg err';
  }
}

document.getElementById('register-btn').addEventListener('click', registerNow);

const machineInfo = document.getElementById('machine-info');
if (machineInfo) {
  document.addEventListener('click', function (event) {
    if (!machineInfo.open) return;
    if (machineInfo.contains(event.target)) return;
    machineInfo.open = false;
  });
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && machineInfo.open) machineInfo.open = false;
  });
}

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

function hideLvMsg() {
  const msg = document.getElementById('lv-msg');
  msg.hidden = true;
  msg.textContent = '';
}

function isJsonScalar(value) {
  return value !== null && typeof value === 'object';
}

function renderInputsTable(inputs, emptyText) {
  const tbody = document.getElementById('lv-inputs-body');
  tbody.innerHTML = '';
  if (!Array.isArray(inputs)) {
    tbody.innerHTML = '<tr><td colspan="3" class="empty">' + escapeHtml(emptyText || '先查询参数') + '</td></tr>';
    return;
  }
  if (!inputs || inputs.length === 0) {
    tbody.innerHTML = '<tr><td colspan="3" class="empty">无输入参数</td></tr>';
    return;
  }
  for (let inputIndex = 0; inputIndex < inputs.length; inputIndex += 1) {
    const inp = inputs[inputIndex];
    const row = document.createElement('tr');
    const name = escapeHtml(inp.name || '');
    const className = escapeHtml(inp.className || '');
    const inputId = 'lv-input-' + inputIndex;
    const val = inp.value;
    let valueCell;
    if (isJsonScalar(val)) {
      valueCell =
        '<textarea class="lv-value lv-value-json mono" id="' +
        inputId +
        '" data-name="' +
        escapeHtml(inp.name) +
        '" name="' +
        escapeHtml(inp.name) +
        '" data-class="' +
        className +
        '" rows="2">' +
        escapeHtml(JSON.stringify(val)) +
        '</textarea>';
    } else {
      valueCell =
        '<input class="lv-value mono" id="' +
        inputId +
        '" data-name="' +
        escapeHtml(inp.name) +
        '" name="' +
        escapeHtml(inp.name) +
        '" data-class="' +
        className +
        '" type="text" value="' +
        escapeHtml(val == null ? '' : String(val)) +
        '">';
    }
    row.innerHTML =
      '<td><label for="' + inputId + '">' + name + '</label></td>' +
      '<td class="mono">' + className + '</td>' +
      '<td>' + valueCell + '</td>';
    tbody.appendChild(row);
  }
  attachVarPickersIn(tbody);
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

function lvStageMessage(snapshot) {
  if (snapshot.state === 'ready_to_run') {
    if (snapshot.runResult !== null) return '试跑完成，等待填写名称';
    if (String(snapshot.name || '').trim()) {
      return '参数已查询，尚未试跑；可直接注册，试跑可选';
    }
    return '参数已查询，尚未试跑；可以试跑';
  }
  if (snapshot.state === 'ready_to_register') {
    return '试跑完成，已命名，可以注册';
  }
  const messages = {
    empty: '填写 VI 路径以开始',
    ready_to_inspect: '路径已就绪，可以查询参数',
    inspecting: '正在查询参数…',
    running: '正在试跑…',
    registering: '正在注册到中心…',
    registered: '注册完成',
  };
  return messages[snapshot.state] || messages.empty;
}

function lvStageStatusText(status) {
  const labels = {
    current: '当前',
    optional: '可选',
    complete: '完成',
    waiting: '待处理',
  };
  return labels[status] || labels.waiting;
}

function setActionState(button, action) {
  button.disabled = !action.enabled;
  button.title = action.enabled ? '' : action.reason;
}

function syncAdvancedDetailsDisabledState(details, disabled) {
  const summary = details.querySelector('summary');
  summary.removeAttribute('tabindex');
  if (disabled) {
    details.inert = true;
    details.setAttribute('inert', '');
    details.setAttribute('aria-disabled', 'true');
    return;
  }
  details.inert = false;
  details.removeAttribute('inert');
  details.removeAttribute('aria-disabled');
}

function syncLvTemplateLoadButtons(disabled) {
  document.querySelectorAll('#lv-center-body .lv-load-template').forEach(function (button) {
    button.disabled = disabled;
    button.title = disabled ? '操作进行中' : '';
  });
}

function setTextIfChanged(element, text) {
  if (element.textContent === text) return false;
  element.textContent = text;
  return true;
}

function syncLvWorkbench() {
  const snapshot = viWorkbench.snapshot();
  const controls = snapshot.controls;
  const pathEl = document.getElementById('lv-vi-path');
  const nameEl = document.getElementById('lv-name');
  const advanced = document.getElementById('lv-advanced');

  pathEl.disabled = controls.pathDisabled;
  nameEl.disabled = controls.nameDisabled;
  document.querySelectorAll('#lv-inputs-body .lv-value').forEach(function (el) {
    el.disabled = controls.inputsDisabled;
  });
  syncLvTemplateLoadButtons(controls.inputsDisabled);
  document.getElementById('lv-show-fp').disabled = controls.advancedDisabled;
  document.getElementById('lv-timeout').disabled = controls.advancedDisabled;
  syncAdvancedDetailsDisabledState(advanced, controls.advancedDisabled);

  setActionState(document.getElementById('lv-inspect-btn'), controls.inspect);
  setActionState(document.getElementById('lv-run-btn'), controls.run);
  setActionState(document.getElementById('lv-register-btn'), controls.register);

  const stageMessage = lvStageMessage(snapshot);
  setTextIfChanged(document.getElementById('lv-stage-status'), stageMessage);
  const actionHint = document.getElementById('lv-action-hint');
  let actionHintText = '';
  if (snapshot.state === 'empty') {
    actionHintText = '填写 VI 路径后可查询参数';
  } else if (snapshot.state === 'ready_to_inspect') {
    actionHintText = '请先查询参数；成功后可试跑和注册';
  } else if (snapshot.state === 'ready_to_run') {
    actionHintText = stageMessage;
  } else if (snapshot.state === 'ready_to_register') {
    actionHintText = '可以注册；也可再次试跑';
  } else if (snapshot.pendingAction) {
    actionHintText = stageMessage + '，请稍候';
  }
  setTextIfChanged(actionHint, actionHintText);
  actionHint.hidden = actionHintText === '';
  const stageElements = document.querySelectorAll('[data-lv-stage]');
  snapshot.stages.forEach(function (stageState, index) {
    const stage = stageElements[index];
    if (!stage) return;
    stage.dataset.status = stageState.status;
    setTextIfChanged(stage.querySelector('.lv-stage-state'),
      lvStageStatusText(stageState.status));
    if (stageState.status === 'current') stage.setAttribute('aria-current', 'step');
    else stage.removeAttribute('aria-current');
  });

  document.getElementById('lv-registered-actions').hidden = snapshot.state !== 'registered';
}

function clearLvSchemasAndResults() {
  hideLvMsg();
  renderInputsTable(null, '先查询参数');
  document.getElementById('lv-json-raw').textContent = '—';
  const summary = document.getElementById('lv-schema-summary');
  summary.hidden = true;
  summary.textContent = '';
  clearLvRunResult();
}

function showLvSchemaSummary(inputs, outputs) {
  const summary = document.getElementById('lv-schema-summary');
  summary.hidden = false;
  summary.textContent = '参数已加载 · 入参 ' + inputs.length + ' · 出参 ' + outputs.length;
}

function clearLvRunResult() {
  document.getElementById('lv-run-result').hidden = true;
  document.getElementById('lv-run-summary').textContent = '';
  document.getElementById('lv-run-json').textContent = '—';
}

function runResultSummary(result) {
  if (!result || typeof result !== 'object') return '试跑完成';
  const status = result.status || (result.ok === true ? '成功' : '');
  const outputs = result.outputs && typeof result.outputs === 'object'
    ? Object.keys(result.outputs).length
    : 0;
  const parts = ['试跑完成'];
  if (status) parts.push('状态 ' + status);
  if (outputs) parts.push('输出 ' + outputs + ' 项');
  return parts.join(' · ');
}

function renderLvRunResult(result) {
  if (result == null) {
    clearLvRunResult();
    return;
  }
  document.getElementById('lv-run-result').hidden = false;
  document.getElementById('lv-run-summary').textContent = runResultSummary(result);
  document.getElementById('lv-run-json').textContent = JSON.stringify(result, null, 2);
}

async function inspectVi() {
  if (!viWorkbench.beginInspect()) return;
  const viPath = viWorkbench.snapshot().path;
  showLvMsg('查询中…', true);
  syncLvWorkbench();
  try {
    const resp = await fetch('/api/labview/inspect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vi_path: viPath }),
    });
    const data = await resp.json();
    document.getElementById('lv-json-raw').textContent = JSON.stringify(data, null, 2);
    if (!resp.ok) {
      viWorkbench.actionFailed('inspect');
      const err = data.error && (data.error.message || data.error) || resp.status;
      showLvMsg('查询失败: ' + err, false);
      syncLvWorkbench();
      return;
    }
    viWorkbench.inspectSucceeded(data);
    const snapshot = viWorkbench.snapshot();
    renderInputsTable(snapshot.inputs);
    showLvSchemaSummary(snapshot.inputs, snapshot.outputs);
    clearLvRunResult();
    showLvMsg('参数已加载', true);
    syncLvWorkbench();
  } catch (e) {
    viWorkbench.actionFailed('inspect');
    showLvMsg('查询失败: ' + e.message, false);
    syncLvWorkbench();
  }
}

async function runVi() {
  if (!viWorkbench.beginRun()) return;
  const viPath = viWorkbench.snapshot().path;
  syncLvWorkbench();
  let inputs;
  try {
    inputs = collectInputsFromTable();
  } catch (e) {
    viWorkbench.actionFailed('run');
    showLvMsg(e.message, false);
    syncLvWorkbench();
    return;
  }
  let opts;
  try {
    opts = readRunOptions();
  } catch (e) {
    viWorkbench.actionFailed('run');
    showLvMsg(e.message, false);
    syncLvWorkbench();
    return;
  }
  showLvMsg('试跑中…', true);
  clearLvRunResult();
  try {
    const resp = await fetch('/api/labview/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ vi_path: viPath, inputs: inputs }, opts)),
    });
    const data = await resp.json();
    if (!resp.ok) {
      viWorkbench.actionFailed('run');
      const err = data.error && (data.error.message || data.error) || resp.status;
      showLvMsg('试跑失败: ' + err, false);
      renderLvRunResult(viWorkbench.snapshot().runResult);
      syncLvWorkbench();
      return;
    }
    viWorkbench.runSucceeded(data);
    renderLvRunResult(data);
    showLvMsg('试跑完成', true);
    syncLvWorkbench();
  } catch (e) {
    viWorkbench.actionFailed('run');
    showLvMsg('试跑失败: ' + e.message, false);
    renderLvRunResult(viWorkbench.snapshot().runResult);
    syncLvWorkbench();
  }
}

async function registerViTemplate() {
  if (!viWorkbench.beginRegister()) return;
  const snapshot = viWorkbench.snapshot();
  const viPath = snapshot.path;
  const name = snapshot.name.trim();
  syncLvWorkbench();
  let inputs;
  try {
    inputs = collectInputsFromTable();
  } catch (e) {
    viWorkbench.actionFailed('register');
    showLvMsg(e.message, false);
    syncLvWorkbench();
    return;
  }
  let opts;
  try {
    opts = readRunOptions();
  } catch (e) {
    viWorkbench.actionFailed('register');
    showLvMsg(e.message, false);
    syncLvWorkbench();
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
        outputs: snapshot.outputs,
        name: name,
      }, opts)),
    });
    const data = await resp.json();
    if (!resp.ok) {
      viWorkbench.actionFailed('register');
      const err = data.error && (data.error.message || data.error) || resp.status;
      showLvMsg('注册失败: ' + err, false);
      syncLvWorkbench();
      return;
    }
    viWorkbench.registerSucceeded(data);
    showLvMsg('已注册: ' + (data.name || data.id), true);
    syncLvWorkbench();
    await Promise.all([fetchLabviewCenterTemplates(), loadSeqRegistered()]);
  } catch (e) {
    viWorkbench.actionFailed('register');
    showLvMsg('注册失败: ' + e.message, false);
    syncLvWorkbench();
  }
}

function loadTemplateToEditor(t) {
  if (!viWorkbench.loadTemplate(t)) return false;
  const snapshot = viWorkbench.snapshot();
  document.getElementById('lv-vi-path').value = snapshot.path;
  document.getElementById('lv-name').value = snapshot.name;
  renderInputsTable(snapshot.inputs);
  showLvSchemaSummary(snapshot.inputs, snapshot.outputs);
  document.getElementById('lv-show-fp').checked = !!t.show_front_panel;
  const timeoutEl = document.getElementById('lv-timeout');
  if (t.timeout_secs != null && t.timeout_secs > 0) {
    timeoutEl.value = String(t.timeout_secs);
  } else {
    timeoutEl.value = '';
  }
  document.getElementById('lv-json-raw').textContent = JSON.stringify(t, null, 2);
  clearLvRunResult();
  showLvMsg('已加载到编辑区: ' + (t.name || t.id), true);
  syncLvWorkbench();
  return true;
}

function showLvCenterMsg(text, ok) {
  const msg = document.getElementById('lv-center-msg');
  if (!msg) return;
  msg.hidden = false;
  msg.textContent = text;
  msg.className = ok ? 'msg ok' : 'msg err';
}

let lvCenterTemplates = [];
let lvCenterQuery = '';

function renderLabviewCenterTemplates() {
  const tbody = document.getElementById('lv-center-body');
  if (!tbody) return;
  tbody.innerHTML = '';
  if (!lvCenterTemplates.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty">暂无已注册 VI 功能</td></tr>';
    return;
  }
  const query = lvCenterQuery.trim().toLowerCase();
  const matches = lvCenterTemplates.filter(function (template) {
    if (!query) return true;
    return [
      template.name,
      template.id,
      template.origin_agent_name,
      template.vi_path,
    ].some(function (value) {
      return String(value == null ? '' : value).toLowerCase().includes(query);
    });
  });
  if (!matches.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty">无匹配 VI 功能，请调整搜索</td></tr>';
    return;
  }
  for (let i = 0; i < matches.length; i++) {
    const t = matches[i];
    const row = document.createElement('tr');
    row.innerHTML =
      '<td class="mono">' + escapeHtml(String(t.id ?? '—')) + '</td>' +
      '<td>' + escapeHtml(t.name || '—') + '</td>' +
      '<td>' + escapeHtml(t.origin_agent_name || '—') + '</td>' +
      '<td class="mono">' + escapeHtml(t.vi_path || '—') + '</td>';
    const actions = document.createElement('td');
    const loadBtn = document.createElement('button');
    loadBtn.type = 'button';
    loadBtn.className = 'lv-load-template';
    loadBtn.textContent = '加载到编辑区';
    loadBtn.disabled = viWorkbench.snapshot().controls.inputsDisabled;
    loadBtn.title = loadBtn.disabled ? '操作进行中' : '';
    loadBtn.addEventListener('click', function () {
      if (!loadTemplateToEditor(t)) {
        showLvCenterMsg('操作进行中，无法加载到编辑区', false);
        return;
      }
      showLvCenterMsg('已加载: ' + (t.name || t.id), true);
    });
    actions.appendChild(loadBtn);
    row.appendChild(actions);
    tbody.appendChild(row);
  }
}

async function fetchLabviewCenterTemplates() {
  const tbody = document.getElementById('lv-center-body');
  if (!tbody) return;
  try {
    const resp = await fetch('/api/labview/all-templates');
    const data = await resp.json();
    if (!resp.ok) {
      const err = data.error && (data.error.message || data.error) || resp.status;
      tbody.innerHTML = '<tr><td colspan="5" class="empty">加载失败: ' + escapeHtml(String(err)) + '</td></tr>';
      return;
    }
    lvCenterTemplates = Array.isArray(data) ? data : [];
    renderLabviewCenterTemplates();
  } catch (e) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty">加载失败: ' + escapeHtml(e.message) + '</td></tr>';
  }
}

function delayMsFromInputs(inputs) {
  if (inputs && typeof inputs === 'object' && !Array.isArray(inputs)) {
    if (inputs.delay_ms == null) return null;
    const n = Number(inputs.delay_ms);
    if (Number.isFinite(n) && n >= 0) return Math.round(n);
    return null;
  }
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
  await fetchLabviewCenterTemplates();
  await loadSeqRegistered();
}

document.getElementById('lv-inspect-btn').addEventListener('click', inspectVi);
document.getElementById('lv-run-btn').addEventListener('click', runVi);
document.getElementById('lv-register-btn').addEventListener('click', registerViTemplate);
document.getElementById('lv-vi-path').addEventListener('input', function (event) {
  viWorkbench.inputPath(event.target.value);
  const snapshot = viWorkbench.snapshot();
  if (!snapshot.inspectedPath) clearLvSchemasAndResults();
  syncLvWorkbench();
});
document.getElementById('lv-vi-path').addEventListener('blur', function (event) {
  const normalized = viWorkbench.blurPath();
  event.target.value = normalized.path;
  document.getElementById('lv-name').value = normalized.name;
  syncLvWorkbench();
});
document.getElementById('lv-name').addEventListener('input', function (event) {
  viWorkbench.inputName(event.target.value);
  syncLvWorkbench();
});
document.querySelector('#lv-advanced > summary').addEventListener('click', function (event) {
  if (document.getElementById('lv-advanced').getAttribute('aria-disabled') === 'true') {
    event.preventDefault();
  }
});
document.getElementById('lv-center-search').addEventListener('input', function (event) {
  lvCenterQuery = event.target.value || '';
  renderLabviewCenterTemplates();
});
document.getElementById('lv-copy-result-btn').addEventListener('click', async function () {
  const result = viWorkbench.snapshot().runResult;
  if (result == null) return;
  const text = JSON.stringify(result, null, 2);
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const copyArea = document.createElement('textarea');
      copyArea.value = text;
      copyArea.setAttribute('readonly', '');
      copyArea.style.position = 'fixed';
      copyArea.style.opacity = '0';
      document.body.appendChild(copyArea);
      copyArea.select();
      document.execCommand('copy');
      copyArea.remove();
    }
    showLvMsg('已复制试跑 JSON', true);
  } catch (e) {
    showLvMsg('复制失败: ' + e.message, false);
  }
});
document.getElementById('lv-view-registered-btn').addEventListener('click', function () {
  const section = document.getElementById('lv-center-section');
  const search = document.getElementById('lv-center-search');
  section.scrollIntoView({ block: 'start' });
  search.focus();
});
document.getElementById('lv-edit-copy-btn').addEventListener('click', function () {
  if (!viWorkbench.continueEditingCopy()) return;
  hideLvMsg();
  syncLvWorkbench();
});
syncLvWorkbench();

// --- Sequence page ---

let seqRegistered = [];
let seqSelected = [];
let seqRunning = false;
let seqPaused = false;
let seqStepResults = {};
let seqProgressPollTimer = null;
let seqDragIndex = null;
let seqFocusIndex = null;
let seqCheckedIndexes = {};
let seqDropPlacement = null;
let seqInputsEditIndex = -1;
let seqTemplates = [];
let seqActiveTemplateId = null;
let seqExpandedIndexes = {};
let seqRegisteredQuery = '';
let seqRegisteredSource = 'all';

function showPage(page) {
  const workbench = document.getElementById('page-workbench');
  const general = document.getElementById('page-general');
  const apiPage = document.getElementById('page-api');
  const sequence = document.getElementById('page-sequence');
  const settings = document.getElementById('page-settings');
  const leavingSettings = settings && !settings.hidden && page !== 'settings';
  if (leavingSettings && settingsDirty) {
    if (!window.confirm('配置有未保存更改，确定离开？')) return;
  }
  workbench.hidden = page !== 'workbench';
  if (general) general.hidden = page !== 'general';
  if (apiPage) apiPage.hidden = page !== 'api';
  sequence.hidden = page !== 'sequence';
  if (settings) settings.hidden = page !== 'settings';
  document.querySelectorAll('.page-tabs .tab').forEach(function (btn) {
    btn.classList.toggle('active', btn.getAttribute('data-page') === page);
  });
  if (page === 'sequence') {
    loadSequencePage();
  } else if (page === 'workbench') {
    fetchLabviewCenterTemplates();
  } else if (page === 'general') {
    fetchGeneralTemplates();
  } else if (page === 'api') {
    fetchRestTemplates();
  } else if (page === 'settings') {
    if (settingsDirty) {
      renderSettingsUnits();
      renderSettingsVars();
    } else {
      loadAgentSettingsPage();
    }
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
  const insertGroupBtn = document.getElementById('seq-insert-group');
  if (insertGroupBtn) insertGroupBtn.disabled = disabled || seqPaused;
  updateGroupSelectedBtn();
  if (disabled || seqPaused) {
    const groupSelectedBtn = document.getElementById('seq-group-selected');
    if (groupSelectedBtn) groupSelectedBtn.disabled = true;
  }
  document.querySelectorAll('#seq-registered-body button, #seq-selected-body button').forEach(function (btn) {
    if (btn.classList.contains('seq-detail-toggle')) return;
    btn.disabled = disabled || seqPaused;
  });
  document.querySelectorAll('#seq-selected-body input[type="checkbox"], #seq-selected-body select').forEach(function (el) {
    el.disabled = disabled || seqPaused;
  });
  document.querySelectorAll('#seq-selected-body tr.seq-row[data-index]').forEach(function (row) {
    row.draggable = !disabled && !seqPaused;
  });
}

function formatSpecSummary(limits) {
  if (!Array.isArray(limits) || limits.length === 0) return '编辑 Spec';
  if (limits.length === 1 && limits[0] && limits[0].output) {
    return 'Spec · ' + limits[0].output;
  }
  return 'Spec · ' + limits.length + ' 项';
}

function formatStepStatus(status) {
  const map = {
    pass: '通过',
    fail: '失败',
    ok: 'OK',
    error: '错误',
    skipped: '跳过',
    running: '执行中',
  };
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

function formatLimitBoundDisplay(raw) {
  if (raw == null || raw === '') return '—';
  if (typeof raw === 'object') {
    try {
      return JSON.stringify(raw);
    } catch (e) {
      return String(raw);
    }
  }
  return String(raw);
}

function lookupMeasuredValue(measured, output) {
  if (!measured || typeof measured !== 'object' || Array.isArray(measured)) return null;
  if (!Object.prototype.hasOwnProperty.call(measured, output)) return null;
  return measured[output];
}

/** Build { value, min, max, unit } HTML cell contents for Spec columns. */
function formatSeqLimitCells(item, stepResult) {
  const dash = '—';
  const empty = { value: dash, min: dash, max: dash, unit: dash };
  let limits = Array.isArray(item && item.limits) ? item.limits : [];
  if ((!limits || !limits.length) && stepResult && Array.isArray(stepResult.limits)) {
    limits = stepResult.limits;
  }
  if (!limits.length) return empty;

  const measured = stepResult && stepResult.measured != null ? stepResult.measured : null;
  const multi = limits.length > 1;
  const valueLines = [];
  const minLines = [];
  const maxLines = [];
  const unitLines = [];

  for (let i = 0; i < limits.length; i++) {
    const rule = limits[i] || {};
    const output = rule.output || '';
    const op = normalizeSpecOp(rule.op);
    const measuredVal = lookupMeasuredValue(measured, output);
    let valueText = dash;
    if (measuredVal != null) {
      valueText = formatLimitBoundDisplay(measuredVal);
    }
    if (multi && output) {
      valueText = output + ': ' + valueText;
    }
    valueLines.push(escapeHtml(valueText));

    if (op === 'eq' || op === 'ne' || op === 'in') {
      const expectVal = rule.expect != null ? rule.expect : rule.min;
      const expectText = formatLimitBoundDisplay(expectVal);
      // Op is configured in Spec; 下限 column shows expect only (no leading =/≠/∈).
      const prefix = op === 'eq' ? '' : op === 'ne' ? '≠' : '∈';
      minLines.push(escapeHtml(prefix + expectText));
      maxLines.push(escapeHtml(dash));
    } else {
      minLines.push(escapeHtml(formatLimitBoundDisplay(rule.min)));
      maxLines.push(escapeHtml(formatLimitBoundDisplay(rule.max)));
    }
    unitLines.push(escapeHtml(rule.unit ? String(rule.unit) : dash));
  }

  return {
    value: valueLines.join('<br>'),
    min: minLines.join('<br>'),
    max: maxLines.join('<br>'),
    unit: unitLines.join('<br>'),
  };
}

function normalizeSpecOp(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (!s || s === 'range' || s === 'between' || s === 'num' || s === 'number') return 'range';
  if (s === 'eq' || s === '==' || s === '=' || s === 'equal') return 'eq';
  if (s === 'ne' || s === '!=' || s === '<>' || s === 'not_equal') return 'ne';
  if (s === 'in' || s === 'one_of') return 'in';
  return 'range';
}

function syncSpecRowOpUi(tr) {
  if (!tr) return;
  const opSel = tr.querySelector('.spec-op-select');
  const minInput = tr.querySelector('.spec-min');
  const maxInput = tr.querySelector('.spec-max');
  const op = normalizeSpecOp(opSel && opSel.value);
  if (!minInput) return;
  if (op === 'range') {
    minInput.placeholder = '下限或 ${Var}';
    minInput.disabled = false;
    if (maxInput) {
      maxInput.disabled = false;
      maxInput.hidden = false;
      maxInput.placeholder = '上限或 ${Var}';
    }
  } else if (op === 'in') {
    minInput.placeholder = '期望列表，如 A,B,C';
    minInput.disabled = false;
    if (maxInput) {
      maxInput.value = '';
      maxInput.disabled = true;
      maxInput.hidden = false;
      maxInput.placeholder = '—';
    }
  } else {
    minInput.placeholder = op === 'ne' ? '不等于…' : '期望值或 ${Var}';
    minInput.disabled = false;
    if (maxInput) {
      maxInput.value = '';
      maxInput.disabled = true;
      maxInput.hidden = false;
      maxInput.placeholder = '—';
    }
  }
}

function updateSeqOverall(data) {
  const el = document.getElementById('seq-overall');
  if (!el) return;
  const parts = [];
  if (data && data.overall) parts.push('总体: ' + data.overall);
  if (data && data.sn) parts.push('SN: ' + data.sn);
  el.textContent = parts.join(' · ');
  el.classList.remove('seq-overall-pass', 'seq-overall-fail');
  const overall = data && data.overall ? String(data.overall).toLowerCase() : '';
  if (overall === 'pass' || overall === 'ok') el.classList.add('seq-overall-pass');
  else if (overall === 'fail' || overall === 'failed' || overall === 'aborted' || overall === 'error') {
    el.classList.add('seq-overall-fail');
  }
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

function applySequenceProgress(prog) {
  if (!prog) return;
  applyStepResults(prog.steps);
  if (prog.current_position != null && prog.running) {
    const pos = prog.current_position;
    if (!seqStepResults[pos]) {
      seqStepResults[pos] = {
        position: pos,
        name: prog.current_name || '',
        ok: true,
        status: 'running',
        measured: null,
        limits: null,
        result: null,
        error: null,
      };
    }
  }
  renderSeqSelected();
}

function clearSequenceResultsUi() {
  seqStepResults = {};
  updateSeqOverall({});
  const resultsEl = document.getElementById('seq-results');
  if (resultsEl) {
    resultsEl.innerHTML = '';
    resultsEl.hidden = true;
  }
  renderSeqSelected();
}

function startSequenceProgressPoll() {
  stopSequenceProgressPoll();
  seqProgressPollTimer = setInterval(async function () {
    try {
      const resp = await fetch('/api/sequence/run/progress');
      if (!resp.ok) return;
      const prog = await resp.json();
      applySequenceProgress(prog);
    } catch (e) {
      /* ignore transient poll errors */
    }
  }, 250);
}

function stopSequenceProgressPoll() {
  if (seqProgressPollTimer != null) {
    clearInterval(seqProgressPollTimer);
    seqProgressPollTimer = null;
  }
}

let specEditIndex = null;

function outputNamesFromSchema(outputs) {
  if (Array.isArray(outputs)) {
    const names = [];
    for (let i = 0; i < outputs.length; i++) {
      const o = outputs[i];
      if (!o) continue;
      if (typeof o === 'string' && o.trim()) names.push(o.trim());
      else if (o.name && String(o.name).trim()) names.push(String(o.name).trim());
    }
    return names;
  }
  if (outputs && typeof outputs === 'object') {
    return Object.keys(outputs).filter(function (k) {
      return k && k !== 'headers' && k !== 'body' && k !== 'body_json' && k !== 'error';
    });
  }
  return [];
}

function resolveStepOutputNames(item) {
  let names = outputNamesFromSchema(item && item.outputs);
  if (names.length) return names;
  const source = item && item.template_source ? item.template_source : 'labview';
  const tid = source === 'general' ? item && item.general_template_id : item && item.vi_template_id;
  if (tid == null) return [];
  for (let i = 0; i < seqRegistered.length; i++) {
    const regSource = seqRegistered[i]._source || 'labview';
    if (regSource === source && String(seqRegistered[i].id) === String(tid)) {
      return outputNamesFromSchema(seqRegistered[i].outputs);
    }
  }
  return [];
}

function renderSpecModalRows(limits, outputNames) {
  const tbody = document.getElementById('spec-modal-body');
  tbody.innerHTML = '';
  const rows = Array.isArray(limits) && limits.length
    ? limits
    : [{ output: '', op: 'range', min: null, max: null, expect: null, unit: '' }];
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

    const opSelect = document.createElement('select');
    opSelect.className = 'spec-op-select';
    [
      { value: 'range', label: '区间' },
      { value: 'eq', label: '等于' },
      { value: 'ne', label: '不等于' },
      { value: 'in', label: '属于' },
    ].forEach(function (optDef) {
      const opt = document.createElement('option');
      opt.value = optDef.value;
      opt.textContent = optDef.label;
      opSelect.appendChild(opt);
    });
    opSelect.value = normalizeSpecOp(lim.op);
    opSelect.addEventListener('change', function () {
      syncSpecRowOpUi(tr);
    });
    const opCell = document.createElement('td');
    opCell.appendChild(opSelect);

    const op = normalizeSpecOp(lim.op);
    const expectSeed = lim.expect != null ? lim.expect : (op !== 'range' ? lim.min : null);
    const minInput = document.createElement('input');
    minInput.type = 'text';
    minInput.className = 'spec-min mono';
    minInput.placeholder = '下限或 ${Var}';
    if (op === 'range') {
      minInput.value = lim.min == null ? '' : String(lim.min);
    } else if (expectSeed == null) {
      minInput.value = '';
    } else if (Array.isArray(expectSeed)) {
      minInput.value = expectSeed.map(function (x) { return String(x); }).join(',');
    } else {
      minInput.value = String(expectSeed);
    }
    attachVarPicker(minInput);

    const maxInput = document.createElement('input');
    maxInput.type = 'text';
    maxInput.className = 'spec-max mono';
    maxInput.placeholder = '上限或 ${Var}';
    maxInput.value = lim.max == null ? '' : String(lim.max);
    attachVarPicker(maxInput);

    const unitWrap = document.createElement('div');
    const unitSelect = document.createElement('select');
    unitSelect.className = 'spec-unit-select';
    const blankUnit = document.createElement('option');
    blankUnit.value = '';
    blankUnit.textContent = '（无）';
    unitSelect.appendChild(blankUnit);
    const units = (agentSettings.units || []).map(normalizeSettingsUnit).filter(function (u) { return u.symbol; });
    const currentUnit = lim.unit || '';
    if (currentUnit && unitSymbols(units).indexOf(currentUnit) < 0) {
      units.unshift({ symbol: currentUnit, description: '' });
    }
    units.forEach(function (u) {
      const opt = document.createElement('option');
      opt.value = u.symbol;
      opt.textContent = u.description ? (u.symbol + ' — ' + u.description) : u.symbol;
      if (u.symbol === currentUnit) opt.selected = true;
      unitSelect.appendChild(opt);
    });
    const customUnitOpt = document.createElement('option');
    customUnitOpt.value = '__custom__';
    customUnitOpt.textContent = '自定义…';
    unitSelect.appendChild(customUnitOpt);
    const unitInput = document.createElement('input');
    unitInput.type = 'text';
    unitInput.className = 'spec-unit mono';
    unitInput.placeholder = '单位';
    unitInput.hidden = true;
    if (currentUnit && unitSymbols(agentSettings.units || []).indexOf(currentUnit) < 0) {
      unitSelect.value = '__custom__';
      unitInput.hidden = false;
      unitInput.value = currentUnit;
    } else if (currentUnit) {
      unitSelect.value = currentUnit;
    }
    unitSelect.addEventListener('change', function () {
      if (unitSelect.value === '__custom__') {
        unitInput.hidden = false;
        unitInput.focus();
      } else {
        unitInput.hidden = true;
        unitInput.value = unitSelect.value;
      }
    });
    unitWrap.appendChild(unitSelect);
    unitWrap.appendChild(unitInput);
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.textContent = '删';
    rm.addEventListener('click', function () {
      tr.remove();
      if (!tbody.children.length) renderSpecModalRows([], outputNames);
    });
    tr.appendChild(outCell);
    tr.appendChild(opCell);
    const tdMin = document.createElement('td'); tdMin.appendChild(minInput); tr.appendChild(tdMin);
    const tdMax = document.createElement('td'); tdMax.appendChild(maxInput); tr.appendChild(tdMax);
    const tdUnit = document.createElement('td'); tdUnit.appendChild(unitWrap); tr.appendChild(tdUnit);
    const tdRm = document.createElement('td'); tdRm.appendChild(rm); tr.appendChild(tdRm);
    tbody.appendChild(tr);
    syncSpecRowOpUi(tr);
  }
}

function looksLikeVarToken(text) {
  return String(text || '').indexOf('${') >= 0;
}

function parseSpecBound(raw) {
  const t = String(raw || '').trim();
  if (t === '') return null;
  if (looksLikeVarToken(t)) return t;
  const n = Number(t);
  if (!Number.isFinite(n)) return t;
  return n;
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
    const op = normalizeSpecOp(tr.querySelector('.spec-op-select') && tr.querySelector('.spec-op-select').value);
    const minEl = tr.querySelector('.spec-min');
    const maxEl = tr.querySelector('.spec-max');
    const minRaw = minEl ? minEl.value.trim() : '';
    const maxRaw = maxEl ? maxEl.value.trim() : '';
    const unitSelect = tr.querySelector('.spec-unit-select');
    const unitCustom = tr.querySelector('.spec-unit');
    let unit = '';
    if (unitSelect && unitSelect.value === '__custom__') unit = (unitCustom && unitCustom.value || '').trim();
    else if (unitSelect) unit = unitSelect.value.trim();
    else if (unitCustom) unit = unitCustom.value.trim();

    const lim = { output: name, op: op };
    if (op === 'range') {
      lim.min = parseSpecBound(minRaw);
      lim.max = parseSpecBound(maxRaw);
    } else if (op === 'in') {
      if (minRaw) {
        lim.expect = minRaw.split(',').map(function (p) { return p.trim(); }).filter(Boolean);
      } else {
        lim.expect = null;
      }
      lim.min = null;
      lim.max = null;
    } else {
      lim.expect = parseSpecBound(minRaw);
      lim.min = null;
      lim.max = null;
    }
    if (unit) lim.unit = unit;
    out.push(lim);
  }
  return out;
}

function openSpecEditor(index) {
  const item = seqSelected[index];
  if (!item) return;
  closeSeqInputsModal();
  if (inputsPopoverEl) inputsPopoverEl.hidden = true;
  specEditIndex = index;
  const names = resolveStepOutputNames(item);
  const hint = document.getElementById('spec-modal-hint');
  hint.textContent = names.length
    ? ('可选输出: ' + names.join(', '))
    : '该步骤尚未注册输出参数；可手动填写输出名，或重新注册模板后再设置 Spec。';
  ensureAgentSettingsLoaded().then(function () {
    renderSpecModalRows(item.limits || [], names);
    document.getElementById('spec-modal').hidden = false;
  });
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
  current.push({ output: '', op: 'range', min: null, max: null, expect: null, unit: '' });
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
  await Promise.all([loadSeqRegistered(), loadQueue(), loadSequenceTemplates()]);
  updateSequenceTemplateBinding();
}

async function loadSeqRegistered() {
  const tbody = document.getElementById('seq-registered-body');
  try {
    const [lvResp, genResp] = await Promise.all([
      fetch('/api/labview/all-templates'),
      fetch('/api/general/all-templates'),
    ]);
    const [lvData, genData] = await Promise.all([lvResp.json(), genResp.json()]);
    if (!lvResp.ok) {
      const err = lvData.error && (lvData.error.message || lvData.error) || lvResp.status;
      tbody.innerHTML =
        '<tr><td colspan="6" class="empty">加载 LabVIEW 模板失败: ' + escapeHtml(String(err)) + '</td></tr>';
      return;
    }
    const lvList = (Array.isArray(lvData) ? lvData : []).map(t => Object.assign({}, t, { _source: 'labview' }));
    const genList = genResp.ok ? (Array.isArray(genData) ? genData : []).map(t => Object.assign({}, t, { _source: 'general' })) : [];
    seqRegistered = [...lvList, ...genList];
    renderSeqRegistered();
  } catch (e) {
    tbody.innerHTML =
      '<tr><td colspan="6" class="empty">加载失败: ' + escapeHtml(e.message) + '</td></tr>';
  }
}

function filteredSeqRegistered() {
  const q = (seqRegisteredQuery || '').trim().toLowerCase();
  return seqRegistered.filter(function (t) {
    const source = t._source === 'general' ? 'general' : 'labview';
    if (seqRegisteredSource !== 'all' && source !== seqRegisteredSource) return false;
    if (!q) return true;
    const hay = [
      t.id,
      t.name,
      t.kind,
      t.origin_agent_name,
      t.origin_agent_id,
    ].map(function (v) { return v == null ? '' : String(v).toLowerCase(); }).join(' ');
    return hay.indexOf(q) >= 0;
  });
}

function updateSeqRegisteredCount() {
  const el = document.getElementById('seq-registered-count');
  if (!el) return;
  const total = seqRegistered.length;
  if (!total) {
    el.textContent = '(0)';
    return;
  }
  const shown = filteredSeqRegistered().length;
  el.textContent = shown === total ? '(' + total + ')' : '(' + shown + '/' + total + ')';
}

function updateSeqTemplatesCount() {
  const el = document.getElementById('seq-templates-count');
  if (!el) return;
  el.textContent = '(' + seqTemplates.length + ')';
}

function renderSeqRegistered() {
  const tbody = document.getElementById('seq-registered-body');
  tbody.innerHTML = '';
  if (!seqRegistered.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty">暂无中心已注册功能</td></tr>';
    updateSeqRegisteredCount();
    return;
  }
  const list = filteredSeqRegistered();
  if (!list.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty">无匹配功能，请调整搜索或筛选</td></tr>';
    updateSeqRegisteredCount();
    return;
  }
  for (let i = 0; i < list.length; i++) {
    const t = list[i];
    const row = document.createElement('tr');
    const isGeneral = t._source === 'general';
    const kind = (t.kind || (isGeneral ? 'general' : 'labview')).toLowerCase();
    const typeLabel = isGeneral ? kindLabel(kind) : 'VI';
    const badgeClass = kind === 'rest' ? 'rest' : (isGeneral ? 'general' : 'labview');
    const name = escapeHtml(t.name || t.id || '—');
    const origin = escapeHtml(t.origin_agent_name || '—');
    const actions = document.createElement('td');
    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.textContent = '添加';
    addBtn.disabled = seqRunning || seqPaused;
    addBtn.addEventListener('click', function () {
      addToQueue(t);
    });
    actions.appendChild(addBtn);
    row.innerHTML =
      '<td class="mono">' + escapeHtml(String(t.id ?? '—')) + '</td>' +
      '<td><span class="kind-badge kind-' + badgeClass + '">' + typeLabel + '</span></td>' +
      '<td>' + name + '</td>' +
      '<td>' + origin + '</td>' +
      '<td class="inputs-cell-host"></td>';
    attachInputsHover(row.querySelector('.inputs-cell-host'), t.inputs);
    row.appendChild(actions);
    tbody.appendChild(row);
  }
  updateSeqRegisteredCount();
}

async function loadQueue() {
  try {
    const resp = await fetch('/api/sequence/run-queue');
    const data = await resp.json();
    if (!resp.ok) {
      const err = data.error && (data.error.message || data.error) || resp.status;
      showSeqMsg('加载队列失败: ' + err, false);
      seqSelected = [];
    } else {
      seqSelected = Array.isArray(data.items) ? data.items : [];
    }
    updateSequenceTemplateBinding();
    renderSeqSelected();
  } catch (e) {
    showSeqMsg('加载队列失败: ' + e.message, false);
    seqSelected = [];
    renderSeqSelected();
  }
}

function updateSequenceTemplateBinding() {
  const el = document.getElementById('seq-template-bind');
  if (!el) return;
  const active = seqTemplates.find(function (t) {
    return String(t.id) === String(seqActiveTemplateId);
  });
  el.textContent = active
    ? '当前模板: ' + (active.name || active.id) + ' (ID ' + active.id + ')'
    : '当前未绑定序列模板';
}

async function loadSequenceTemplates() {
  const tbody = document.getElementById('seq-templates-body');
  if (!tbody) return;
  try {
    const resp = await fetch('/api/sequence-templates');
    const data = await resp.json();
    if (!resp.ok) {
      const err = data.error && (data.error.message || data.error) || resp.status;
      tbody.innerHTML = '<tr><td colspan="5" class="empty">加载失败: ' + escapeHtml(String(err)) + '</td></tr>';
      return;
    }
    seqTemplates = Array.isArray(data) ? data : [];
    renderSequenceTemplates();
    updateSequenceTemplateBinding();
  } catch (e) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty">加载失败: ' + escapeHtml(e.message) + '</td></tr>';
  }
}

function renderSequenceTemplates() {
  const tbody = document.getElementById('seq-templates-body');
  if (!tbody) return;
  tbody.innerHTML = '';
  if (!seqTemplates.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty">暂无中心序列模板</td></tr>';
    updateSeqTemplatesCount();
    return;
  }
  for (let i = 0; i < seqTemplates.length; i++) {
    const t = seqTemplates[i];
    const row = document.createElement('tr');
    const isActive = String(t.id) === String(seqActiveTemplateId);
    row.innerHTML =
      '<td class="mono">' + escapeHtml(String(t.id)) + '</td>' +
      '<td>' + escapeHtml(t.name || '—') + (isActive ? ' <span class="kind-badge kind-general">当前</span>' : '') + '</td>' +
      '<td class="mono">' + escapeHtml(String(t.step_count || 0)) + '</td>' +
      '<td>' + escapeHtml(t.created_by_agent_name || '—') + '</td>';
    const actions = document.createElement('td');
    const loadBtn = document.createElement('button');
    loadBtn.type = 'button';
    loadBtn.textContent = '加载到当前队列';
    loadBtn.disabled = seqRunning || seqPaused;
    loadBtn.addEventListener('click', function () { loadSequenceTemplateToQueue(t); });
    actions.appendChild(loadBtn);
    row.appendChild(actions);
    tbody.appendChild(row);
  }
  updateSeqTemplatesCount();
}

function resultBadgeHtml(stepResult) {
  if (!stepResult) return '<span class="seq-result-badge">—</span>';
  const status = stepResult.status || (stepResult.ok ? 'pass' : 'fail');
  const cls = String(status).toLowerCase().replace(/[^a-z0-9_-]/g, '');
  return '<span class="seq-result-badge ' + escapeHtml(cls) + '">' +
    escapeHtml(formatStepStatus(status)) + '</span>';
}

function toggleSeqDetail(index) {
  if (seqExpandedIndexes[index]) delete seqExpandedIndexes[index];
  else seqExpandedIndexes[index] = true;
  renderSeqSelected();
}

function isSeqGroupItem(item) {
  return !!(item && item.template_source === 'group');
}

function makeSeqGroupItem(name) {
  return {
    template_source: 'group',
    name: name || nextGroupDefaultName(),
    enabled: true,
    collapsed: false,
    vi_template_id: null,
    general_template_id: null,
    inputs: [],
    breakpoint: false,
    fail_policy: 'stop',
    limits: [],
    note: '',
  };
}

/** Exclusive end index of the block starting at groupHeaderIndex (header + members). */
function endOfGroup(groupHeaderIndex) {
  for (let j = groupHeaderIndex + 1; j < seqSelected.length; j++) {
    if (isSeqGroupItem(seqSelected[j])) return j;
  }
  return seqSelected.length;
}

function groupMemberCount(groupHeaderIndex) {
  return Math.max(0, endOfGroup(groupHeaderIndex) - groupHeaderIndex - 1);
}

/** Group header index owning stepIndex, or -1 if ungrouped / invalid. */
function owningGroupHeaderIndex(stepIndex) {
  if (stepIndex < 0 || stepIndex >= seqSelected.length) return -1;
  if (isSeqGroupItem(seqSelected[stepIndex])) return stepIndex;
  for (let j = stepIndex; j >= 0; j--) {
    if (isSeqGroupItem(seqSelected[j])) return j;
  }
  return -1;
}

/** Where to insert a new step: end of focused group, else after focus, else tail. */
function insertIndexForNewStep() {
  if (seqFocusIndex == null || seqFocusIndex < 0 || seqFocusIndex >= seqSelected.length) {
    return seqSelected.length;
  }
  const focus = seqFocusIndex;
  if (isSeqGroupItem(seqSelected[focus])) {
    return endOfGroup(focus);
  }
  const gh = owningGroupHeaderIndex(focus);
  if (gh >= 0) return endOfGroup(gh);
  return focus + 1;
}

function updateSeqInsertBadge() {
  const el = document.getElementById('seq-insert-badge');
  if (!el) return;
  if (seqFocusIndex == null || seqFocusIndex < 0 || seqFocusIndex >= seqSelected.length) {
    el.textContent = '将加入：队尾（根级）';
    return;
  }
  const focus = seqFocusIndex;
  if (isSeqGroupItem(seqSelected[focus])) {
    el.textContent = '将加入：分组「' + (seqSelected[focus].name || '分组') + '」';
    return;
  }
  const gh = owningGroupHeaderIndex(focus);
  if (gh >= 0) {
    el.textContent = '将加入：分组「' + (seqSelected[gh].name || '分组') + '」';
    return;
  }
  el.textContent = '将加入：选中步骤之后（根级）';
}

function updateGroupSelectedBtn() {
  const btn = document.getElementById('seq-group-selected');
  if (!btn) return;
  let n = 0;
  Object.keys(seqCheckedIndexes).forEach(function (k) {
    const i = parseInt(k, 10);
    if (seqCheckedIndexes[k] && !isSeqGroupItem(seqSelected[i])) n += 1;
  });
  btn.disabled = seqRunning || seqPaused || n < 1;
}

function setSeqFocus(index) {
  seqFocusIndex = index;
  document.querySelectorAll('#seq-selected-body tr.seq-row').forEach(function (r) {
    const i = parseInt(r.getAttribute('data-index'), 10);
    r.classList.toggle('seq-row-focused', i === index);
  });
  updateSeqInsertBadge();
}

function seqGroupUiFlags(items) {
  let groupEnabled = true;
  let collapsed = false;
  return items.map(function (item) {
    if (isSeqGroupItem(item)) {
      groupEnabled = item.enabled !== false;
      collapsed = !!item.collapsed;
      return { isGroup: true, groupEnabled: true, hidden: false };
    }
    return { isGroup: false, groupEnabled: groupEnabled, hidden: collapsed };
  });
}

function nextGroupDefaultName() {
  let n = 1;
  for (let i = 0; i < seqSelected.length; i++) {
    if (!isSeqGroupItem(seqSelected[i])) continue;
    const m = String(seqSelected[i].name || '').match(/^分组\s*(\d+)$/);
    if (m) n = Math.max(n, parseInt(m[1], 10) + 1);
  }
  return '分组 ' + n;
}

/** Pure: wrap selected step indexes into a new group header block. */
function groupSelectedSteps(items, indexes) {
  const sorted = (indexes || [])
    .map(function (i) { return parseInt(i, 10); })
    .filter(function (i) {
      return i >= 0 && i < items.length && !isSeqGroupItem(items[i]);
    })
    .sort(function (a, b) { return a - b; });
  if (!sorted.length) return items.slice();
  const pickSet = {};
  sorted.forEach(function (i) { pickSet[i] = true; });
  const picked = sorted.map(function (i) { return items[i]; });
  const rest = [];
  for (let i = 0; i < items.length; i++) {
    if (!pickSet[i]) rest.push(items[i]);
  }
  let insertAt = 0;
  for (let i = 0; i < sorted[0]; i++) {
    if (!pickSet[i]) insertAt += 1;
  }
  const header = makeSeqGroupItem(nextGroupDefaultName());
  return rest.slice(0, insertAt).concat([header], picked, rest.slice(insertAt));
}

async function insertSeqGroup() {
  if (seqRunning || seqPaused) return;
  const newGroup = makeSeqGroupItem(nextGroupDefaultName());
  let at = seqSelected.length;
  if (seqFocusIndex != null && seqFocusIndex >= 0 && seqFocusIndex < seqSelected.length) {
    const gh = owningGroupHeaderIndex(seqFocusIndex);
    if (gh >= 0) {
      at = endOfGroup(gh);
    } else {
      at = seqFocusIndex + 1;
    }
  }
  seqSelected.splice(at, 0, newGroup);
  seqFocusIndex = at;
  renderSeqSelected();
  await saveQueue();
}

async function groupCheckedIntoFolder() {
  if (seqRunning || seqPaused) return;
  const indexes = Object.keys(seqCheckedIndexes)
    .map(function (k) { return parseInt(k, 10); })
    .filter(function (i) { return seqCheckedIndexes[i] && !isSeqGroupItem(seqSelected[i]); });
  if (!indexes.length) return;
  seqSelected = groupSelectedSteps(seqSelected, indexes);
  seqCheckedIndexes = {};
  // Focus the new group header (first selected index mapped after regroup).
  const minOld = Math.min.apply(null, indexes);
  let insertAt = 0;
  for (let i = 0; i < minOld; i++) {
    if (indexes.indexOf(i) < 0) insertAt += 1;
  }
  // After regroup, header sits at insertAt among remaining-non-picked + ...
  // groupSelectedSteps inserts header at `insertAt` in `rest`.
  seqFocusIndex = insertAt;
  renderSeqSelected();
  await saveQueue();
  showSeqMsg('已编成一组', true);
}

function clearSeqDropUi() {
  document.querySelectorAll(
    '#seq-selected-body tr.seq-drop-before, #seq-selected-body tr.seq-drop-after, #seq-selected-body tr.seq-drop-after-block, #seq-selected-body tr.seq-drop-into, #seq-selected-body tr.seq-drag-over'
  ).forEach(function (el) {
    el.classList.remove('seq-drop-before', 'seq-drop-after', 'seq-drop-after-block', 'seq-drop-into', 'seq-drag-over');
  });
  seqDropPlacement = null;
}

function computeSeqDropPlacement(e, row) {
  const index = parseInt(row.getAttribute('data-index'), 10);
  if (Number.isNaN(index)) return null;
  const forced = row.getAttribute('data-drop-mode');
  if (forced === 'into') return { mode: 'into', index: index };
  const rect = row.getBoundingClientRect();
  const ratio = (e.clientY - rect.top) / Math.max(rect.height, 1);
  if (isSeqGroupItem(seqSelected[index])) {
    if (ratio < 0.28) return { mode: 'before', index: index };
    if (ratio > 0.72) return { mode: 'after-block', index: index };
    return { mode: 'into', index: index };
  }
  if (ratio < 0.5) return { mode: 'before', index: index };
  return { mode: 'after', index: index };
}

function applySeqDropPlacementVisual(placement) {
  clearSeqDropUi();
  if (!placement) return;
  seqDropPlacement = placement;
  const row = document.querySelector(
    '#seq-selected-body tr.seq-row[data-index="' + placement.index + '"], #seq-selected-body tr.seq-group-empty-row[data-index="' + placement.index + '"]'
  );
  if (!row) return;
  if (placement.mode === 'before') row.classList.add('seq-drop-before');
  else if (placement.mode === 'after') row.classList.add('seq-drop-after');
  else if (placement.mode === 'after-block') row.classList.add('seq-drop-after-block');
  else if (placement.mode === 'into') row.classList.add('seq-drop-into');
}

/** Root-level insert index for moving a whole group block. */
function rootInsertIndexFromPlacement(placement) {
  if (!placement || placement.mode === 'into') return null;
  const idx = placement.index;
  if (placement.mode === 'before') {
    if (isSeqGroupItem(seqSelected[idx])) return idx;
    const gh = owningGroupHeaderIndex(idx);
    return gh >= 0 ? gh : idx;
  }
  if (placement.mode === 'after') {
    if (isSeqGroupItem(seqSelected[idx])) return endOfGroup(idx);
    const gh = owningGroupHeaderIndex(idx);
    return gh >= 0 ? endOfGroup(gh) : idx + 1;
  }
  if (placement.mode === 'after-block') return endOfGroup(idx);
  return null;
}

/** Insert index for moving a single step (may enter/leave groups). */
function stepInsertIndexFromPlacement(placement) {
  if (!placement) return null;
  const idx = placement.index;
  if (placement.mode === 'into') {
    if (!isSeqGroupItem(seqSelected[idx])) return null;
    return endOfGroup(idx);
  }
  if (placement.mode === 'before') return idx;
  if (placement.mode === 'after') return idx + 1;
  if (placement.mode === 'after-block') return endOfGroup(idx);
  return null;
}

function relocateQueueSlice(start, endExclusive, insertAt) {
  if (insertAt == null || start < 0 || endExclusive <= start) return null;
  if (insertAt >= start && insertAt <= endExclusive) return start;
  const block = seqSelected.splice(start, endExclusive - start);
  let at = insertAt;
  if (start < insertAt) at = insertAt - block.length;
  seqSelected.splice(at, 0, ...block);
  return at;
}

function renderSeqSelected() {
  const tbody = document.getElementById('seq-selected-body');
  tbody.innerHTML = '';
  const keep = {};
  for (let i = 0; i < seqSelected.length; i++) {
    if (seqExpandedIndexes[i] && !isSeqGroupItem(seqSelected[i])) keep[i] = true;
  }
  seqExpandedIndexes = keep;
  const nextChecked = {};
  Object.keys(seqCheckedIndexes).forEach(function (k) {
    const i = parseInt(k, 10);
    if (seqCheckedIndexes[k] && i >= 0 && i < seqSelected.length && !isSeqGroupItem(seqSelected[i])) {
      nextChecked[i] = true;
    }
  });
  seqCheckedIndexes = nextChecked;

  if (!seqSelected.length) {
    tbody.innerHTML = '<tr><td colspan="11" class="empty">队列为空，展开上方「中心全部功能」后添加</td></tr>';
    setSeqControlsDisabled(false);
    seqFocusIndex = null;
    updateSeqInsertBadge();
    updateGroupSelectedBtn();
    return;
  }
  if (seqFocusIndex != null && (seqFocusIndex < 0 || seqFocusIndex >= seqSelected.length)) {
    seqFocusIndex = null;
  }
  const flags = seqGroupUiFlags(seqSelected);
  for (let i = 0; i < seqSelected.length; i++) {
    const item = seqSelected[i];
    const flag = flags[i];
    if (flag.hidden) continue;

    if (flag.isGroup) {
      const members = groupMemberCount(i);
      const row = document.createElement('tr');
      row.setAttribute('data-index', String(i));
      row.draggable = !seqRunning && !seqPaused;
      row.className =
        'seq-row seq-group-row' +
        (item.enabled === false ? ' seq-group-disabled' : '') +
        (seqFocusIndex === i ? ' seq-row-focused' : '');

      const numTd = document.createElement('td');
      numTd.className = 'mono';
      const indexWrap = document.createElement('span');
      indexWrap.className = 'seq-outline-index';
      const collapseBtn = document.createElement('button');
      collapseBtn.type = 'button';
      collapseBtn.className = 'btn-sm seq-group-collapse';
      collapseBtn.textContent = item.collapsed ? '▶' : '▼';
      collapseBtn.title = item.collapsed ? '展开分组' : '折叠分组';
      collapseBtn.disabled = seqRunning || seqPaused;
      collapseBtn.addEventListener('click', async function (ev) {
        ev.stopPropagation();
        item.collapsed = !item.collapsed;
        renderSeqSelected();
        await saveQueue();
      });
      indexWrap.appendChild(collapseBtn);
      indexWrap.appendChild(document.createTextNode(String(i + 1)));
      numTd.appendChild(indexWrap);
      row.appendChild(numTd);

      const enTd = document.createElement('td');
      enTd.className = 'seq-check-cell';
      const enabledCb = document.createElement('input');
      enabledCb.type = 'checkbox';
      enabledCb.checked = item.enabled !== false;
      enabledCb.title = '启用整组';
      enabledCb.disabled = seqRunning || seqPaused;
      enabledCb.addEventListener('change', async function () {
        item.enabled = enabledCb.checked;
        await saveQueue();
      });
      enTd.appendChild(enabledCb);
      row.appendChild(enTd);

      row.appendChild(document.createElement('td')); // 断点空

      const nameTd = document.createElement('td');
      const folderMark = document.createElement('span');
      folderMark.className = 'seq-folder-mark';
      folderMark.textContent = '组 ';
      nameTd.appendChild(folderMark);
      const nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.className = 'seq-group-title';
      nameInput.value = item.name || '分组';
      nameInput.disabled = seqRunning || seqPaused;
      nameInput.setAttribute('aria-label', '分组名称');
      nameInput.addEventListener('change', async function () {
        item.name = nameInput.value.trim() || '分组';
        await saveQueue();
      });
      nameTd.appendChild(nameInput);
      const meta = document.createElement('span');
      meta.className = 'seq-group-meta';
      meta.textContent = members ? members + ' 项' : '空';
      nameTd.appendChild(meta);
      row.appendChild(nameTd);

      const kindTd = document.createElement('td');
      kindTd.textContent = '分组';
      row.appendChild(kindTd);

      for (let c = 0; c < 5; c++) {
        const td = document.createElement('td');
        td.textContent = '—';
        row.appendChild(td);
      }

      const actions = document.createElement('td');
      actions.className = 'seq-row-actions';
      const upBtn = document.createElement('button');
      upBtn.type = 'button';
      upBtn.textContent = '↑';
      upBtn.title = '上移整组';
      upBtn.disabled = seqRunning || seqPaused || i === 0;
      upBtn.addEventListener('click', function () { moveQueueItem(i, -1); });
      const downBtn = document.createElement('button');
      downBtn.type = 'button';
      downBtn.textContent = '↓';
      downBtn.title = '下移整组';
      downBtn.disabled = seqRunning || seqPaused || endOfGroup(i) >= seqSelected.length;
      downBtn.addEventListener('click', function () { moveQueueItem(i, 1); });
      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.textContent = '解散分组';
      removeBtn.title = '删除分组，保留组内步骤到根级';
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
      row.addEventListener('click', function (ev) {
        if (ev.target.closest('button, input, select, textarea, a, label')) return;
        setSeqFocus(i);
      });
      tbody.appendChild(row);

      if (!item.collapsed && members === 0) {
        const emptyRow = document.createElement('tr');
        emptyRow.className = 'seq-group-empty-row';
        emptyRow.setAttribute('data-index', String(i));
        emptyRow.setAttribute('data-drop-mode', 'into');
        const emptyTd = document.createElement('td');
        emptyTd.colSpan = 11;
        emptyTd.textContent = '拖入步骤到此分组';
        emptyRow.appendChild(emptyTd);
        emptyRow.addEventListener('dragover', onSeqDragOver);
        emptyRow.addEventListener('dragleave', onSeqDragLeave);
        emptyRow.addEventListener('drop', onSeqDrop);
        tbody.appendChild(emptyRow);
      }
      continue;
    }

    const inGroup = owningGroupHeaderIndex(i) >= 0 && !isSeqGroupItem(item);
    const row = document.createElement('tr');
    row.setAttribute('data-index', String(i));
    row.draggable = !seqRunning && !seqPaused;
    row.className =
      'seq-row' +
      (inGroup ? ' seq-outline-child' : '') +
      (seqExpandedIndexes[i] ? ' seq-row-expanded' : '') +
      (flag.groupEnabled ? '' : ' seq-step-group-disabled') +
      (seqFocusIndex === i ? ' seq-row-focused' : '') +
      (seqCheckedIndexes[i] ? ' seq-row-picked' : '');
    const pos = item.position != null ? item.position : i;
    const stepResult = seqStepResults[pos];
    const source = item.template_source === 'general' ? 'general' : 'labview';
    const templateId = source === 'general' ? item.general_template_id : item.vi_template_id;
    const name = escapeHtml(item.name || templateId || '—');
    const kindDisplay = kindLabel(item.kind || 'labview');
    const enabled = item.enabled !== false;
    const breakpoint = !!item.breakpoint;
    const failPolicy = item.fail_policy === 'continue' ? 'continue' : 'stop';
    const limits = Array.isArray(item.limits) ? item.limits : [];
    const expanded = !!seqExpandedIndexes[i];
    const limitCells = formatSeqLimitCells(item, stepResult);

    row.innerHTML =
      '<td class="mono"></td>' +
      '<td class="seq-check-cell"></td>' +
      '<td class="seq-check-cell"></td>' +
      '<td>' + name + '</td>' +
      '<td class="mono">' + kindDisplay + '</td>' +
      '<td class="seq-result-cell">' + resultBadgeHtml(stepResult) + '</td>' +
      '<td class="seq-limit-cell mono">' + limitCells.value + '</td>' +
      '<td class="seq-limit-cell mono">' + limitCells.min + '</td>' +
      '<td class="seq-limit-cell mono">' + limitCells.max + '</td>' +
      '<td class="seq-limit-cell mono">' + limitCells.unit + '</td>';

    const indexWrap = document.createElement('span');
    indexWrap.className = 'seq-outline-index';
    const pick = document.createElement('input');
    pick.type = 'checkbox';
    pick.className = 'seq-pick';
    pick.title = '勾选后可「编成一组」';
    pick.checked = !!seqCheckedIndexes[i];
    pick.disabled = seqRunning || seqPaused;
    pick.addEventListener('click', function (ev) { ev.stopPropagation(); });
    pick.addEventListener('change', function () {
      if (pick.checked) seqCheckedIndexes[i] = true;
      else delete seqCheckedIndexes[i];
      row.classList.toggle('seq-row-picked', !!pick.checked);
      updateGroupSelectedBtn();
    });
    indexWrap.appendChild(pick);
    indexWrap.appendChild(document.createTextNode(String(i + 1)));
    row.children[0].appendChild(indexWrap);

    const enabledCb = document.createElement('input');
    enabledCb.type = 'checkbox';
    enabledCb.checked = enabled;
    enabledCb.title = flag.groupEnabled ? '启用' : '所属分组已禁用';
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

    const actions = document.createElement('td');
    actions.className = 'seq-row-actions';
    const detailBtn = document.createElement('button');
    detailBtn.type = 'button';
    detailBtn.className = 'btn-sm seq-detail-toggle';
    detailBtn.textContent = expanded ? '收起' : '详情';
    detailBtn.addEventListener('click', function (ev) {
      ev.stopPropagation();
      toggleSeqDetail(i);
    });
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
    actions.appendChild(detailBtn);
    actions.appendChild(document.createTextNode(' '));
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
    row.addEventListener('click', function (ev) {
      if (ev.target.closest('button, input, select, textarea, a, label')) return;
      setSeqFocus(i);
    });
    tbody.appendChild(row);

    const detailRow = document.createElement('tr');
    detailRow.className = 'seq-detail-row';
    detailRow.hidden = !expanded;
    const detailTd = document.createElement('td');
    detailTd.colSpan = 11;
    const panel = document.createElement('div');
    panel.className = 'seq-detail-panel';

    const meta = document.createElement('div');
    meta.className = 'seq-detail-meta';
    meta.innerHTML =
      '<span>模板 ID <span class="mono">' + escapeHtml(String(templateId ?? '—')) + '</span></span>' +
      '<span>来源 <span class="mono">' + escapeHtml(source) + '</span></span>';
    panel.appendChild(meta);

    const detailActions = document.createElement('div');
    detailActions.className = 'seq-detail-actions';
    const inputsHost = document.createElement('div');
    inputsHost.className = 'inputs-cell-host';
    renderSeqInputsCell(inputsHost, item, i);
    detailActions.appendChild(inputsHost);

    const specBtn = document.createElement('button');
    specBtn.type = 'button';
    specBtn.className = 'seq-spec-btn';
    specBtn.textContent = formatSpecSummary(limits);
    specBtn.title = '点击编辑 Spec';
    specBtn.disabled = seqRunning || seqPaused;
    specBtn.addEventListener('click', function () { editLimitsAt(i); });
    detailActions.appendChild(specBtn);

    const failWrap = document.createElement('label');
    failWrap.className = 'seq-fail-cell';
    failWrap.appendChild(document.createTextNode('Fail '));
    const failSel = document.createElement('select');
    failSel.innerHTML = '<option value="stop">停止</option><option value="continue">继续</option>';
    failSel.value = failPolicy;
    failSel.disabled = seqRunning || seqPaused;
    failSel.addEventListener('change', async function () {
      item.fail_policy = failSel.value === 'continue' ? 'continue' : 'stop';
      await saveQueue();
    });
    failWrap.appendChild(failSel);
    detailActions.appendChild(failWrap);
    panel.appendChild(detailActions);

    const measured = document.createElement('div');
    measured.className = 'seq-detail-measured mono';
    measured.textContent = '实测: ' + (stepResult ? formatMeasuredSummary(stepResult.measured) : '—');
    panel.appendChild(measured);

    if (stepResult && stepResult.error) {
      const errEl = document.createElement('div');
      errEl.className = 'seq-detail-error mono';
      errEl.textContent = '错误: ' + stepResult.error;
      panel.appendChild(errEl);
    }

    if (stepResult && stepResult.result != null) {
      const details = document.createElement('details');
      details.className = 'seq-step-details';
      const summary = document.createElement('summary');
      summary.textContent = '原始返回 JSON';
      const pre = document.createElement('pre');
      pre.className = 'mono lv-pre';
      pre.textContent = JSON.stringify(stepResult.result, null, 2);
      details.appendChild(summary);
      details.appendChild(pre);
      panel.appendChild(details);
    }

    detailTd.appendChild(panel);
    detailRow.appendChild(detailTd);
    tbody.appendChild(detailRow);
  }
  setSeqControlsDisabled(seqRunning);
  updateSeqInsertBadge();
  updateGroupSelectedBtn();
}

function renderSeqInputsCell(host, item, index) {
  if (!host) return;
  host.innerHTML = '';
  host.classList.add('inputs-cell-host');
  const wrap = document.createElement('div');
  wrap.className = 'seq-inputs-cell';
  const editBtn = document.createElement('button');
  editBtn.type = 'button';
  editBtn.className = 'btn-sm seq-inputs-edit-btn';
  editBtn.textContent = '编辑入参';
  editBtn.title = formatInputsPretty(item.inputs);
  editBtn.disabled = seqRunning || seqPaused;
  editBtn.addEventListener('click', function (ev) {
    ev.stopPropagation();
    openSeqInputsEditor(index);
  });
  wrap.appendChild(editBtn);
  host.appendChild(wrap);
}

async function saveQueue() {
  const body = {
    items: seqSelected.map(function (item) {
      if (item.template_source === 'group') {
        return {
          template_source: 'group',
          name: item.name || '分组',
          enabled: item.enabled !== false,
          collapsed: !!item.collapsed,
          note: item.note || '',
          inputs: [],
          limits: [],
          breakpoint: false,
          fail_policy: 'stop',
        };
      }
      return {
        template_source: item.template_source === 'general' ? 'general' : 'labview',
        vi_template_id: item.template_source === 'general' ? null : item.vi_template_id,
        general_template_id: item.template_source === 'general' ? item.general_template_id : null,
        inputs:
          item.inputs != null && typeof item.inputs === 'object'
            ? item.inputs
            : [],
        enabled: item.enabled !== false,
        breakpoint: !!item.breakpoint,
        fail_policy: item.fail_policy === 'continue' ? 'continue' : 'stop',
        limits: Array.isArray(item.limits) ? item.limits : [],
        note: item.note || '',
      };
    }),
  };
  try {
    const resp = await fetch('/api/sequence/run-queue', {
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

function closeSeqInputsModal() {
  const modal = document.getElementById('seq-inputs-modal');
  if (modal) modal.hidden = true;
  seqInputsEditIndex = -1;
}

function openSeqInputsEditor(index) {
  const item = seqSelected[index];
  const modal = document.getElementById('seq-inputs-modal');
  const body = document.getElementById('seq-inputs-modal-body');
  const hint = document.getElementById('seq-inputs-modal-hint');
  if (!item || !modal || !body || !hint) return;
  closeSpecModal();
  if (inputsPopoverEl) inputsPopoverEl.hidden = true;
  seqInputsEditIndex = index;
  hint.textContent = (item.name || '步骤') + ' · 修改后只影响当前序列步骤';
  body.innerHTML = '';
  // delay/REST: native JSON object — edit as one JSON blob
  if (item.inputs && typeof item.inputs === 'object' && !Array.isArray(item.inputs)) {
    hint.textContent =
      (item.name || '步骤') + ' · 通用步骤入参为 JSON 对象，修改后只影响当前序列步骤';
    const row = document.createElement('tr');
    row.innerHTML =
      '<td>inputs</td>' +
      '<td class="mono">object</td>' +
      '<td><textarea class="seq-input-edit mono seq-input-object-json" rows="12">' +
      escapeHtml(JSON.stringify(item.inputs, null, 2)) +
      '</textarea></td>';
    body.appendChild(row);
    modal.hidden = false;
    attachVarPickersIn(body);
    return;
  }
  const inputs = Array.isArray(item.inputs) ? item.inputs : [];
  if (!inputs.length) {
    body.innerHTML = '<tr><td colspan="3" class="empty">该步骤没有可编辑入参</td></tr>';
  } else {
    for (let i = 0; i < inputs.length; i++) {
      const inp = inputs[i] || {};
      const row = document.createElement('tr');
      const value = inp.value;
      const control = isObjectLike(value)
        ? '<textarea class="seq-input-edit mono" data-index="' + i + '" data-class="' + escapeHtml(inp.className || '') + '" rows="3">' + escapeHtml(JSON.stringify(value)) + '</textarea>'
        : '<input class="seq-input-edit mono" data-index="' + i + '" data-class="' + escapeHtml(inp.className || '') + '" type="text" value="' + escapeHtml(value == null ? '' : String(value)) + '">';
      row.innerHTML =
        '<td>' + escapeHtml(inp.name || '') + '</td>' +
        '<td class="mono">' + escapeHtml(inp.className || '') + '</td>' +
        '<td>' + control + '</td>';
      body.appendChild(row);
    }
  }
  modal.hidden = false;
  attachVarPickersIn(body);
}

function collectSeqInputsModalValues() {
  if (seqInputsEditIndex < 0 || seqInputsEditIndex >= seqSelected.length) return [];
  const objectEl = document.querySelector('#seq-inputs-modal .seq-input-object-json');
  if (objectEl) {
    const parsed = JSON.parse(objectEl.value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('入参必须是 JSON object');
    }
    return parsed;
  }
  const original = Array.isArray(seqSelected[seqInputsEditIndex].inputs) ? seqSelected[seqInputsEditIndex].inputs : [];
  const next = original.map(function (inp) {
    return Object.assign({}, inp);
  });
  document.querySelectorAll('#seq-inputs-modal .seq-input-edit').forEach(function (el) {
    const idx = Number(el.getAttribute('data-index'));
    const className = el.getAttribute('data-class') || '';
    if (!Number.isFinite(idx) || !next[idx]) return;
    next[idx].value = parseEditableInputValue(el.value, className);
  });
  return next;
}

async function saveSeqInputsModal() {
  if (seqInputsEditIndex < 0 || seqInputsEditIndex >= seqSelected.length) {
    closeSeqInputsModal();
    return;
  }
  try {
    seqSelected[seqInputsEditIndex].inputs = collectSeqInputsModalValues();
  } catch (e) {
    showSeqMsg('入参格式错误: ' + e.message, false);
    return;
  }
  const ok = await saveQueue();
  if (ok) {
    closeSeqInputsModal();
    showSeqMsg('步骤入参已保存', true);
  }
}

async function addToQueue(template) {
  const templateId = template.id;
  if (!templateId) {
    showSeqMsg('模板缺少 ID', false);
    return;
  }
  const newItem = {
    template_source: template._source === 'general' ? 'general' : 'labview',
    vi_template_id: template._source === 'general' ? null : templateId,
    general_template_id: template._source === 'general' ? templateId : null,
    name: template.name || templateId,
    kind: template.kind || 'labview',
    vi_path: template.vi_path || '',
    inputs: template.inputs || [],
    enabled: true,
    breakpoint: false,
    fail_policy: 'stop',
    limits: [],
    note: '',
  };
  const at = insertIndexForNewStep();
  seqSelected.splice(at, 0, newItem);
  seqFocusIndex = at;
  renderSeqSelected();
  await saveQueue();
}

async function removeFromQueue(index) {
  seqSelected.splice(index, 1);
  if (seqFocusIndex === index) seqFocusIndex = null;
  else if (seqFocusIndex != null && seqFocusIndex > index) seqFocusIndex -= 1;
  const nextChecked = {};
  Object.keys(seqCheckedIndexes).forEach(function (k) {
    const i = parseInt(k, 10);
    if (!seqCheckedIndexes[k] || i === index) return;
    nextChecked[i > index ? i - 1 : i] = true;
  });
  seqCheckedIndexes = nextChecked;
  renderSeqSelected();
  await saveQueue();
}

function moveGroupBlock(groupIndex, delta) {
  const end = endOfGroup(groupIndex);
  const len = end - groupIndex;
  const block = seqSelected.slice(groupIndex, end);
  if (delta < 0) {
    if (groupIndex === 0) return false;
    const prev = groupIndex - 1;
    const prevGroup = owningGroupHeaderIndex(prev);
    const insertAt = prevGroup >= 0 && prevGroup < groupIndex ? prevGroup : prev;
    seqSelected.splice(groupIndex, len);
    seqSelected.splice(insertAt, 0, ...block);
    seqFocusIndex = insertAt;
    return true;
  }
  if (end >= seqSelected.length) return false;
  if (isSeqGroupItem(seqSelected[end])) {
    const nextEnd = endOfGroup(end);
    seqSelected.splice(groupIndex, len);
    const afterNext = groupIndex + (nextEnd - end);
    seqSelected.splice(afterNext, 0, ...block);
    seqFocusIndex = afterNext;
    return true;
  }
  const insertAt = groupIndex + 1;
  seqSelected.splice(groupIndex, len);
  seqSelected.splice(insertAt, 0, ...block);
  seqFocusIndex = insertAt;
  return true;
}

async function moveQueueItem(index, delta) {
  if (isSeqGroupItem(seqSelected[index])) {
    if (!moveGroupBlock(index, delta)) return;
    renderSeqSelected();
    await saveQueue();
    return;
  }
  const newIndex = index + delta;
  if (newIndex < 0 || newIndex >= seqSelected.length) return;
  // Moving a step onto a group header from below would nest incorrectly if we only swap:
  // allow simple adjacent swap; membership follows positional owning group.
  const item = seqSelected.splice(index, 1)[0];
  seqSelected.splice(newIndex, 0, item);
  seqFocusIndex = newIndex;
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
  if (isSeqGroupItem(seqSelected[seqDragIndex])) {
    const end = endOfGroup(seqDragIndex);
    document.querySelectorAll('#seq-selected-body tr.seq-row').forEach(function (r) {
      const i = parseInt(r.getAttribute('data-index'), 10);
      if (i > seqDragIndex && i < end) r.classList.add('seq-dragging');
    });
  }
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', String(seqDragIndex));
}

function onSeqDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  const placement = computeSeqDropPlacement(e, e.currentTarget);
  if (!placement) return;
  // Groups cannot nest into other groups.
  if (
    seqDragIndex != null &&
    isSeqGroupItem(seqSelected[seqDragIndex]) &&
    placement.mode === 'into'
  ) {
    clearSeqDropUi();
    return;
  }
  applySeqDropPlacementVisual(placement);
}

function onSeqDragLeave(e) {
  const related = e.relatedTarget;
  if (related && e.currentTarget.contains(related)) return;
  e.currentTarget.classList.remove(
    'seq-drag-over',
    'seq-drop-before',
    'seq-drop-after',
    'seq-drop-after-block',
    'seq-drop-into'
  );
}

async function onSeqDrop(e) {
  e.preventDefault();
  if (seqDragIndex == null || seqRunning || seqPaused) {
    clearSeqDropUi();
    return;
  }
  const placement = seqDropPlacement || computeSeqDropPlacement(e, e.currentTarget);
  clearSeqDropUi();
  if (!placement) return;

  if (isSeqGroupItem(seqSelected[seqDragIndex])) {
    const start = seqDragIndex;
    const end = endOfGroup(start);
    if (placement.index >= start && placement.index < end) return;
    const insertAt = rootInsertIndexFromPlacement(placement);
    if (insertAt == null) return;
    const newFocus = relocateQueueSlice(start, end, insertAt);
    if (newFocus == null) return;
    seqFocusIndex = newFocus;
  } else {
    const start = seqDragIndex;
    if (placement.mode === 'into' && placement.index === owningGroupHeaderIndex(start)) {
      // dropping into own group end — still allow reorder to end
    }
    const insertAt = stepInsertIndexFromPlacement(placement);
    if (insertAt == null) return;
    if (insertAt === start || insertAt === start + 1) {
      // no-op for before self / after self
      if (placement.mode === 'before' && insertAt === start) return;
      if (placement.mode === 'after' && insertAt === start + 1) return;
    }
    const newFocus = relocateQueueSlice(start, start + 1, insertAt);
    if (newFocus == null) return;
    seqFocusIndex = newFocus;
  }
  seqDragIndex = null;
  renderSeqSelected();
  await saveQueue();
}

function onSeqDragEnd(e) {
  document.querySelectorAll('#seq-selected-body tr.seq-dragging').forEach(function (el) {
    el.classList.remove('seq-dragging');
  });
  clearSeqDropUi();
  seqDragIndex = null;
}

function renderSeqResults(data) {
  const container = document.getElementById('seq-results');
  if (!container) return;
  container.innerHTML = '';
  if (!data || !data.steps || !data.steps.length) {
    container.hidden = true;
    return;
  }
  container.hidden = false;
  container.textContent = '本次共 ' + data.steps.length + ' 步结果，已写入步骤行；点「详情」查看实测与原始返回。'
    + ((lastAgentStatus && lastAgentStatus.log_dir)
      ? ('详细日志: ' + lastAgentStatus.log_dir + '\\sequence_runs')
      : '详细日志已写入 Agent 日志目录 sequence_runs');
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

async function saveCurrentQueueAsSequenceTemplate() {
  if (!seqSelected.length) {
    showSeqMsg('当前队列为空，无法保存模板', false);
    return;
  }
  const name = String(window.prompt('请输入序列模板名称') || '').trim();
  if (!name) return;
  const note = String(window.prompt('备注（可选）') || '').trim();
  try {
    const resp = await fetch('/api/sequence-templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name, note: note }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      const err = data.error && (data.error.message || data.error) || resp.status;
      showSeqMsg('保存模板失败: ' + err, false);
      return;
    }
    seqActiveTemplateId = data.id;
    showSeqMsg('已保存序列模板: ' + (data.name || name), true);
    await loadSequenceTemplates();
  } catch (e) {
    showSeqMsg('保存模板失败: ' + e.message, false);
  }
}

async function loadSequenceTemplateToQueue(tpl) {
  try {
    const resp = await fetch('/api/sequence-templates/' + encodeURIComponent(tpl.id) + '/load', {
      method: 'POST',
    });
    const data = await resp.json();
    if (!resp.ok) {
      const err = data.error && (data.error.message || data.error) || resp.status;
      showSeqMsg('加载模板失败: ' + err, false);
      return;
    }
    seqSelected = Array.isArray(data.items) ? data.items : [];
    seqActiveTemplateId = tpl.id;
    seqStepResults = {};
    renderSeqSelected();
    updateSeqOverall({});
    updateSequenceTemplateBinding();
    showSeqMsg('已加载模板: ' + (tpl.name || tpl.id), true);
  } catch (e) {
    showSeqMsg('加载模板失败: ' + e.message, false);
  }
}

async function runSequence() {
  if ((seqRunning && !seqPaused) || !seqSelected.length) return;
  seqPaused = false;
  setSeqControlsDisabled(true);
  clearSequenceResultsUi();
  document.getElementById('seq-results').innerHTML = '';
  showSeqMsg('执行中…', true);
  const snRaw = document.getElementById('seq-sn').value.trim();
  const woRaw = document.getElementById('seq-work-order').value.trim();
  const payload = {};
  if (snRaw) payload.sn = snRaw;
  if (woRaw) payload.work_order = woRaw;
  if (seqActiveTemplateId != null) payload.sequence_template_id = seqActiveTemplateId;
  startSequenceProgressPoll();
  try {
    const resp = await fetch('/api/sequence/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await resp.json();
    if (!resp.ok) {
      if (resp.status === 409) {
        const tip = formatBusyConflictMessage(data);
        if (data.can_continue) {
          seqPaused = true;
          setSeqControlsDisabled(false);
          showSeqMsg(tip + ' — 请点「继续」或「中止」', true);
          return;
        }
        const hint = data.can_force_release ? ' — 可在「机台信息」中强制空闲' : '';
        showSeqMsg(tip + hint, false);
        return;
      }
      const err = data.error && (data.error.message || data.error) || resp.status;
      showSeqMsg('执行失败: ' + err, false);
      return;
    }
    handleSequenceResponse(data);
  } catch (e) {
    showSeqMsg('执行失败: ' + e.message, false);
  } finally {
    stopSequenceProgressPoll();
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
  startSequenceProgressPoll();
  try {
    const resp = await fetch('/api/sequence/run/continue', { method: 'POST' });
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
    stopSequenceProgressPoll();
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
    const resp = await fetch('/api/sequence/run/abort', { method: 'POST' });
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
  const raw = String(document.getElementById('gen-delay-ms').value || '').trim();
  if (!raw) {
    showGenDelayMsg('请输入有效的延迟毫秒数', false);
    return;
  }
  const delayPayload = looksLikeVarToken(raw) ? raw : Number(raw);
  if (typeof delayPayload === 'number' && (!Number.isFinite(delayPayload) || delayPayload < 0)) {
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
      body: JSON.stringify({ delay_ms: typeof delayPayload === 'number' ? Math.round(delayPayload) : delayPayload }),
    });
    const data = await resp.json();
    outEl.textContent = JSON.stringify(data, null, 2);
    if (!resp.ok) {
      const err = data.error && (data.error.message || data.error) || resp.status;
      showGenDelayMsg('试跑失败: ' + err, false);
      return;
    }
    showGenDelayMsg('试跑完成', true);
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
    await fetchGeneralTemplates();
  } catch (e) {
    showGenDelayMsg('注册失败: ' + e.message, false);
  }
}

function showGenVersionMsg(text, ok) {
  const msg = document.getElementById('gen-version-msg');
  if (!msg) return;
  msg.hidden = false;
  msg.textContent = text;
  msg.className = 'msg ' + (ok ? 'ok' : 'err');
}

async function runGeneralVersion() {
  const outEl = document.getElementById('gen-version-out');
  if (outEl) {
    outEl.hidden = false;
    outEl.textContent = '…';
  }
  showGenVersionMsg('试跑中…', true);
  try {
    const resp = await fetch('/api/general/version/run', { method: 'POST' });
    const data = await resp.json();
    if (outEl) outEl.textContent = JSON.stringify(data, null, 2);
    if (!resp.ok) {
      const err = data.error && (data.error.message || data.error) || resp.status;
      showGenVersionMsg('试跑失败: ' + err, false);
      return;
    }
    const ver = data.version != null ? String(data.version) : '';
    const cur = document.getElementById('gen-version-current');
    if (cur && ver) cur.textContent = '当前版本：' + ver;
    showGenVersionMsg('试跑完成' + (ver ? '：' + ver : ''), true);
  } catch (e) {
    if (outEl) outEl.textContent = e.message;
    showGenVersionMsg('试跑失败: ' + e.message, false);
  }
}

async function registerGeneralVersion() {
  const name = String(document.getElementById('gen-version-name').value || '').trim();
  if (!name) {
    showGenVersionMsg('名称不能为空', false);
    return;
  }
  showGenVersionMsg('注册中…', true);
  try {
    const resp = await fetch('/api/general/version/register-template', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      const err = data.error && (data.error.message || data.error) || resp.status;
      showGenVersionMsg('注册失败: ' + err, false);
      return;
    }
    showGenVersionMsg('已注册: ' + (data.name || name) + ' (ID ' + data.id + ')', true);
    await fetchGeneralTemplates();
  } catch (e) {
    showGenVersionMsg('注册失败: ' + e.message, false);
  }
}

function kindLabel(kind) {
  switch ((kind || '').toLowerCase()) {
    case 'delay': return '延迟';
    case 'version': return '版本号';
    case 'rest': return 'REST';
    case 'labview': return 'VI';
    case 'group': return '分组';
    default: return escapeHtml(kind || '通用');
  }
}

let apiLastResponse = null;
let apiHeadersMode = 'kv'; // 'kv' | 'json'

function showApiMsg(text, ok) {
  const msg = document.getElementById('api-msg');
  if (!msg) return;
  msg.hidden = false;
  msg.textContent = text;
  msg.className = 'msg ' + (ok ? 'ok' : 'err');
}

function clearApiMsg() {
  const msg = document.getElementById('api-msg');
  if (!msg) return;
  msg.hidden = true;
  msg.textContent = '';
}

function hideAppAlert() {
  const modal = document.getElementById('app-alert-modal');
  if (modal) modal.hidden = true;
}

function showAppAlert(message, title) {
  const modal = document.getElementById('app-alert-modal');
  const titleEl = document.getElementById('app-alert-title');
  const bodyEl = document.getElementById('app-alert-body');
  const okBtn = document.getElementById('app-alert-ok-btn');
  if (!modal || !titleEl || !bodyEl) {
    window.alert(message);
    return;
  }
  titleEl.textContent = title || '提示';
  bodyEl.textContent = message || '';
  modal.hidden = false;
  if (okBtn) okBtn.focus();
}

function showApiCenterMsg(text, ok) {
  const msg = document.getElementById('api-center-msg');
  if (!msg) return;
  msg.hidden = false;
  msg.textContent = text;
  msg.className = 'msg ' + (ok ? 'ok' : 'err');
}

function apiValueToFormText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value, null, 2);
  } catch (e) {
    return String(value);
  }
}

function apiInputValue(inputs, name) {
  if (inputs && typeof inputs === 'object' && !Array.isArray(inputs)) {
    if (!Object.prototype.hasOwnProperty.call(inputs, name)) return null;
    return apiValueToFormText(inputs[name]);
  }
  if (!Array.isArray(inputs)) return null;
  for (let i = 0; i < inputs.length; i++) {
    if (inputs[i] && inputs[i].name === name) {
      return inputs[i].value != null ? apiValueToFormText(inputs[i].value) : '';
    }
  }
  return null;
}

function setJsonStatus(el, text, state) {
  if (!el) return;
  el.textContent = text;
  el.className = 'api-json-status' + (state ? ' is-' + state : '');
}

function parseJsonObjectText(raw, allowEmptyObject) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) {
    if (allowEmptyObject) return { ok: true, value: {} };
    return { ok: false, error: '不能为空' };
  }
  try {
    const value = JSON.parse(trimmed);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, error: '必须是 JSON object（{ ... }）' };
    }
    return { ok: true, value: value };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function parseJsonValueText(raw, allowEmpty) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) {
    if (allowEmpty) return { ok: true, value: null, empty: true };
    return { ok: false, error: '不能为空' };
  }
  try {
    return { ok: true, value: JSON.parse(trimmed), empty: false };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function headersObjectFromKv() {
  const rows = document.querySelectorAll('#api-headers-kv-body .api-kv-row');
  const obj = {};
  for (let i = 0; i < rows.length; i++) {
    const nameInput = rows[i].querySelector('[data-api-header-name]');
    const valueInput = rows[i].querySelector('[data-api-header-value]');
    const name = String(nameInput && nameInput.value || '').trim();
    if (!name) continue;
    obj[name] = String(valueInput && valueInput.value || '');
  }
  return obj;
}

function syncHeadersTextareaFromKv() {
  const el = document.getElementById('api-headers');
  if (!el) return;
  el.value = JSON.stringify(headersObjectFromKv(), null, 2);
  refreshHeadersJsonStatus();
}

function addApiHeaderRow(name, value) {
  const body = document.getElementById('api-headers-kv-body');
  if (!body) return;
  const row = document.createElement('div');
  row.className = 'api-kv-row';
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.setAttribute('data-api-header-name', '1');
  nameInput.setAttribute('aria-label', 'Header 名称');
  nameInput.placeholder = '名称';
  nameInput.value = name || '';
  nameInput.spellcheck = false;
  const valueInput = document.createElement('input');
  valueInput.type = 'text';
  valueInput.setAttribute('data-api-header-value', '1');
  valueInput.setAttribute('aria-label', 'Header 值');
  valueInput.placeholder = '值';
  valueInput.value = value || '';
  valueInput.spellcheck = false;
  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'btn-sm api-kv-remove';
  removeBtn.setAttribute('aria-label', '删除该 Header');
  removeBtn.textContent = '×';
  removeBtn.addEventListener('click', function () {
    row.remove();
    if (!document.querySelectorAll('#api-headers-kv-body .api-kv-row').length) {
      addApiHeaderRow('', '');
    }
    syncHeadersTextareaFromKv();
  });
  nameInput.addEventListener('input', syncHeadersTextareaFromKv);
  valueInput.addEventListener('input', syncHeadersTextareaFromKv);
  row.appendChild(nameInput);
  row.appendChild(valueInput);
  row.appendChild(removeBtn);
  body.appendChild(row);
}

function renderHeadersKvFromObject(obj) {
  const body = document.getElementById('api-headers-kv-body');
  if (!body) return;
  body.innerHTML = '';
  const entries = obj && typeof obj === 'object' && !Array.isArray(obj) ? Object.keys(obj) : [];
  if (!entries.length) {
    addApiHeaderRow('', '');
    return;
  }
  for (let i = 0; i < entries.length; i++) {
    const key = entries[i];
    const val = obj[key];
    addApiHeaderRow(key, val == null ? '' : String(val));
  }
}

function refreshHeadersJsonStatus() {
  const el = document.getElementById('api-headers');
  const status = document.getElementById('api-headers-status');
  if (!el) return;
  const parsed = parseJsonObjectText(el.value, true);
  el.classList.remove('api-json-invalid', 'api-json-valid');
  if (parsed.ok) {
    const n = Object.keys(parsed.value).length;
    el.classList.add('api-json-valid');
    setJsonStatus(status, n ? ('合法 JSON object · ' + n + ' 项') : '合法 JSON object · 空', 'ok');
    return true;
  }
  el.classList.add('api-json-invalid');
  setJsonStatus(status, 'JSON 无效: ' + parsed.error, 'err');
  return false;
}

function setApiHeadersMode(mode) {
  apiHeadersMode = mode === 'json' ? 'json' : 'kv';
  const kv = document.getElementById('api-headers-kv');
  const ta = document.getElementById('api-headers');
  const addBtn = document.getElementById('api-headers-add-btn');
  const formatBtn = document.getElementById('api-headers-format-btn');
  const minifyBtn = document.getElementById('api-headers-minify-btn');
  document.querySelectorAll('[data-api-headers-mode]').forEach(function (btn) {
    btn.classList.toggle('active', btn.getAttribute('data-api-headers-mode') === apiHeadersMode);
  });
  if (apiHeadersMode === 'kv') {
    const parsed = parseJsonObjectText(ta.value, true);
    if (!parsed.ok) {
      showApiMsg('Headers JSON 无效，无法切换到键值模式: ' + parsed.error, false);
      apiHeadersMode = 'json';
      document.querySelectorAll('[data-api-headers-mode]').forEach(function (btn) {
        btn.classList.toggle('active', btn.getAttribute('data-api-headers-mode') === 'json');
      });
      return;
    }
    renderHeadersKvFromObject(parsed.value);
    if (kv) kv.hidden = false;
    if (ta) ta.hidden = true;
    if (addBtn) addBtn.hidden = false;
    if (formatBtn) formatBtn.hidden = true;
    if (minifyBtn) minifyBtn.hidden = true;
    syncHeadersTextareaFromKv();
  } else {
    syncHeadersTextareaFromKv();
    if (kv) kv.hidden = true;
    if (ta) ta.hidden = false;
    if (addBtn) addBtn.hidden = true;
    if (formatBtn) formatBtn.hidden = false;
    if (minifyBtn) minifyBtn.hidden = false;
    refreshHeadersJsonStatus();
  }
}

function getApiHeadersJsonText() {
  if (apiHeadersMode === 'kv') syncHeadersTextareaFromKv();
  const el = document.getElementById('api-headers');
  return String(el && el.value || '').trim() || '{}';
}

function setApiHeadersFromText(raw) {
  const el = document.getElementById('api-headers');
  const parsed = parseJsonObjectText(raw, true);
  if (parsed.ok) {
    el.value = JSON.stringify(parsed.value, null, 2);
    renderHeadersKvFromObject(parsed.value);
  } else {
    el.value = String(raw || '').trim() || '{}';
  }
  refreshHeadersJsonStatus();
  if (apiHeadersMode === 'kv' && !parsed.ok) {
    setApiHeadersMode('json');
  } else {
    setApiHeadersMode(apiHeadersMode);
  }
}

function refreshBodyJsonStatus() {
  const el = document.getElementById('api-body');
  const status = document.getElementById('api-body-status');
  const method = String(document.getElementById('api-method').value || 'POST').toUpperCase();
  if (!el) return true;
  const parsed = parseJsonValueText(el.value, true);
  el.classList.remove('api-json-invalid', 'api-json-valid');
  if (parsed.empty) {
    const needs = method === 'POST' || method === 'PUT' || method === 'PATCH';
    setJsonStatus(status, needs ? '空（允许）；发送时不带 body' : '空', '');
    return true;
  }
  if (parsed.ok) {
    el.classList.add('api-json-valid');
    const kind = Array.isArray(parsed.value)
      ? 'array'
      : (parsed.value === null ? 'null' : typeof parsed.value);
    setJsonStatus(status, '合法 JSON · ' + kind, 'ok');
    return true;
  }
  el.classList.add('api-json-invalid');
  setJsonStatus(status, 'JSON 无效: ' + parsed.error, 'err');
  return false;
}

function formatJsonTextarea(el, allowEmpty, minify) {
  const raw = String(el.value || '').trim();
  if (!raw) {
    if (allowEmpty) {
      el.value = '';
      return true;
    }
    el.value = minify ? '{}' : '{\n}';
    return true;
  }
  try {
    const value = JSON.parse(raw);
    el.value = minify ? JSON.stringify(value) : JSON.stringify(value, null, 2);
    return true;
  } catch (e) {
    showApiMsg('JSON 无效: ' + e.message, false);
    return false;
  }
}

function validateApiBodyForMethod(method, body) {
  if (method !== 'POST' && method !== 'PUT' && method !== 'PATCH') {
    refreshBodyJsonStatus();
    return true;
  }
  const parsed = parseJsonValueText(body, true);
  if (parsed.ok) {
    refreshBodyJsonStatus();
    return true;
  }
  showApiMsg('Body 必须是合法 JSON: ' + parsed.error, false);
  refreshBodyJsonStatus();
  return false;
}

function bindJsonTextareaHelpers(el, onChange) {
  if (!el) return;
  el.addEventListener('input', onChange);
  el.addEventListener('keydown', function (event) {
    if (event.key !== 'Tab' || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) {
      return;
    }
    event.preventDefault();
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const value = el.value;
    el.value = value.slice(0, start) + '  ' + value.slice(end);
    el.selectionStart = el.selectionEnd = start + 2;
    onChange();
  });
}

function readApiForm() {
  return {
    name: String(document.getElementById('api-name').value || '').trim(),
    method: String(document.getElementById('api-method').value || 'POST').toUpperCase(),
    url: String(document.getElementById('api-url').value || '').trim(),
    headers: getApiHeadersJsonText(),
    body: String(document.getElementById('api-body').value || ''),
    timeout_ms: Number(document.getElementById('api-timeout').value),
    expect_status: Number(document.getElementById('api-expect-status').value),
  };
}

function fillApiFormFromTemplate(t) {
  document.getElementById('api-name').value = t.name || '';
  const method = (apiInputValue(t.inputs, 'method') || 'POST').toUpperCase();
  const methodEl = document.getElementById('api-method');
  methodEl.value = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].indexOf(method) >= 0 ? method : 'POST';
  document.getElementById('api-url').value = apiInputValue(t.inputs, 'url') || '';
  setApiHeadersFromText(apiInputValue(t.inputs, 'headers') || '{}');
  const body = apiInputValue(t.inputs, 'body') || '';
  document.getElementById('api-body').value = body;
  if (body.trim()) formatJsonTextarea(document.getElementById('api-body'), true, false);
  refreshBodyJsonStatus();
  const timeout = apiInputValue(t.inputs, 'timeout_ms');
  document.getElementById('api-timeout').value = timeout != null && timeout !== '' ? timeout : '10000';
  const expectStatus = apiInputValue(t.inputs, 'expect_status');
  document.getElementById('api-expect-status').value =
    expectStatus != null && expectStatus !== '' ? expectStatus : '200';
}

function setApiEditorTab(tab) {
  const which = tab === 'headers' ? 'headers' : 'body';
  document.querySelectorAll('[data-api-editor-tab]').forEach(function (btn) {
    const active = btn.getAttribute('data-api-editor-tab') === which;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  const headersPanel = document.getElementById('api-headers-panel');
  const bodyPanel = document.getElementById('api-body-panel');
  const headersActions = document.getElementById('api-headers-actions');
  const bodyActions = document.getElementById('api-body-actions');
  if (headersPanel) headersPanel.hidden = which !== 'headers';
  if (bodyPanel) bodyPanel.hidden = which !== 'body';
  if (headersActions) headersActions.hidden = which !== 'headers';
  if (bodyActions) bodyActions.hidden = which !== 'body';
}

function renderApiResponse(data) {
  apiLastResponse = data;
  const box = document.getElementById('api-response');
  if (box) box.hidden = false;
  document.getElementById('api-resp-status').textContent =
    data && data.status != null ? String(data.status) : '—';
  document.getElementById('api-resp-elapsed').textContent =
    data && data.elapsed_ms != null ? (data.elapsed_ms + ' ms') : '';
  const okEl = document.getElementById('api-resp-ok');
  if (data && data.ok === true) {
    okEl.textContent = 'ok';
    okEl.className = 'msg ok';
  } else if (data && data.ok === false) {
    okEl.textContent = data.error || 'fail';
    okEl.className = 'msg err';
  } else {
    okEl.textContent = '';
    okEl.className = 'muted-hint';
  }
  let bodyText = '试跑后显示返回';
  if (data && data.body_json != null) {
    try {
      bodyText = JSON.stringify(data.body_json, null, 2);
    } catch (e) {
      bodyText = String(data.body || '');
    }
  } else if (data && data.body != null) {
    bodyText = String(data.body);
  } else if (data) {
    bodyText = JSON.stringify(data, null, 2);
  }
  document.getElementById('api-resp-body').textContent = bodyText;
}

async function runRestRequest() {
  const form = readApiForm();
  if (!form.url) {
    showApiMsg('URL 不能为空', false);
    return;
  }
  if (!Number.isFinite(form.timeout_ms) || form.timeout_ms <= 0) {
    showApiMsg('请输入有效的超时毫秒数', false);
    return;
  }
  if (!Number.isFinite(form.expect_status) || form.expect_status < 100) {
    showApiMsg('请输入有效的期望状态码', false);
    return;
  }
  const headersParsed = parseJsonObjectText(form.headers, true);
  if (!headersParsed.ok) {
    showApiMsg('Headers 必须是 JSON object: ' + headersParsed.error, false);
    refreshHeadersJsonStatus();
    return;
  }
  form.headers = JSON.stringify(headersParsed.value);
  if (!validateApiBodyForMethod(form.method, form.body)) return;

  showApiMsg('试跑中…', true);
  try {
    const resp = await fetch('/api/general/rest/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: form.method,
        url: form.url,
        headers: form.headers,
        body: form.body,
        timeout_ms: Math.round(form.timeout_ms),
        expect_status: Math.round(form.expect_status),
      }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      const err = data.error && (data.error.message || data.error) || resp.status;
      renderApiResponse(data);
      showApiMsg('试跑失败: ' + err, false);
      return;
    }
    renderApiResponse(data);
    showApiMsg(
      data.ok ? ('试跑完成 HTTP ' + data.status) : ('试跑完成但未达期望状态码: ' + (data.error || data.status)),
      !!data.ok
    );
  } catch (e) {
    showApiMsg('试跑失败: ' + e.message, false);
  }
}

async function registerRestTemplate() {
  const form = readApiForm();
  if (!form.name) {
    showApiMsg('名称不能为空', false);
    return;
  }
  if (!form.url) {
    showApiMsg('URL 不能为空', false);
    return;
  }
  if (!Number.isFinite(form.timeout_ms) || form.timeout_ms <= 0) {
    showApiMsg('请输入有效的超时毫秒数', false);
    return;
  }
  if (!Number.isFinite(form.expect_status) || form.expect_status < 100) {
    showApiMsg('请输入有效的期望状态码', false);
    return;
  }
  const headersParsed = parseJsonObjectText(form.headers, true);
  if (!headersParsed.ok) {
    showApiMsg('Headers 必须是 JSON object: ' + headersParsed.error, false);
    refreshHeadersJsonStatus();
    return;
  }
  form.headers = JSON.stringify(headersParsed.value);
  if (!validateApiBodyForMethod(form.method, form.body)) return;

  // outputs_json = trial response body JSON (e.g. {"a":10,"result":15}), not REST wrapper.
  let outputs = {};
  if (apiLastResponse && apiLastResponse.body_json != null) {
    if (
      typeof apiLastResponse.body_json !== 'object' ||
      Array.isArray(apiLastResponse.body_json)
    ) {
      showApiMsg('请先试跑并得到 JSON object 响应体，再注册（outputs 需为对象）', false);
      return;
    }
    outputs = apiLastResponse.body_json;
  } else {
    showApiMsg('请先试跑成功后再注册（需用响应 body 作为 outputs）', false);
    return;
  }

  showApiMsg('注册中…', true);
  try {
    const resp = await fetch('/api/general/rest/register-template', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: form.name,
        method: form.method,
        url: form.url,
        headers: form.headers,
        body: form.body,
        timeout_ms: Math.round(form.timeout_ms),
        expect_status: Math.round(form.expect_status),
        outputs: outputs,
      }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      const err = data.error && (data.error.message || data.error) || resp.status;
      showApiMsg('注册失败: ' + err, false);
      return;
    }
    clearApiMsg();
    showAppAlert('已注册: ' + (data.name || form.name) + ' (ID ' + data.id + ')', '注册成功');
    await fetchRestTemplates();
  } catch (e) {
    showApiMsg('注册失败: ' + e.message, false);
  }
}

function renderRestTemplates(templates) {
  const tbody = document.getElementById('api-center-body');
  if (!tbody) return;
  tbody.innerHTML = '';
  if (!templates || templates.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty">暂无 REST 模板</td></tr>';
    return;
  }
  for (let i = 0; i < templates.length; i++) {
    const t = templates[i];
    const method = apiInputValue(t.inputs, 'method') || '—';
    const row = document.createElement('tr');
    row.innerHTML =
      '<td class="mono">' + escapeHtml(String(t.id ?? '—')) + '</td>' +
      '<td>' + escapeHtml(t.name || '—') + '</td>' +
      '<td class="mono">' + escapeHtml(String(method).toUpperCase()) + '</td>' +
      '<td>' + escapeHtml(t.origin_agent_name || '—') + '</td>';
    const actions = document.createElement('td');
    const loadBtn = document.createElement('button');
    loadBtn.type = 'button';
    loadBtn.textContent = '加载到编辑区';
    loadBtn.addEventListener('click', function () {
      fillApiFormFromTemplate(t);
      showApiMsg('已加载到编辑区: ' + (t.name || t.id), true);
    });
    actions.appendChild(loadBtn);
    row.appendChild(actions);
    tbody.appendChild(row);
  }
}

async function fetchRestTemplates() {
  const tbody = document.getElementById('api-center-body');
  if (!tbody) return;
  try {
    const resp = await fetch('/api/general/rest/templates');
    const data = await resp.json();
    if (!resp.ok) {
      const err = data.error && (data.error.message || data.error) || resp.status;
      tbody.innerHTML = '<tr><td colspan="5" class="empty">加载失败: ' + escapeHtml(String(err)) + '</td></tr>';
      return;
    }
    renderRestTemplates(Array.isArray(data) ? data : []);
  } catch (e) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty">加载失败: ' + escapeHtml(e.message) + '</td></tr>';
  }
}

function renderGeneralTemplates(templates) {
  const tbody = document.getElementById('gen-center-body');
  if (!tbody) return;
  tbody.innerHTML = '';
  // 通用页只展示非 REST（REST 在 REST 页模板列表）
  const list = (templates || []).filter(function (t) {
    return (t.kind || '').toLowerCase() !== 'rest';
  });
  if (!list.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty">暂无已注册通用功能</td></tr>';
    return;
  }
  for (let i = 0; i < list.length; i++) {
    const t = list[i];
    const row = document.createElement('tr');
    row.innerHTML =
      '<td class="mono">' + escapeHtml(String(t.id ?? '—')) + '</td>' +
      '<td><span class="kind-badge kind-general">' + kindLabel(t.kind) + '</span></td>' +
      '<td>' + escapeHtml(t.name || '—') + '</td>' +
      '<td>' + escapeHtml(t.origin_agent_name || '—') + '</td>';
    const actions = document.createElement('td');
    const kind = (t.kind || '').toLowerCase();
    if (kind === 'delay') {
      const loadBtn = document.createElement('button');
      loadBtn.type = 'button';
      loadBtn.textContent = '加载到编辑区';
      loadBtn.addEventListener('click', function () {
        document.getElementById('gen-delay-name').value = t.name || '';
        const dms = delayMsFromInputs(t.inputs);
        document.getElementById('gen-delay-ms').value = dms != null ? String(dms) : '1000';
        showGenDelayMsg('已加载到编辑区: ' + (t.name || t.id), true);
      });
      actions.appendChild(loadBtn);
    } else if (kind === 'version') {
      const loadBtn = document.createElement('button');
      loadBtn.type = 'button';
      loadBtn.textContent = '加载到编辑区';
      loadBtn.addEventListener('click', function () {
        document.getElementById('gen-version-name').value = t.name || '读取 Agent 版本';
        showGenVersionMsg('已加载到编辑区: ' + (t.name || t.id), true);
      });
      actions.appendChild(loadBtn);
    }
    row.appendChild(actions);
    tbody.appendChild(row);
  }
}

async function fetchGeneralTemplates() {
  const tbody = document.getElementById('gen-center-body');
  if (!tbody) return;
  try {
    const resp = await fetch('/api/general/all-templates');
    const data = await resp.json();
    if (!resp.ok) {
      const err = data.error && (data.error.message || data.error) || resp.status;
      tbody.innerHTML = '<tr><td colspan="5" class="empty">加载失败: ' + escapeHtml(String(err)) + '</td></tr>';
      return;
    }
    renderGeneralTemplates(Array.isArray(data) ? data : []);
  } catch (e) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty">加载失败: ' + escapeHtml(e.message) + '</td></tr>';
  }
}

document.getElementById('seq-run-btn').addEventListener('click', runSequence);
const seqInsertGroupBtn = document.getElementById('seq-insert-group');
if (seqInsertGroupBtn) seqInsertGroupBtn.addEventListener('click', insertSeqGroup);
const seqGroupSelectedBtn = document.getElementById('seq-group-selected');
if (seqGroupSelectedBtn) seqGroupSelectedBtn.addEventListener('click', groupCheckedIntoFolder);
const forceReleaseBtn = document.getElementById('force-release-btn');
if (forceReleaseBtn) forceReleaseBtn.addEventListener('click', forceReleaseSlot);
const seqSaveTemplateBtn = document.getElementById('seq-save-template-btn');
if (seqSaveTemplateBtn) seqSaveTemplateBtn.addEventListener('click', saveCurrentQueueAsSequenceTemplate);
const seqContinueBtn = document.getElementById('seq-continue-btn');
const seqAbortBtn = document.getElementById('seq-abort-btn');
if (seqContinueBtn) seqContinueBtn.addEventListener('click', continueSequence);
if (seqAbortBtn) seqAbortBtn.addEventListener('click', abortSequence);
const seqRegisteredSearch = document.getElementById('seq-registered-search');
const seqRegisteredFilter = document.getElementById('seq-registered-filter');
if (seqRegisteredSearch) {
  seqRegisteredSearch.addEventListener('input', function () {
    seqRegisteredQuery = seqRegisteredSearch.value || '';
    renderSeqRegistered();
  });
}
if (seqRegisteredFilter) {
  seqRegisteredFilter.addEventListener('change', function () {
    seqRegisteredSource = seqRegisteredFilter.value || 'all';
    renderSeqRegistered();
  });
}

fetchStatus();
loadLabviewConfig();
refreshTemplateLists();
const genRunBtn = document.getElementById('gen-delay-run-btn');
const genRegBtn = document.getElementById('gen-delay-register-btn');
if (genRunBtn) genRunBtn.addEventListener('click', runGeneralDelay);
if (genRegBtn) genRegBtn.addEventListener('click', registerGeneralDelay);
const genVersionRunBtn = document.getElementById('gen-version-run-btn');
const genVersionRegBtn = document.getElementById('gen-version-register-btn');
if (genVersionRunBtn) genVersionRunBtn.addEventListener('click', runGeneralVersion);
if (genVersionRegBtn) genVersionRegBtn.addEventListener('click', registerGeneralVersion);
const apiRunBtn = document.getElementById('api-run-btn');
const apiRegBtn = document.getElementById('api-register-btn');
const apiHeadersAddBtn = document.getElementById('api-headers-add-btn');
const apiHeadersFormatBtn = document.getElementById('api-headers-format-btn');
const apiHeadersMinifyBtn = document.getElementById('api-headers-minify-btn');
const apiBodyFormatBtn = document.getElementById('api-body-format-btn');
const apiBodyMinifyBtn = document.getElementById('api-body-minify-btn');
const apiBodyValidateBtn = document.getElementById('api-body-validate-btn');
const apiBodySampleBtn = document.getElementById('api-body-sample-btn');
const apiMethodEl = document.getElementById('api-method');
const apiHeadersEl = document.getElementById('api-headers');
const apiBodyEl = document.getElementById('api-body');
if (apiRunBtn) apiRunBtn.addEventListener('click', runRestRequest);
if (apiRegBtn) apiRegBtn.addEventListener('click', registerRestTemplate);
document.querySelectorAll('[data-api-editor-tab]').forEach(function (btn) {
  btn.addEventListener('click', function () {
    setApiEditorTab(btn.getAttribute('data-api-editor-tab'));
  });
});
setApiEditorTab('body');
document.querySelectorAll('[data-api-headers-mode]').forEach(function (btn) {
  btn.addEventListener('click', function () {
    setApiHeadersMode(btn.getAttribute('data-api-headers-mode'));
  });
});
if (apiHeadersAddBtn) {
  apiHeadersAddBtn.addEventListener('click', function () {
    addApiHeaderRow('', '');
    syncHeadersTextareaFromKv();
  });
}
if (apiHeadersFormatBtn) {
  apiHeadersFormatBtn.addEventListener('click', function () {
    if (formatJsonTextarea(apiHeadersEl, false, false)) {
      refreshHeadersJsonStatus();
      showApiMsg('Headers 已格式化', true);
    } else {
      refreshHeadersJsonStatus();
    }
  });
}
if (apiHeadersMinifyBtn) {
  apiHeadersMinifyBtn.addEventListener('click', function () {
    if (formatJsonTextarea(apiHeadersEl, false, true)) {
      refreshHeadersJsonStatus();
      showApiMsg('Headers 已压缩', true);
    } else {
      refreshHeadersJsonStatus();
    }
  });
}
if (apiBodyFormatBtn) {
  apiBodyFormatBtn.addEventListener('click', function () {
    if (formatJsonTextarea(apiBodyEl, true, false)) {
      refreshBodyJsonStatus();
      showApiMsg('Body 已格式化', true);
    } else {
      refreshBodyJsonStatus();
    }
  });
}
if (apiBodyMinifyBtn) {
  apiBodyMinifyBtn.addEventListener('click', function () {
    if (formatJsonTextarea(apiBodyEl, true, true)) {
      refreshBodyJsonStatus();
      showApiMsg('Body 已压缩', true);
    } else {
      refreshBodyJsonStatus();
    }
  });
}
if (apiBodyValidateBtn) {
  apiBodyValidateBtn.addEventListener('click', function () {
    const method = String((apiMethodEl && apiMethodEl.value) || 'POST').toUpperCase();
    const body = apiBodyEl ? apiBodyEl.value : '';
    if (validateApiBodyForMethod(method, body)) {
      showApiMsg(String(body || '').trim() ? 'Body JSON 合法' : 'Body 为空（允许）', true);
    }
  });
}
if (apiBodySampleBtn) {
  apiBodySampleBtn.addEventListener('click', function () {
    if (apiBodyEl && String(apiBodyEl.value || '').trim()) {
      if (!window.confirm('当前 Body 非空，是否用示例覆盖？')) return;
    }
    if (apiBodyEl) {
      apiBodyEl.value = JSON.stringify({ key: 'value', count: 1 }, null, 2);
      refreshBodyJsonStatus();
      showApiMsg('已填入 Body JSON 示例', true);
    }
  });
}
if (apiMethodEl) apiMethodEl.addEventListener('change', refreshBodyJsonStatus);
bindJsonTextareaHelpers(apiHeadersEl, refreshHeadersJsonStatus);
bindJsonTextareaHelpers(apiBodyEl, refreshBodyJsonStatus);
if (document.getElementById('api-headers-kv-body')) {
  setApiHeadersFromText('{}');
  setApiHeadersMode('kv');
  refreshBodyJsonStatus();
}
const seqInputsCancelBtn = document.getElementById('seq-inputs-cancel-btn');
const seqInputsSaveBtn = document.getElementById('seq-inputs-save-btn');
if (seqInputsCancelBtn) seqInputsCancelBtn.addEventListener('click', closeSeqInputsModal);
if (seqInputsSaveBtn) seqInputsSaveBtn.addEventListener('click', saveSeqInputsModal);
const appAlertOkBtn = document.getElementById('app-alert-ok-btn');
if (appAlertOkBtn) appAlertOkBtn.addEventListener('click', hideAppAlert);
const appAlertModal = document.getElementById('app-alert-modal');
if (appAlertModal) {
  appAlertModal.addEventListener('click', function (ev) {
    if (ev.target === appAlertModal) hideAppAlert();
  });
}

const settingsSaveBtn = document.getElementById('settings-save-btn');
const settingsUnitAddBtn = document.getElementById('settings-unit-add-btn');
const settingsVarAddBtn = document.getElementById('settings-var-add-btn');
const settingsRestoreUnitsBtn = document.getElementById('settings-restore-units-btn');
const settingsImportDeviceCfgBtn = document.getElementById('settings-import-device-cfg-btn');
const settingsDeviceCfgFile = document.getElementById('settings-device-cfg-file');
const deviceCfgImportCancelBtn = document.getElementById('device-cfg-import-cancel-btn');
const deviceCfgImportApplyBtn = document.getElementById('device-cfg-import-apply-btn');
if (settingsSaveBtn) settingsSaveBtn.addEventListener('click', saveAgentSettings);
if (settingsUnitAddBtn) settingsUnitAddBtn.addEventListener('click', addSettingsUnit);
if (settingsVarAddBtn) settingsVarAddBtn.addEventListener('click', addSettingsVar);
if (settingsRestoreUnitsBtn) settingsRestoreUnitsBtn.addEventListener('click', restoreDefaultUnits);
if (settingsImportDeviceCfgBtn && settingsDeviceCfgFile) {
  settingsImportDeviceCfgBtn.addEventListener('click', function () {
    settingsDeviceCfgFile.value = '';
    settingsDeviceCfgFile.click();
  });
  settingsDeviceCfgFile.addEventListener('change', function () {
    const file = settingsDeviceCfgFile.files && settingsDeviceCfgFile.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function () {
      openDeviceCfgImportPreview(String(reader.result || ''));
    };
    reader.onerror = function () {
      showSettingsMsg('读取文件失败', false);
    };
    reader.readAsText(file);
  });
}
if (deviceCfgImportCancelBtn) {
  deviceCfgImportCancelBtn.addEventListener('click', closeDeviceCfgImportModal);
}
if (deviceCfgImportApplyBtn) {
  deviceCfgImportApplyBtn.addEventListener('click', applyDeviceCfgImportPreview);
}
window.addEventListener('beforeunload', function (ev) {
  if (!settingsDirty) return;
  ev.preventDefault();
  ev.returnValue = '';
});
['gen-delay-ms', 'api-url', 'api-headers', 'api-body'].forEach(function (id) {
  const el = document.getElementById(id);
  if (el) attachVarPicker(el);
});
ensureAgentSettingsLoaded();
setInterval(fetchStatus, POLL_MS);

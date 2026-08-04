const POLL_MS = 2000;
let lastAgentStatus = null;
let agentSettings = { units: [], variables: [], array_expand_mode: 'semicolon' };
let centerUnits = [];
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
  const busyText = data.busy ? '● 执行中' : '● 空闲';
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
  const onSeqPage = isSequencePageVisible();
  if (!data.busy && seqRunning) {
    seqRunning = false;
    setSeqControlsDisabled(false);
    return;
  }
  if (data.busy && data.busy_reason === 'sequence' && !seqRunning && onSeqPage) {
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
let pendingProfileImport = null;
let deviceProfiles = [];
let calibrationProfiles = [];
/** @type {{ channel_index: number, name: string, enabled: boolean, overlay: Record<string,string>, id?: string }[]} */
let agentChannels = [];
/** Selected channel_indexes for the next run (null = all enabled). */
let seqSelectedChannelIndexes = null;
/** Latest multi-channel progress/result for channel cards and detail. */
let seqChannelProgress = [];
/** Channel shown in the dedicated detail screen; null keeps the card overview visible. */
let seqActiveDetailChannelIndex = null;

function isSystemVarName(name) {
  return name === 'Hostname' || name === 'IP';
}

/** @deprecated whitelist path kept for optional legacy merge; primary import is full INI → profile */
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
  if (s.charAt(s.length - 1) === '"' && s.indexOf('"') === s.length - 1) {
    s = s.slice(0, -1).trim();
  }
  return s;
}

/** INI `a;b;c` → JSON array (numeric items as numbers); single token stays string/number. */
function coerceIniScalar(token) {
  var t = String(token == null ? '' : token).trim();
  if (t === '') return '';
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(t)) {
    var n = Number(t);
    if (!isNaN(n) && isFinite(n)) return n;
  }
  return t;
}

function coerceIniScalarOrArray(raw) {
  var s = normalizeDeviceCfgValue(raw);
  if (!s && s !== '0') return '';
  if (s.indexOf(';') < 0) return coerceIniScalar(s);
  var parts = s
    .split(';')
    .map(function (p) {
      return String(p).trim();
    })
    .filter(function (p) {
      return p !== '';
    });
  if (parts.length <= 1) return coerceIniScalar(parts.length ? parts[0] : s);
  return parts.map(coerceIniScalar);
}

/** Display / edit form for setting values (arrays → `a;b;c`). */
function settingValueToEditText(value) {
  if (value == null) return '';
  if (Array.isArray(value)) {
    return value
      .map(function (v) {
        return v == null ? '' : String(v);
      })
      .filter(function (v) {
        return v !== '';
      })
      .join(';');
  }
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch (e) {
      return String(value);
    }
  }
  return String(value);
}

function editTextToSettingValue(text) {
  return coerceIniScalarOrArray(text);
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

/** Full INI → nested setting JSON (skip empty; `a;b;c` → array). */
function iniToSettingJson(text) {
  var setting = {};
  var entries = parseDeviceCfgIni(text);
  for (var i = 0; i < entries.length; i++) {
    var e = entries[i];
    var value = coerceIniScalarOrArray(e.value);
    if (value === '' || value == null) continue;
    if (Array.isArray(value) && !value.length) continue;
    var section = e.section || 'Default';
    if (!setting[section]) setting[section] = {};
    setting[section][e.key] = value;
  }
  return { setting: setting, rows: settingToFlatPreviewRows(setting) };
}

var PROFILE_META_DESCRIPTIONS = '__descriptions__';

function isProfileMetaSection(section) {
  return String(section || '').indexOf('__') === 0;
}

/** Minimal TOML subset: [section] + key = "value" | 'value' | bare */
function parseTomlSetting(text) {
  var setting = {};
  var section = '';
  var lines = String(text || '').split(/\r?\n/);
  for (var i = 0; i < lines.length; i++) {
    var rawLine = lines[i];
    var line = rawLine.trim();
    if (!line) continue;
    if (line.charAt(0) === '#' || line.charAt(0) === ';') continue;
    var sec = line.match(/^\[([^\]]+)\]$/);
    if (sec) {
      section = sec[1].trim().replace(/^"|"$/g, '');
      continue;
    }
    var eq = line.indexOf('=');
    if (eq < 0) continue;
    var key = line.slice(0, eq).trim().replace(/^"|"$/g, '');
    var valueRaw = line.slice(eq + 1).trim();
    if (!key) continue;
    var value = valueRaw;
    if (
      (value.charAt(0) === '"' && value.charAt(value.length - 1) === '"') ||
      (value.charAt(0) === "'" && value.charAt(value.length - 1) === "'")
    ) {
      value = value.slice(1, -1);
      value = value
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\r')
        .replace(/\\t/g, '\t')
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\');
    } else {
      // strip inline comment for bare values
      var hash = value.indexOf(' #');
      if (hash >= 0) value = value.slice(0, hash).trim();
      value = value.replace(/^'|'$/g, '');
    }
    value = String(value).trim();
    if (!value && value !== '0') continue;
    var secName = section || 'Default';
    if (!setting[secName]) setting[secName] = {};
    setting[secName][key] = value;
  }
  return setting;
}

function settingToFlatPreviewRows(setting) {
  var rows = [];
  var obj = setting && typeof setting === 'object' ? setting : {};
  var descs =
    obj[PROFILE_META_DESCRIPTIONS] && typeof obj[PROFILE_META_DESCRIPTIONS] === 'object'
      ? obj[PROFILE_META_DESCRIPTIONS]
      : {};
  var sections = Object.keys(obj).sort();
  for (var i = 0; i < sections.length; i++) {
    var section = sections[i];
    if (isProfileMetaSection(section)) continue;
    var keysObj = obj[section];
    if (!keysObj || typeof keysObj !== 'object' || Array.isArray(keysObj)) continue;
    var keys = Object.keys(keysObj).sort();
    for (var j = 0; j < keys.length; j++) {
      var key = keys[j];
      var rawVal = keysObj[key];
      if (rawVal == null) continue;
      if (Array.isArray(rawVal) && !rawVal.length) continue;
      var valueText = settingValueToEditText(rawVal);
      if (!valueText && valueText !== '0') continue;
      var flatName = sanitizeDeviceCfgIdent(section + '_' + key);
      if (!flatName || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(flatName)) continue;
      rows.push({
        section: section,
        key: key,
        value: valueText,
        flatName: flatName,
        description: descs[flatName] || '[' + section + '] ' + key,
      });
    }
  }
  return rows;
}

function tomlToSettingJson(text) {
  var setting = parseTomlSetting(text);
  return { setting: setting, rows: settingToFlatPreviewRows(setting) };
}

function textToSettingJson(text, sourceFilename) {
  var name = String(sourceFilename || '').toLowerCase();
  if (/\.toml$/i.test(name)) return tomlToSettingJson(text);
  // Heuristic: TOML-looking content without classic INI if user picks wrong extension
  var sample = String(text || '').trim();
  if (
    !/\.ini$/i.test(name) &&
    (/^\s*\[[^\]]+\]\s*$/m.test(sample) && /=\s*["']/.test(sample))
  ) {
    return tomlToSettingJson(text);
  }
  return iniToSettingJson(text);
}

function tomlNeedsQuotedKey(key) {
  return !/^[A-Za-z0-9_-]+$/.test(String(key || ''));
}

function escapeTomlBasicString(s) {
  return String(s == null ? '' : s)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\t/g, '\\t')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n');
}

function formatTomlKey(key) {
  var k = String(key == null ? '' : key);
  if (!k) return '""';
  if (tomlNeedsQuotedKey(k)) return '"' + escapeTomlBasicString(k) + '"';
  return k;
}

/** Nested `{ Section: { Key: value } }` → TOML text (string values). */
function settingJsonToToml(setting) {
  var obj = setting && typeof setting === 'object' ? setting : {};
  var sections = Object.keys(obj).sort();
  var lines = [];
  for (var i = 0; i < sections.length; i++) {
    var section = sections[i];
    if (isProfileMetaSection(section)) continue;
    var keysObj = obj[section];
    if (!keysObj || typeof keysObj !== 'object' || Array.isArray(keysObj)) continue;
    if (lines.length) lines.push('');
    lines.push('[' + formatTomlKey(section) + ']');
    var keys = Object.keys(keysObj).sort();
    for (var j = 0; j < keys.length; j++) {
      var key = keys[j];
      var raw = keysObj[key];
      if (raw == null) continue;
      if (Array.isArray(raw)) {
        if (!raw.length) continue;
        var items = raw.map(function (item) {
          if (typeof item === 'number' && isFinite(item)) return String(item);
          return '"' + escapeTomlBasicString(String(item == null ? '' : item)) + '"';
        });
        lines.push(formatTomlKey(key) + ' = [' + items.join(', ') + ']');
        continue;
      }
      var value = typeof raw === 'string' ? raw : String(raw);
      if (!value && value !== '0') continue;
      if (typeof raw === 'number' && isFinite(raw)) {
        lines.push(formatTomlKey(key) + ' = ' + String(raw));
        continue;
      }
      lines.push(formatTomlKey(key) + ' = "' + escapeTomlBasicString(value) + '"');
    }
  }
  return lines.length ? lines.join('\n') + '\n' : '';
}

function sanitizeExportFilename(name) {
  var s = String(name || 'profile')
    .replace(/[<>:"/\\|?*\x00-\x1f]+/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!s) s = 'profile';
  if (s.length > 80) s = s.slice(0, 80);
  return s;
}

function downloadTextFile(filename, text, mime) {
  var blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(function () {
    URL.revokeObjectURL(url);
  }, 1000);
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

function closeDeviceCfgImportModal() {
  const modal = document.getElementById('device-cfg-import-modal');
  if (modal) modal.hidden = true;
  pendingProfileImport = null;
}

function openProfileImportPreview(text, kind, sourceFilename) {
  const parsed = textToSettingJson(text, sourceFilename);
  pendingProfileImport = {
    kind: kind,
    setting: parsed.setting,
    rows: parsed.rows,
    sourceFilename: sourceFilename || '',
  };
  const title = document.getElementById('profile-import-modal-title');
  if (title) {
    title.textContent =
      kind === 'calibration' ? '导入为校准配置档' : '导入为设备配置档';
  }
  const summary = document.getElementById('device-cfg-import-summary');
  if (summary) {
    summary.textContent =
      '将写入 ' +
      parsed.rows.length +
      ' 个键（空值已跳过）；保存为独立配置档，不写入手工变量。';
  }
  const nameInput = document.getElementById('profile-import-name');
  if (nameInput) {
    var base = (sourceFilename || '').replace(/\.ini$/i, '').trim();
    nameInput.value = base || (kind === 'calibration' ? 'Calibration' : 'Device');
  }
  const activateEl = document.getElementById('profile-import-activate');
  if (activateEl) activateEl.checked = true;
  const tbody = document.getElementById('device-cfg-import-body');
  if (tbody) {
    tbody.innerHTML = '';
    if (!parsed.rows.length) {
      tbody.innerHTML = '<tr><td colspan="4" class="empty">没有可导入的键值</td></tr>';
    } else {
      parsed.rows.slice(0, 200).forEach(function (row) {
        const tr = document.createElement('tr');
        tr.innerHTML =
          '<td class="mono">' +
          escapeHtml(row.section) +
          '</td>' +
          '<td class="mono">' +
          escapeHtml(row.key) +
          '</td>' +
          '<td class="mono">' +
          escapeHtml(row.value) +
          '</td>' +
          '<td class="mono">${' +
          escapeHtml(row.flatName) +
          '}</td>';
        tbody.appendChild(tr);
      });
      if (parsed.rows.length > 200) {
        const tr = document.createElement('tr');
        tr.innerHTML =
          '<td colspan="4" class="muted-hint">…另有 ' +
          (parsed.rows.length - 200) +
          ' 行未展示</td>';
        tbody.appendChild(tr);
      }
    }
  }
  const applyBtn = document.getElementById('device-cfg-import-apply-btn');
  if (applyBtn) applyBtn.disabled = !parsed.rows.length;
  const modal = document.getElementById('device-cfg-import-modal');
  if (modal) modal.hidden = false;
}

/** @deprecated use openProfileImportPreview */
function openDeviceCfgImportPreview(text) {
  openProfileImportPreview(text, 'device', '');
}

async function applyDeviceCfgImportPreview() {
  if (!pendingProfileImport || !pendingProfileImport.rows.length) {
    closeDeviceCfgImportModal();
    return;
  }
  const nameEl = document.getElementById('profile-import-name');
  const name = (nameEl && nameEl.value.trim()) || '';
  if (!name) {
    showSettingsMsg('请填写配置档名称', false);
    return;
  }
  const activateEl = document.getElementById('profile-import-activate');
  const activate = !activateEl || activateEl.checked;
  const kind = pendingProfileImport.kind === 'calibration' ? 'calibration' : 'device';
  const apiKind = kind === 'calibration' ? 'calibration-profiles' : 'device-profiles';
  const body = {
    name: name,
    setting: pendingProfileImport.setting,
    source_filename: pendingProfileImport.sourceFilename || '',
    activate: activate,
  };
  try {
    const resp = await fetch('/api/' + apiKind, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await resp.json().catch(function () {
      return {};
    });
    if (!resp.ok) {
      const err = (data.error && (data.error.message || data.error)) || resp.status;
      throw new Error(String(err));
    }
    closeDeviceCfgImportModal();
    await refreshConfigProfiles();
    showSettingsMsg('已创建配置档「' + name + '」' + (activate ? '并设为当前' : ''), true);
  } catch (e) {
    showSettingsMsg('创建配置档失败: ' + e.message, false);
  }
}

function normalizeConfigProfile(p) {
  return {
    id: p.id || '',
    name: p.name || '',
    setting: p.setting && typeof p.setting === 'object' ? p.setting : {},
    is_active: !!p.is_active,
    source_filename: p.source_filename || '',
    updated_at: p.updated_at || '',
  };
}

async function refreshConfigProfiles() {
  const [devResp, calResp] = await Promise.all([
    fetch('/api/device-profiles'),
    fetch('/api/calibration-profiles'),
  ]);
  const devData = await devResp.json().catch(function () {
    return [];
  });
  const calData = await calResp.json().catch(function () {
    return [];
  });
  if (!devResp.ok) {
    throw new Error(
      String((devData && devData.error && (devData.error.message || devData.error)) || devResp.status)
    );
  }
  if (!calResp.ok) {
    throw new Error(
      String((calData && calData.error && (calData.error.message || calData.error)) || calResp.status)
    );
  }
  deviceProfiles = (Array.isArray(devData) ? devData : []).map(normalizeConfigProfile);
  calibrationProfiles = (Array.isArray(calData) ? calData : []).map(normalizeConfigProfile);
  renderDeviceProfiles();
  renderCalibrationProfiles();
}

function getActiveConfigProfile(kind) {
  const list = kind === 'calibration' ? calibrationProfiles : deviceProfiles;
  for (var i = 0; i < list.length; i++) {
    if (list[i].is_active) return list[i];
  }
  return null;
}

function renderActiveProfileFlat(kind) {
  const tbodyId =
    kind === 'calibration' ? 'settings-calibration-flat-body' : 'settings-device-flat-body';
  const tbody = document.getElementById(tbodyId);
  if (!tbody) return;
  tbody.innerHTML = '';
  const active = getActiveConfigProfile(kind);
  if (!active) {
    tbody.innerHTML =
      '<tr><td colspan="3" class="empty">无当前启用配置档</td></tr>';
    return;
  }
  const rows = settingToFlatPreviewRows(active.setting);
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="3" class="empty">当前档暂无键值</td></tr>';
    return;
  }
  rows.forEach(function (row) {
    const tr = document.createElement('tr');
    tr.dataset.section = row.section;
    tr.dataset.key = row.key;
    tr.dataset.flatName = row.flatName;
    tr.innerHTML =
      '<td class="mono settings-flat-name">${' +
      escapeHtml(row.flatName) +
      '}</td>' +
      '<td><input type="text" class="settings-flat-value mono" value="' +
      escapeHtml(row.value) +
      '"></td>' +
      '<td><input type="text" class="settings-flat-desc" maxlength="200" value="' +
      escapeHtml(row.description || '') +
      '"></td>';
    tbody.appendChild(tr);
  });
}

function collectFlatRowsFromDom(kind) {
  const tbodyId =
    kind === 'calibration' ? 'settings-calibration-flat-body' : 'settings-device-flat-body';
  const tbody = document.getElementById(tbodyId);
  const out = [];
  if (!tbody) return out;
  tbody.querySelectorAll('tr').forEach(function (tr) {
    if (!tr.dataset.section || !tr.dataset.key) return;
    const valEl = tr.querySelector('.settings-flat-value');
    const descEl = tr.querySelector('.settings-flat-desc');
    out.push({
      section: tr.dataset.section,
      key: tr.dataset.key,
      flatName: tr.dataset.flatName || '',
      value: valEl ? valEl.value : '',
      description: descEl ? descEl.value.trim() : '',
    });
  });
  return out;
}

function flatRowsToSetting(rows, previousSetting) {
  const setting = {};
  const descs = {};
  (rows || []).forEach(function (row) {
    if (!row.section || !row.key) return;
    const value = editTextToSettingValue(row.value);
    if (value === '' || value == null) return;
    if (Array.isArray(value) && !value.length) return;
    if (!setting[row.section]) setting[row.section] = {};
    setting[row.section][row.key] = value;
    if (row.flatName && row.description) {
      descs[row.flatName] = row.description;
    }
  });
  // Keep unrelated meta / unknown sections from previous (except rebuilt descs)
  if (previousSetting && typeof previousSetting === 'object') {
    Object.keys(previousSetting).forEach(function (sec) {
      if (isProfileMetaSection(sec) && sec !== PROFILE_META_DESCRIPTIONS) {
        setting[sec] = previousSetting[sec];
      }
    });
  }
  if (Object.keys(descs).length) {
    setting[PROFILE_META_DESCRIPTIONS] = descs;
  }
  return setting;
}

async function saveActiveProfileFlat(kind) {
  const active = getActiveConfigProfile(kind);
  if (!active || !active.id) {
    showSettingsMsg('没有当前启用的' + (kind === 'calibration' ? '校准' : '设备') + '配置档', false);
    return;
  }
  const rows = collectFlatRowsFromDom(kind);
  const setting = flatRowsToSetting(rows, active.setting);
  const apiKind = kind === 'calibration' ? 'calibration-profiles' : 'device-profiles';
  try {
    const resp = await fetch('/api/' + apiKind + '/' + encodeURIComponent(active.id), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: active.name,
        setting: setting,
        source_filename: active.source_filename || '',
      }),
    });
    const data = await resp.json().catch(function () {
      return {};
    });
    if (!resp.ok) {
      throw new Error(
        String((data.error && (data.error.message || data.error)) || resp.status)
      );
    }
    await refreshConfigProfiles();
    showSettingsMsg(
      '已保存「' + active.name + '」展开变量（' + rows.length + ' 项）',
      true
    );
  } catch (e) {
    showSettingsMsg('保存配置档变量失败: ' + e.message, false);
  }
}

function renderProfileList(tbodyId, countId, profiles, kind) {
  const tbody = document.getElementById(tbodyId);
  const countEl = document.getElementById(countId);
  if (countEl) countEl.textContent = String((profiles || []).length);
  if (!tbody) return;
  tbody.innerHTML = '';
  if (!profiles.length) {
    tbody.innerHTML = '<tr><td colspan="4" class="empty">暂无配置档</td></tr>';
    return;
  }
  profiles.forEach(function (p) {
    const tr = document.createElement('tr');
    tr.dataset.profileId = p.id;
    const activeLabel = p.is_active ? '<span class="settings-profile-active">当前</span>' : '—';
    tr.innerHTML =
      '<td class="mono">' +
      escapeHtml(p.name) +
      '</td>' +
      '<td>' +
      activeLabel +
      '</td>' +
      '<td class="mono">' +
      escapeHtml(p.source_filename || '—') +
      '</td>' +
      '<td class="settings-row-actions"></td>';
    const actions = tr.querySelector('.settings-row-actions');
    if (!p.is_active) {
      const actBtn = document.createElement('button');
      actBtn.type = 'button';
      actBtn.className = 'btn-sm';
      actBtn.textContent = '启用';
      actBtn.addEventListener('click', function () {
        activateConfigProfile(kind, p.id);
      });
      actions.appendChild(actBtn);
    }
    const viewBtn = document.createElement('button');
    viewBtn.type = 'button';
    viewBtn.className = 'btn-sm';
    viewBtn.textContent = '查看';
    viewBtn.addEventListener('click', function () {
      openProfileViewModal(p);
    });
    actions.appendChild(viewBtn);
    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'btn-sm btn-danger';
    delBtn.textContent = '删除';
    delBtn.addEventListener('click', function () {
      deleteConfigProfile(kind, p);
    });
    actions.appendChild(delBtn);
    tbody.appendChild(tr);
  });
}

function renderDeviceProfiles() {
  renderProfileList(
    'settings-device-profiles-body',
    'settings-device-profiles-count',
    deviceProfiles,
    'device'
  );
  renderActiveProfileFlat('device');
}

function renderCalibrationProfiles() {
  renderProfileList(
    'settings-calibration-profiles-body',
    'settings-calibration-profiles-count',
    calibrationProfiles,
    'calibration'
  );
  renderActiveProfileFlat('calibration');
}

let pendingViewedProfile = null;

function openProfileViewModal(p) {
  pendingViewedProfile = p
    ? {
        name: p.name || 'profile',
        setting: p.setting && typeof p.setting === 'object' ? p.setting : {},
        is_active: !!p.is_active,
        source_filename: p.source_filename || '',
      }
    : null;
  const title = document.getElementById('profile-view-title');
  const pre = document.getElementById('profile-view-toml');
  const modal = document.getElementById('profile-view-modal');
  if (title) {
    title.textContent =
      (pendingViewedProfile ? pendingViewedProfile.name : '配置档') +
      (pendingViewedProfile && pendingViewedProfile.is_active ? '（当前）' : '');
  }
  if (pre) {
    try {
      pre.textContent = settingJsonToToml(
        pendingViewedProfile ? pendingViewedProfile.setting : {}
      );
    } catch (e) {
      pre.textContent = '';
    }
  }
  const exportBtn = document.getElementById('profile-view-export-btn');
  if (exportBtn) {
    exportBtn.disabled = !(
      pendingViewedProfile &&
      pre &&
      String(pre.textContent || '').trim()
    );
  }
  if (modal) modal.hidden = false;
}

function closeProfileViewModal() {
  const modal = document.getElementById('profile-view-modal');
  if (modal) modal.hidden = true;
  pendingViewedProfile = null;
}

function exportViewedProfileToml() {
  if (!pendingViewedProfile) return;
  var toml = settingJsonToToml(pendingViewedProfile.setting || {});
  if (!String(toml || '').trim()) {
    showSettingsMsg('当前配置档为空，无法导出', false);
    return;
  }
  var base = sanitizeExportFilename(pendingViewedProfile.name);
  downloadTextFile(base + '.toml', toml, 'application/toml;charset=utf-8');
  showSettingsMsg('已导出 ' + base + '.toml', true);
}

async function activateConfigProfile(kind, id) {
  const apiKind = kind === 'calibration' ? 'calibration-profiles' : 'device-profiles';
  try {
    const resp = await fetch('/api/' + apiKind + '/' + encodeURIComponent(id) + '/activate', {
      method: 'POST',
    });
    const data = await resp.json().catch(function () {
      return {};
    });
    if (!resp.ok) {
      throw new Error(
        String((data.error && (data.error.message || data.error)) || resp.status)
      );
    }
    await refreshConfigProfiles();
    showSettingsMsg('已切换当前' + (kind === 'calibration' ? '校准' : '设备') + '配置档', true);
  } catch (e) {
    showSettingsMsg('启用失败: ' + e.message, false);
  }
}

async function deleteConfigProfile(kind, p) {
  if (!p || !p.id) return;
  if (!window.confirm('删除配置档「' + p.name + '」？')) return;
  const apiKind = kind === 'calibration' ? 'calibration-profiles' : 'device-profiles';
  try {
    const resp = await fetch('/api/' + apiKind + '/' + encodeURIComponent(p.id), {
      method: 'DELETE',
    });
    if (!resp.ok && resp.status !== 204) {
      const data = await resp.json().catch(function () {
        return {};
      });
      throw new Error(
        String((data.error && (data.error.message || data.error)) || resp.status)
      );
    }
    await refreshConfigProfiles();
    showSettingsMsg('已删除「' + p.name + '」', true);
  } catch (e) {
    showSettingsMsg('删除失败: ' + e.message, false);
  }
}

async function createEmptyConfigProfile(kind) {
  const label = kind === 'calibration' ? '校准' : '设备';
  const name = window.prompt('新建' + label + '配置档名称', label === '校准' ? 'Calibration' : 'DUT');
  if (!name || !String(name).trim()) return;
  const apiKind = kind === 'calibration' ? 'calibration-profiles' : 'device-profiles';
  const activate = !(
    (kind === 'calibration' ? calibrationProfiles : deviceProfiles) || []
  ).some(function (p) {
    return p.is_active;
  });
  try {
    const resp = await fetch('/api/' + apiKind, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: String(name).trim(),
        setting: {},
        source_filename: '',
        activate: activate,
      }),
    });
    const data = await resp.json().catch(function () {
      return {};
    });
    if (!resp.ok) {
      throw new Error(
        String((data.error && (data.error.message || data.error)) || resp.status)
      );
    }
    await refreshConfigProfiles();
    showSettingsMsg('已新建「' + String(name).trim() + '」', true);
  } catch (e) {
    showSettingsMsg('新建失败: ' + e.message, false);
  }
}

function cloneSettingsData(data) {
  return {
    variables: (data.variables || []).map(function (v) {
      return {
        name: v.name || '',
        value: v.value == null ? '' : String(v.value),
        description: v.description || '',
      };
    }),
    array_expand_mode: normalizeArrayExpandMode(data && data.array_expand_mode),
  };
}

function normalizeArrayExpandMode(mode) {
  return mode === 'json' ? 'json' : 'semicolon';
}

function getArrayExpandModeFromDom() {
  const el = document.getElementById('settings-array-expand-mode');
  return normalizeArrayExpandMode(el && el.value);
}

function setArrayExpandModeInDom(mode) {
  const el = document.getElementById('settings-array-expand-mode');
  if (el) el.value = normalizeArrayExpandMode(mode);
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
  const varsCount = document.getElementById('settings-vars-count');
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

async function fetchCenterUnits() {
  const resp = await fetch('/api/units');
  const data = await resp.json().catch(function () {
    return {};
  });
  if (!resp.ok) {
    const err = (data.error && (data.error.message || data.error)) || resp.status;
    throw new Error(String(err));
  }
  centerUnits = Array.isArray(data.units)
    ? data.units.map(normalizeSettingsUnit).filter(function (u) {
        return u.symbol;
      })
    : [];
  return centerUnits;
}

async function fetchAgentSettings() {
  const resp = await fetch('/api/settings');
  const data = await resp.json().catch(function () { return {}; });
  if (!resp.ok) {
    const err = data.error && (data.error.message || data.error) || resp.status;
    throw new Error(String(err));
  }
  agentSettings = {
    units: [],
    variables: Array.isArray(data.variables) ? data.variables.map(normalizeSettingsVar) : [],
    array_expand_mode: normalizeArrayExpandMode(data.array_expand_mode),
  };
  setArrayExpandModeInDom(agentSettings.array_expand_mode);
  if (Array.isArray(data.device_profiles)) {
    deviceProfiles = data.device_profiles.map(normalizeConfigProfile);
  }
  if (Array.isArray(data.calibration_profiles)) {
    calibrationProfiles = data.calibration_profiles.map(normalizeConfigProfile);
  }
  // Prefer dedicated units API; fall back to settings.units if present (compat).
  try {
    await fetchCenterUnits();
  } catch (e) {
    if (Array.isArray(data.units) && data.units.length) {
      centerUnits = data.units.map(normalizeSettingsUnit).filter(function (u) {
        return u.symbol;
      });
    }
  }
  return agentSettings;
}

function bindSettingsDirty(el) {
  if (!el) return;
  el.addEventListener('input', markSettingsDirty);
  el.addEventListener('change', markSettingsDirty);
}

function renderSettingsUnits() {
  /* units edited on Center WebUI only */
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
      wrap.className = 'mono settings-var-name-display';
      wrap.textContent = '${' + (v.name || '') + '}';
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
      const nameWrap = document.createElement('div');
      nameWrap.className = 'settings-var-name-wrap';
      const prefix = document.createElement('span');
      prefix.className = 'mono settings-var-dollar';
      prefix.textContent = '${';
      const nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.className = 'mono settings-var-name';
      nameInput.value = v.name || '';
      nameInput.setAttribute('aria-label', '变量名');
      nameInput.addEventListener('change', function () {
        agentSettings.variables[idx].name = nameInput.value.trim();
      });
      bindSettingsDirty(nameInput);
      const suffix = document.createElement('span');
      suffix.className = 'mono settings-var-dollar';
      suffix.textContent = '}';
      nameWrap.appendChild(prefix);
      nameWrap.appendChild(nameInput);
      nameWrap.appendChild(suffix);
      nameTd.appendChild(nameWrap);
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

function deleteSettingsUnit(_idx) {
  /* units edited on Center WebUI only */
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
  /* units edited on Center WebUI only */
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
    await loadAgentChannels();
    renderSettingsVars();
    renderDeviceProfiles();
    renderCalibrationProfiles();
    markSettingsSynced('已同步');
    showSettingsMsg(
      '已加载：' +
        agentSettings.variables.length +
        ' 个变量，' +
        deviceProfiles.length +
        ' 设备档，' +
        calibrationProfiles.length +
        ' 校准档，' +
        agentChannels.length +
        ' 通道；单位 ' +
        centerUnits.length +
        ' 个（中心）',
      true
    );
  } catch (e) {
    agentSettings = { units: [], variables: [], array_expand_mode: 'semicolon' };
    deviceProfiles = [];
    calibrationProfiles = [];
    renderSettingsVars();
    renderDeviceProfiles();
    renderCalibrationProfiles();
    settingsDirty = false;
    setSettingsSyncStatus('is-error', '加载失败');
    showSettingsMsg('加载失败: ' + e.message, false);
  }
}

function showChannelsMsg(text, ok) {
  const msg = document.getElementById('settings-channels-msg');
  if (!msg) return;
  msg.hidden = false;
  msg.textContent = text;
  msg.className = ok ? 'msg ok' : 'msg err';
}

function overlayObjectFromChannel(ch) {
  const out = {};
  const raw = ch && ch.overlay != null ? ch.overlay : {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    Object.keys(raw).forEach(function (k) {
      if (!k) return;
      const v = raw[k];
      out[k] = v == null ? '' : String(v);
    });
  }
  return out;
}

function nextChannelIndex() {
  let max = -1;
  for (let i = 0; i < agentChannels.length; i++) {
    const idx = Number(agentChannels[i].channel_index);
    if (Number.isFinite(idx) && idx > max) max = idx;
  }
  return max + 1;
}

async function loadAgentChannels() {
  try {
    const resp = await fetch('/api/channels');
    const data = await resp.json();
    if (!resp.ok) {
      const err = data.error && (data.error.message || data.error) || resp.status;
      agentChannels = [];
      renderAgentChannels();
      renderSeqChannelPick();
      showChannelsMsg('加载通道失败: ' + err, false);
      return;
    }
    const list = Array.isArray(data.channels) ? data.channels : [];
    agentChannels = list.map(function (ch) {
      return {
        id: ch.id,
        channel_index: Number(ch.channel_index) || 0,
        name: ch.name || ('CH' + (Number(ch.channel_index) || 0)),
        enabled: ch.enabled !== false,
        overlay: overlayObjectFromChannel(ch),
      };
    });
    agentChannels.sort(function (a, b) {
      return a.channel_index - b.channel_index;
    });
    renderAgentChannels();
    renderSeqChannelPick();
  } catch (e) {
    agentChannels = [];
    renderAgentChannels();
    renderSeqChannelPick();
    showChannelsMsg('加载通道失败: ' + e.message, false);
  }
}

function collectChannelsFromDom() {
  const rows = document.querySelectorAll('#settings-channels-body tr.settings-channel-row');
  const channels = [];
  const seenIndex = {};
  rows.forEach(function (tr) {
    const indexEl = tr.querySelector('.settings-channel-index');
    const nameEl = tr.querySelector('.settings-channel-name');
    const enabledEl = tr.querySelector('.settings-channel-enabled');
    if (!indexEl || !nameEl) return;
    const channel_index = parseInt(String(indexEl.value || '').trim(), 10);
    const name = String(nameEl.value || '').trim();
    if (!name || !Number.isFinite(channel_index) || channel_index < 0) return;
    if (seenIndex[channel_index]) {
      throw new Error('通道 index 重复: ' + channel_index);
    }
    seenIndex[channel_index] = true;
    const overlay = {};
    tr.querySelectorAll('.settings-channel-overlay-row').forEach(function (ovRow) {
      const kEl = ovRow.querySelector('.settings-channel-overlay-key');
      const vEl = ovRow.querySelector('.settings-channel-overlay-value');
      if (!kEl) return;
      const key = String(kEl.value || '').trim();
      if (!key) return;
      overlay[key] = vEl ? String(vEl.value || '') : '';
    });
    channels.push({
      channel_index: channel_index,
      name: name,
      enabled: !!(enabledEl && enabledEl.checked),
      overlay: overlay,
    });
  });
  return channels;
}

function renderChannelOverlayEditor(host, overlay) {
  host.innerHTML = '';
  host.className = 'settings-channel-overlay';
  const pairs = overlay && typeof overlay === 'object' ? Object.keys(overlay) : [];
  if (!pairs.length) {
    // keep at least one empty row for editing
    pairs.push('');
  }
  for (let i = 0; i < pairs.length; i++) {
    const key = pairs[i];
    const row = document.createElement('div');
    row.className = 'settings-channel-overlay-row';
    const kInput = document.createElement('input');
    kInput.type = 'text';
    kInput.className = 'settings-channel-overlay-key mono';
    kInput.placeholder = '键';
    kInput.value = key;
    const vInput = document.createElement('input');
    vInput.type = 'text';
    vInput.className = 'settings-channel-overlay-value mono';
    vInput.placeholder = '值';
    vInput.value = key ? String(overlay[key] ?? '') : '';
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'btn-sm';
    rm.textContent = '×';
    rm.title = '删除键';
    rm.addEventListener('click', function () {
      row.remove();
      if (!host.querySelector('.settings-channel-overlay-row')) {
        renderChannelOverlayEditor(host, {});
      }
    });
    row.appendChild(kInput);
    row.appendChild(vInput);
    row.appendChild(rm);
    host.appendChild(row);
  }
  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'btn-sm settings-channel-overlay-add';
  addBtn.textContent = '+ 键';
  addBtn.addEventListener('click', function () {
    const row = document.createElement('div');
    row.className = 'settings-channel-overlay-row';
    row.innerHTML =
      '<input type="text" class="settings-channel-overlay-key mono" placeholder="键">' +
      '<input type="text" class="settings-channel-overlay-value mono" placeholder="值">' +
      '<button type="button" class="btn-sm" title="删除键">×</button>';
    const rm = row.querySelector('button');
    rm.addEventListener('click', function () {
      row.remove();
      if (!host.querySelector('.settings-channel-overlay-row')) {
        renderChannelOverlayEditor(host, {});
      }
    });
    host.insertBefore(row, addBtn);
  });
  host.appendChild(addBtn);
}

function renderAgentChannels() {
  const tbody = document.getElementById('settings-channels-body');
  const countEl = document.getElementById('settings-channels-count');
  if (countEl) countEl.textContent = String(agentChannels.length);
  if (!tbody) return;
  tbody.innerHTML = '';
  if (!agentChannels.length) {
    tbody.innerHTML =
      '<tr><td colspan="5" class="empty">暂无通道；可添加后保存，或留空让运行使用合成 CH0</td></tr>';
    return;
  }
  for (let i = 0; i < agentChannels.length; i++) {
    const ch = agentChannels[i];
    const tr = document.createElement('tr');
    tr.className = 'settings-channel-row';
    tr.setAttribute('data-channel-pos', String(i));

    const indexTd = document.createElement('td');
    const indexInput = document.createElement('input');
    indexInput.type = 'number';
    indexInput.min = '0';
    indexInput.step = '1';
    indexInput.className = 'settings-channel-index mono';
    indexInput.value = String(ch.channel_index);
    indexTd.appendChild(indexInput);

    const nameTd = document.createElement('td');
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'settings-channel-name';
    nameInput.value = ch.name || '';
    nameTd.appendChild(nameInput);

    const enabledTd = document.createElement('td');
    const enabledCb = document.createElement('input');
    enabledCb.type = 'checkbox';
    enabledCb.className = 'settings-channel-enabled';
    enabledCb.checked = ch.enabled !== false;
    enabledTd.appendChild(enabledCb);

    const overlayTd = document.createElement('td');
    const overlayHost = document.createElement('div');
    renderChannelOverlayEditor(overlayHost, ch.overlay || {});
    overlayTd.appendChild(overlayHost);

    const actionsTd = document.createElement('td');
    const rmBtn = document.createElement('button');
    rmBtn.type = 'button';
    rmBtn.className = 'btn-sm';
    rmBtn.textContent = '删除';
    rmBtn.addEventListener('click', function () {
      try {
        agentChannels = collectChannelsFromDom();
      } catch (e) {
        /* keep current */
      }
      agentChannels.splice(i, 1);
      renderAgentChannels();
      renderSeqChannelPick();
    });
    actionsTd.appendChild(rmBtn);

    tr.appendChild(indexTd);
    tr.appendChild(nameTd);
    tr.appendChild(enabledTd);
    tr.appendChild(overlayTd);
    tr.appendChild(actionsTd);
    tbody.appendChild(tr);
  }
}

function addAgentChannelRow() {
  try {
    if (document.querySelector('#settings-channels-body tr.settings-channel-row')) {
      agentChannels = collectChannelsFromDom();
    }
  } catch (e) {
    showChannelsMsg(e.message, false);
    return;
  }
  const idx = nextChannelIndex();
  agentChannels.push({
    channel_index: idx,
    name: 'CH' + idx,
    enabled: true,
    overlay: {},
  });
  renderAgentChannels();
  renderSeqChannelPick();
}

async function saveAgentChannels() {
  let channels;
  try {
    channels = collectChannelsFromDom();
  } catch (e) {
    showChannelsMsg(e.message, false);
    return;
  }
  try {
    const resp = await fetch('/api/channels', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channels: channels }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      const err = data.error && (data.error.message || data.error) || resp.status;
      showChannelsMsg('保存通道失败: ' + err, false);
      return;
    }
    const list = Array.isArray(data.channels) ? data.channels : channels;
    agentChannels = list.map(function (ch) {
      return {
        id: ch.id,
        channel_index: Number(ch.channel_index) || 0,
        name: ch.name || ('CH' + (Number(ch.channel_index) || 0)),
        enabled: ch.enabled !== false,
        overlay: overlayObjectFromChannel(ch),
      };
    });
    agentChannels.sort(function (a, b) {
      return a.channel_index - b.channel_index;
    });
    renderAgentChannels();
    renderSeqChannelPick();
    showChannelsMsg('已保存 ' + agentChannels.length + ' 个通道', true);
  } catch (e) {
    showChannelsMsg('保存通道失败: ' + e.message, false);
  }
}

function enabledAgentChannels() {
  return agentChannels.filter(function (ch) {
    return ch.enabled !== false;
  });
}

function renderSeqChannelPick() {
  const host = document.getElementById('seq-channel-pick');
  if (!host) return;
  const enabled = enabledAgentChannels();
  host.innerHTML = '';
  if (!enabled.length) {
    host.innerHTML = '<span class="muted-hint">通道: CH0（合成）</span>';
    seqSelectedChannelIndexes = null;
    syncSeqRunSummary();
    return;
  }
  const label = document.createElement('span');
  label.className = 'seq-channel-pick-label';
  label.textContent = '通道';
  host.appendChild(label);
  const selected = {};
  if (Array.isArray(seqSelectedChannelIndexes) && seqSelectedChannelIndexes.length) {
    seqSelectedChannelIndexes.forEach(function (i) {
      selected[i] = true;
    });
  } else {
    enabled.forEach(function (ch) {
      selected[ch.channel_index] = true;
    });
  }
  enabled.forEach(function (ch) {
    const wrap = document.createElement('label');
    wrap.className = 'seq-channel-pick-item';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'seq-channel-cb';
    cb.value = String(ch.channel_index);
    cb.checked = !!selected[ch.channel_index];
    cb.disabled = seqRunning;
    cb.addEventListener('change', function () {
      const picked = [];
      host.querySelectorAll('.seq-channel-cb:checked').forEach(function (el) {
        picked.push(parseInt(el.value, 10));
      });
      seqSelectedChannelIndexes = picked.length ? picked : [];
      syncSeqRunSummary();
      renderSeqChannelCards();
      renderSeqChannelDetail();
    });
    wrap.appendChild(cb);
    wrap.appendChild(document.createTextNode(' ' + (ch.name || ('CH' + ch.channel_index))));
    host.appendChild(wrap);
  });
  syncSeqRunSummary();
}

function selectedChannelIndexesForRun() {
  const enabled = enabledAgentChannels();
  if (!enabled.length) return null;
  const boxes = document.querySelectorAll('#seq-channel-pick .seq-channel-cb');
  if (!boxes.length) return null;
  const picked = [];
  boxes.forEach(function (cb) {
    if (cb.checked) picked.push(parseInt(cb.value, 10));
  });
  if (!picked.length) return [];
  if (picked.length === enabled.length) return null; // omit = all enabled
  return picked;
}

function normalizeResourceName(raw) {
  const name = String(raw || '').trim();
  if (!name) return null;
  if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(name)) return null;
  return name;
}

function renderStepResourcesEditor(host, item, index) {
  if (!host) return;
  host.innerHTML = '';
  host.className = 'step-resources';
  const help = document.createElement('p');
  help.className = 'muted-hint step-resources-help';
  help.textContent = '共用仪表填相同资源名，例如 station.dca；通道私有步骤留空即可并行。';
  host.appendChild(help);

  const tags = document.createElement('div');
  tags.className = 'step-resources-tags';
  const resources = Array.isArray(item.resources) ? item.resources.slice() : [];
  function refreshTags() {
    tags.innerHTML = '';
    resources.forEach(function (name, ri) {
      const tag = document.createElement('span');
      tag.className = 'step-resource-tag';
      tag.textContent = name + ' ';
      const x = document.createElement('button');
      x.type = 'button';
      x.className = 'btn-sm step-resource-remove';
      x.textContent = '×';
      x.disabled = seqRunning;
      x.addEventListener('click', async function () {
        resources.splice(ri, 1);
        item.resources = resources.slice();
        refreshTags();
        await saveQueue();
      });
      tag.appendChild(x);
      tags.appendChild(tag);
    });
    if (!resources.length) {
      const empty = document.createElement('span');
      empty.className = 'muted-hint';
      empty.textContent = '无资源锁（可并行）';
      tags.appendChild(empty);
    }
  }
  refreshTags();
  host.appendChild(tags);

  const addRow = document.createElement('div');
  addRow.className = 'step-resources-add';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'step-resources-input mono';
  input.setAttribute('list', 'resource-presets');
  input.placeholder = '资源名，如 station.dca';
  input.disabled = seqRunning;
  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'btn-sm';
  addBtn.textContent = '添加资源';
  addBtn.disabled = seqRunning;
  async function tryAdd() {
    const name = normalizeResourceName(input.value);
    if (!name) {
      showSeqMsg('资源名无效（需匹配 ^[A-Za-z][A-Za-z0-9_.-]{0,63}$）', false);
      return;
    }
    if (resources.indexOf(name) >= 0) {
      input.value = '';
      return;
    }
    resources.push(name);
    item.resources = resources.slice();
    input.value = '';
    refreshTags();
    await saveQueue();
  }
  addBtn.addEventListener('click', tryAdd);
  input.addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      tryAdd();
    }
  });
  addRow.appendChild(input);
  addRow.appendChild(addBtn);
  host.appendChild(addRow);
}

function addSettingsUnit() {
  /* units edited on Center WebUI only */
}

function addSettingsVar() {
  agentSettings.variables.push({ name: '', value: '', description: '' });
  markSettingsDirty();
  renderSettingsVars();
  const names = document.querySelectorAll('#settings-vars-body input.settings-var-name:not([type="hidden"])');
  if (names.length) {
    names[names.length - 1].focus();
    const scroll = document.querySelector('#settings-vars-section .settings-table-scroll');
    if (scroll) scroll.scrollTop = scroll.scrollHeight;
  }
}

function collectSettingsFromDom() {
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
  return {
    variables: variables,
    array_expand_mode: getArrayExpandModeFromDom(),
  };
}

function validateSettingsPayload(payload) {
  const nameRe = /^[A-Za-z_][A-Za-z0-9_]*$/;
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
      units: [],
      variables: Array.isArray(data.variables) ? data.variables.map(normalizeSettingsVar) : payload.variables,
      array_expand_mode: normalizeArrayExpandMode(
        data.array_expand_mode != null ? data.array_expand_mode : payload.array_expand_mode
      ),
    };
    setArrayExpandModeInDom(agentSettings.array_expand_mode);
    if (Array.isArray(data.units) && data.units.length) {
      centerUnits = data.units.map(normalizeSettingsUnit).filter(function (u) {
        return u.symbol;
      });
    }
    clearSettingsUndo();
    renderSettingsVars();
    markSettingsSynced('已同步');
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const ss = String(now.getSeconds()).padStart(2, '0');
    showSettingsMsg(
      '已保存到中心 · ' +
        agentSettings.variables.length +
        ' 变量 · ' +
        hh +
        ':' +
        mm +
        ':' +
        ss,
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
  if (agentSettings && agentSettings.variables.length && centerUnits.length) return;
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
let seqStepResults = {};
let seqProgressPollTimer = null;
let seqProgressGeneration = 0;
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

function isSequencePageVisible() {
  const edit = document.getElementById('page-sequence-edit');
  const run = document.getElementById('page-sequence-run');
  return (edit && !edit.hidden) || (run && !run.hidden);
}

function normalizeSequencePage(page) {
  if (page === 'sequence') return 'sequence-edit';
  return page;
}

function updateSeqRunQueueSummary() {
  const el = document.getElementById('seq-run-queue-summary');
  if (!el) return;
  let steps = 0;
  for (let i = 0; i < seqSelected.length; i++) {
    if (!isSeqGroupItem(seqSelected[i])) steps += 1;
  }
  if (!seqSelected.length) {
    el.textContent = '当前队列：空（请先到「序列编排」添加步骤）';
    syncSeqRunSummary();
    return;
  }
  const bind = document.getElementById('seq-template-bind');
  const bindText = bind && bind.textContent ? ' · ' + bind.textContent : '';
  el.textContent = '当前队列：' + steps + ' 步' + bindText;
  syncSeqRunSummary();
}

function syncSeqRunSummary(data) {
  const meta = document.getElementById('seq-run-meta');
  if (meta) {
    const enabled = enabledAgentChannels();
    if (!enabled.length) {
      meta.textContent = '通道：CH0（合成）';
    } else {
      const boxes = document.querySelectorAll('#seq-channel-pick .seq-channel-cb');
      let picked = 0;
      boxes.forEach(function (cb) {
        if (cb.checked) picked += 1;
      });
      meta.textContent = '通道：已选 ' + picked + ' / ' + enabled.length;
    }
  }
  if (data !== undefined) {
    const overall = data && data.overall ? data.overall : '';
    const label = document.getElementById('seq-run-status-label');
    const card = document.getElementById('seq-run-status-card');
    const normalized = String(overall || '').toLowerCase();
    if (label) label.textContent = formatSequenceOverall(normalized);
    if (card) {
      const state =
        normalized === 'pass' || normalized === 'ok'
          ? 'pass'
          : normalized === 'running' || normalized === 'waiting_resource'
            ? 'running'
            : normalized === 'fail' || normalized === 'failed' || normalized === 'error' || normalized === 'aborted'
              ? 'fail'
              : 'idle';
      card.setAttribute('data-state', state);
    }
  }
}

function showPage(page) {
  page = normalizeSequencePage(page);
  const workbench = document.getElementById('page-workbench');
  const general = document.getElementById('page-general');
  const apiPage = document.getElementById('page-api');
  const sequenceEdit = document.getElementById('page-sequence-edit');
  const sequenceRun = document.getElementById('page-sequence-run');
  const settings = document.getElementById('page-settings');
  const leavingSettings = settings && !settings.hidden && page !== 'settings';
  if (leavingSettings && settingsDirty) {
    if (!window.confirm('配置有未保存更改，确定离开？')) return;
  }
  workbench.hidden = page !== 'workbench';
  if (general) general.hidden = page !== 'general';
  if (apiPage) apiPage.hidden = page !== 'api';
  if (sequenceEdit) sequenceEdit.hidden = page !== 'sequence-edit';
  if (sequenceRun) sequenceRun.hidden = page !== 'sequence-run';
  if (settings) settings.hidden = page !== 'settings';
  document.querySelectorAll('.page-tabs .tab').forEach(function (btn) {
    btn.classList.toggle('active', btn.getAttribute('data-page') === page);
  });
  if (page === 'sequence-edit' || page === 'sequence-run') {
    loadSequencePage().then(function () {
      if (page === 'sequence-run') {
        updateSeqRunQueueSummary();
        renderSeqChannelPick();
        renderSeqChannelCards();
        renderSeqChannelDetail();
      }
    });
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
  const targets = [
    document.getElementById('seq-msg'),
    document.getElementById('seq-run-msg'),
  ];
  targets.forEach(function (msg) {
    if (!msg) return;
    msg.hidden = false;
    msg.textContent = text;
    msg.className = ok ? 'msg ok' : 'msg err';
  });
}

function setSeqControlsDisabled(disabled) {
  seqRunning = disabled;
  const runBtn = document.getElementById('seq-run-btn');
  const abortBtn = document.getElementById('seq-abort-btn');
  if (runBtn) runBtn.disabled = disabled || !seqSelected.length;
  // Abort is usable while a sequence POST is in flight (shared cancel watch).
  if (abortBtn) abortBtn.disabled = !disabled;
  const insertGroupBtn = document.getElementById('seq-insert-group');
  if (insertGroupBtn) insertGroupBtn.disabled = disabled;
  updateGroupSelectedBtn();
  if (disabled) {
    const groupSelectedBtn = document.getElementById('seq-group-selected');
    if (groupSelectedBtn) groupSelectedBtn.disabled = true;
  }
  document.querySelectorAll('#seq-registered-body button, #seq-selected-body button').forEach(function (btn) {
    if (btn.classList.contains('seq-detail-toggle')) return;
    btn.disabled = disabled;
  });
  document.querySelectorAll('#seq-selected-body input[type="checkbox"], #seq-selected-body select').forEach(function (el) {
    el.disabled = disabled;
  });
  // Step editor text fields (resources, group titles, etc.) stay in the DOM after render —
  // must flip disabled here when the run ends (render often happened while seqRunning=true).
  document
    .querySelectorAll(
      '#seq-selected-body .step-resources-input, #seq-selected-body input[type="text"], #seq-selected-body input[type="number"], #seq-selected-body textarea'
    )
    .forEach(function (el) {
      el.disabled = disabled;
    });
  document.querySelectorAll('#seq-channel-pick .seq-channel-cb').forEach(function (el) {
    el.disabled = disabled;
  });
  document.querySelectorAll('#seq-selected-body tr.seq-row[data-index]').forEach(function (row) {
    row.draggable = !disabled;
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
    failed: '失败',
    ok: '通过',
    error: '错误',
    skipped: '跳过',
    running: '执行中',
    waiting_resource: '等待资源',
    aborted: '已中止',
    pending: '待执行',
  };
  return map[status] || status || '—';
}

function formatSequenceOverall(overall) {
  const normalized = String(overall || '').toLowerCase();
  const map = {
    pass: '通过',
    ok: '通过',
    fail: '失败',
    failed: '失败',
    error: '错误',
    aborted: '已中止',
    running: '执行中',
    waiting_resource: '等待资源',
    stopped: '失败',
    idle: '待执行',
    pending: '待执行',
  };
  return map[normalized] || (normalized ? String(overall) : '待执行');
}

function isSequenceIssueStatus(status) {
  const normalized = String(status || '').toLowerCase();
  return normalized === 'fail' ||
    normalized === 'failed' ||
    normalized === 'error' ||
    normalized === 'aborted' ||
    normalized === 'stopped';
}

function pendingSequenceChannelsForOperator(enabledChannels, selectedIndexes) {
  const enabled = Array.isArray(enabledChannels) ? enabledChannels : [];
  if (!enabled.length) {
    return [{ channel_index: 0, name: 'CH0', steps: [], overall: null, running: false }];
  }
  const selected = Array.isArray(selectedIndexes)
    ? selectedIndexes.reduce(function (map, channelIndex) {
        map[channelIndex] = true;
        return map;
      }, {})
    : null;
  return enabled
    .filter(function (channel) {
      return selected == null || !!selected[channel.channel_index];
    })
    .sort(function (a, b) {
      return Number(a.channel_index) - Number(b.channel_index);
    })
    .map(function (channel) {
      return {
        channel_index: channel.channel_index,
        name: channel.name || 'CH' + channel.channel_index,
        steps: [],
        overall: null,
        running: false,
      };
    });
}

function formatSequenceElapsed(rawMilliseconds) {
  if (rawMilliseconds == null || !Number.isFinite(Number(rawMilliseconds))) return '—';
  const total = Math.max(0, Math.floor(Number(rawMilliseconds)));
  const milliseconds = total % 1000;
  const totalSeconds = Math.floor(total / 1000);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  const core = String(minutes).padStart(2, '0') + ':' + String(seconds).padStart(2, '0') + '.' + String(milliseconds).padStart(3, '0');
  return hours > 0 ? String(hours).padStart(2, '0') + ':' + core : core;
}

function buildSequenceChannelCardModel(channel, queue) {
  channel = channel || {};
  const steps = Array.isArray(channel.steps) ? channel.steps : [];
  const total = Math.max(Array.isArray(queue) ? queue.length : 0, steps.length);
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let completed = 0;
  for (let i = 0; i < steps.length; i++) {
    const status = String((steps[i] && steps[i].status) || '').toLowerCase();
    if (status === 'pass' || status === 'ok') passed += 1;
    else if (status === 'skipped') skipped += 1;
    else if (status === 'fail' || status === 'failed' || status === 'error' || status === 'aborted' || status === 'stopped') failed += 1;
    if (status === 'pass' || status === 'ok' || status === 'skipped' || status === 'fail' || status === 'failed' || status === 'error' || status === 'aborted' || status === 'stopped') completed += 1;
  }
  const overall = String(channel.overall || '').toLowerCase();
  let state = 'idle';
  if (channel.running || overall === 'running' || overall === 'waiting_resource') state = 'running';
  else if (overall === 'pass' || overall === 'ok') state = 'pass';
  else if (overall === 'fail' || overall === 'failed' || overall === 'error' || overall === 'aborted' || overall === 'stopped') state = 'fail';
  let currentName = '等待运行';
  if (state === 'running') currentName = channel.current_name || '准备下一步骤';
  else if (state === 'pass') currentName = '全部步骤通过';
  else if (state === 'fail') {
    const lastStep = steps.length ? steps[steps.length - 1] : null;
    currentName = lastStep && lastStep.name ? lastStep.name : '运行结束，请查看详情';
  }
  return {
    state: state,
    currentName: currentName,
    currentPosition: channel.current_position != null ? channel.current_position : null,
    completed: completed,
    total: total,
    passed: passed,
    failed: failed,
    skipped: skipped,
    elapsedMs: Number(channel.elapsed_ms) || 0,
    currentElapsedMs: channel.current_step_elapsed_ms != null ? Number(channel.current_step_elapsed_ms) : null,
  };
}

function buildSequenceChannelDetailModel(channel, queue) {
  channel = channel || {};
  const sourceQueue = Array.isArray(queue) ? queue : [];
  const actualSteps = Array.isArray(channel.steps) ? channel.steps : [];
  const byPosition = {};
  const groupPositions = {};
  for (let i = 0; i < sourceQueue.length; i++) {
    const item = sourceQueue[i] || {};
    if (item.template_source !== 'group') continue;
    groupPositions[item.position != null ? item.position : i] = true;
  }
  for (let i = 0; i < actualSteps.length; i++) {
    const result = actualSteps[i] || {};
    const position = result.position != null ? result.position : i;
    byPosition[position] = result;
  }
  const detailSteps = [];
  for (let i = 0; i < sourceQueue.length; i++) {
    const item = sourceQueue[i] || {};
    const position = item.position != null ? item.position : i;
    if (item.template_source === 'group') {
      delete byPosition[position];
      continue;
    }
    const result = byPosition[position] || null;
    let status = result && result.status ? String(result.status).toLowerCase() : 'pending';
    if (!result && channel.current_position === position && channel.running) status = 'running';
    detailSteps.push({
      position: position,
      name: (result && result.name) || item.name || '步骤 ' + (position + 1),
      status: status,
      elapsedMs: result && result.elapsed_ms != null ? Number(result.elapsed_ms) : null,
      item: item,
      result: result,
    });
    delete byPosition[position];
  }
  Object.keys(byPosition).sort(function (a, b) { return Number(a) - Number(b); }).forEach(function (key) {
    const result = byPosition[key] || {};
    const position = result.position != null ? result.position : Number(key);
    if (groupPositions[position]) return;
    detailSteps.push({
      position: position,
      name: result.name || '步骤 ' + (position + 1),
      status: result.status ? String(result.status).toLowerCase() : 'pending',
      elapsedMs: result.elapsed_ms != null ? Number(result.elapsed_ms) : null,
      item: null,
      result: result,
    });
  });
  const sections = buildSequenceDetailSections(sourceQueue, detailSteps);
  sections.forEach(function (section) {
    section.summary = buildSequenceGroupSummary(section);
  });
  return {
    channelIndex: channel.channel_index,
    name: channel.name || 'CH' + channel.channel_index,
    overall: channel.overall || (channel.running ? 'running' : null),
    elapsedMs: Number(channel.elapsed_ms) || 0,
    currentElapsedMs: channel.current_step_elapsed_ms != null ? Number(channel.current_step_elapsed_ms) : null,
    currentPosition: channel.current_position != null ? channel.current_position : null,
    currentName: channel.current_name || null,
    steps: detailSteps,
    sections: sections,
    namedGroupCount: sections.filter(function (section) { return section.kind === 'group'; }).length,
  };
}

function buildSequenceDetailSections(queue, detailSteps) {
  const stepByPosition = {};
  (detailSteps || []).forEach(function (step) { stepByPosition[step.position] = step; });
  const sections = [];
  let current = null;
  (queue || []).forEach(function (item, index) {
    const position = item && item.position != null ? item.position : index;
    if (item && item.template_source === 'group') {
      current = {
        key: 'group-' + position,
        kind: 'group',
        title: item.name || '未命名组',
        note: item.note || '',
        enabled: item.enabled !== false,
        collapsed: !!item.collapsed,
        steps: [],
      };
      sections.push(current);
      return;
    }
    if (!current) {
      current = { key: 'ungrouped', kind: 'ungrouped', title: '未分组步骤', enabled: true, collapsed: false, steps: [] };
      sections.push(current);
    }
    if (stepByPosition[position]) current.steps.push(stepByPosition[position]);
  });
  return sections;
}

function buildSequenceGroupSummary(section) {
  section = section || {};
  const steps = Array.isArray(section.steps) ? section.steps : [];
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let running = false;
  for (let i = 0; i < steps.length; i++) {
    const state = sequenceStatusVisualState(steps[i] && steps[i].status);
    if (state === 'pass') passed += 1;
    else if (state === 'skipped') skipped += 1;
    else if (state === 'fail') failed += 1;
    else if (state === 'running') running = true;
  }
  const completed = passed + failed + skipped;
  let state = 'pending';
  if (section.enabled === false) state = 'disabled';
  else if (running) state = 'running';
  else if (failed) state = 'fail';
  else if (steps.length && completed === steps.length && passed) state = 'pass';
  else if (steps.length && completed === steps.length && skipped) state = 'skipped';
  return {
    state: state,
    completed: completed,
    total: steps.length,
    passed: passed,
    failed: failed,
    skipped: skipped,
    open: state === 'running' || state === 'fail' ? true : !section.collapsed,
  };
}

function resolveSequenceGroupOpen(initialOpen, preservedOpen, forceOpen) {
  if (forceOpen) return true;
  return preservedOpen == null ? !!initialOpen : !!preservedOpen;
}

function focusSequenceDetailSummary(summary) {
  if (!summary || typeof summary.focus !== 'function') return;
  try {
    summary.focus({ preventScroll: true });
    return;
  } catch (e) {
    // Older browsers may reject the FocusOptions argument.
  }
  const view = typeof window === 'undefined' ? null : window;
  const left = view ? (view.scrollX != null ? view.scrollX : view.pageXOffset) : 0;
  const top = view ? (view.scrollY != null ? view.scrollY : view.pageYOffset) : 0;
  try {
    summary.focus();
  } finally {
    if (view && typeof view.scrollTo === 'function') view.scrollTo(left, top);
  }
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

function buildSequenceMetricRows(item, stepResult) {
  const dash = '—';
  let limits = Array.isArray(item && item.limits) ? item.limits : [];
  if (!limits.length && stepResult && Array.isArray(stepResult.limits)) {
    limits = stepResult.limits;
  }
  const measured = stepResult && stepResult.measured != null ? stepResult.measured : null;
  const result = formatStepStatus(stepResult && stepResult.status);
  if (!limits.length) {
    if (!measured || typeof measured !== 'object' || Array.isArray(measured)) return [];
    return Object.keys(measured).map(function (output) {
      return {
        output: output,
        value: formatLimitBoundDisplay(measured[output]),
        min: dash,
        max: dash,
        unit: dash,
        result: result,
      };
    });
  }
  return limits.map(function (rule) {
    rule = rule || {};
    const op = normalizeSpecOp(rule.op);
    const value = lookupMeasuredValue(measured, rule.output || '');
    const expected = rule.expect != null ? rule.expect : rule.min;
    return {
      output: rule.output || dash,
      value: value != null ? formatLimitBoundDisplay(value) : dash,
      min: formatLimitBoundDisplay(op === 'range' ? rule.min : expected),
      max: op === 'range' ? formatLimitBoundDisplay(rule.max) : dash,
      unit: rule.unit ? String(rule.unit) : dash,
      result: result,
    };
  });
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
  const parts = [];
  if (data && data.overall) parts.push('总体：' + formatSequenceOverall(data.overall));
  if (el) el.textContent = parts.join(' · ');
  if (el) el.classList.remove('seq-overall-pass', 'seq-overall-fail');
  const overall = data && data.overall ? String(data.overall).toLowerCase() : '';
  if (el && (overall === 'pass' || overall === 'ok')) el.classList.add('seq-overall-pass');
  else if (el && (overall === 'fail' || overall === 'failed' || overall === 'aborted' || overall === 'error')) {
    el.classList.add('seq-overall-fail');
  }
  syncSeqRunSummary(data || {});
}

function setSeqRequestFailureState() {
  updateSeqOverall({ overall: 'error' });
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

function channelProgressFromEnvelope(prog) {
  if (!prog) return [];
  if (Array.isArray(prog.channels) && prog.channels.length) {
    return prog.channels.map(function (ch) {
      const channelOverall = String(ch.overall || '').toLowerCase();
      return {
        channel_index: ch.channel_index,
        name: ch.name || ch.channel_name || ('CH' + ch.channel_index),
        steps: Array.isArray(ch.steps) ? ch.steps : [],
        overall: ch.overall != null ? ch.overall : null,
        current_position: ch.current_position,
        current_name: ch.current_name,
        elapsed_ms: ch.elapsed_ms,
        current_step_elapsed_ms: ch.current_step_elapsed_ms,
        running: !!prog.running && (
          ch.current_position != null ||
          channelOverall === 'running' ||
          channelOverall === 'waiting_resource' ||
          !channelOverall
        ),
      };
    });
  }
  // Legacy flat progress → single synthetic channel
  return [
    {
      channel_index: 0,
      name: 'CH0',
      steps: Array.isArray(prog.steps) ? prog.steps : [],
      overall: prog.overall != null ? prog.overall : null,
      current_position: prog.current_position,
      current_name: prog.current_name,
      elapsed_ms: prog.elapsed_ms,
      current_step_elapsed_ms: prog.current_step_elapsed_ms,
      running: !!prog.running,
    },
  ];
}

function applyMultiChannelProgress(prog) {
  seqChannelProgress = channelProgressFromEnvelope(prog);
  // Keep the edit queue free of per-channel measured/status — results live in the run report.
  seqStepResults = {};
  renderSeqChannelCards();
  renderSeqChannelDetail();
  renderSeqSelected();
}

function applySequenceProgress(prog) {
  if (!prog) return;
  applyMultiChannelProgress(prog);
  if (prog.overall) updateSeqOverall(prog);
}

function sequenceStatusVisualState(status) {
  const normalized = String(status || '').toLowerCase();
  if (normalized === 'pass' || normalized === 'ok') return 'pass';
  if (isSequenceIssueStatus(normalized)) return 'fail';
  if (normalized === 'running' || normalized === 'waiting_resource') return 'running';
  if (normalized === 'skipped') return 'skipped';
  return 'pending';
}

function renderSeqChannelCards() {
  const host = document.getElementById('seq-channel-cards');
  if (!host) return;
  let focusedChannelIndex = null;
  if (document.activeElement && host.contains(document.activeElement)) {
    const focusedCard = document.activeElement.closest('.seq-channel-card[data-channel-index]');
    if (focusedCard) focusedChannelIndex = focusedCard.getAttribute('data-channel-index');
  }
  host.innerHTML = '';
  const sourceChannels = sequenceChannelsForDisplay();
  if (!sourceChannels.length) {
    const empty = document.createElement('p');
    empty.className = 'seq-channel-cards-empty';
    empty.textContent = '请至少选择一个运行通道。';
    host.appendChild(empty);
    return;
  }
  const queue = sequenceRunQueueItems();
  sourceChannels.forEach(function (channel) {
    const model = buildSequenceChannelCardModel(channel, queue);
    const card = document.createElement('article');
    card.className = 'seq-channel-card';
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.setAttribute('data-state', model.state);
    card.setAttribute('data-channel-index', String(channel.channel_index));
    const cardStatusText = model.state === 'idle' ? '待开始' : formatSequenceOverall(model.state);
    card.setAttribute('aria-label', String(channel.name || 'CH' + channel.channel_index) + '，' + cardStatusText + '，打开运行详情');

    const header = document.createElement('div');
    header.className = 'seq-channel-card-header';
    const titleBox = document.createElement('div');
    const title = document.createElement('span');
    title.className = 'seq-channel-card-title mono';
    title.textContent = String(channel.name || 'CH' + channel.channel_index);
    titleBox.appendChild(title);
    const meta = document.createElement('p');
    meta.className = 'seq-channel-card-meta';
    meta.textContent = model.completed + ' / ' + model.total + ' 步完成';
    titleBox.appendChild(meta);
    header.appendChild(titleBox);

    const overallEl = document.createElement('span');
    overallEl.className = 'seq-channel-overall';
    overallEl.textContent = cardStatusText;
    header.appendChild(overallEl);
    card.appendChild(header);

    const current = document.createElement('div');
    current.className = 'seq-channel-card-current';
    const currentLabel = document.createElement('span');
    currentLabel.className = 'seq-channel-card-current-label';
    currentLabel.textContent = model.state === 'running' && model.currentPosition != null
      ? '当前步骤 ' + String(model.currentPosition + 1).padStart(2, '0')
      : '当前状态';
    const currentName = document.createElement('strong');
    currentName.textContent = model.currentName;
    const currentTime = document.createElement('span');
    currentTime.className = 'mono seq-channel-card-current-time';
    currentTime.textContent = model.currentElapsedMs == null ? '—' : formatSequenceElapsed(model.currentElapsedMs);
    current.appendChild(currentLabel);
    current.appendChild(currentName);
    current.appendChild(currentTime);
    card.appendChild(current);

    const progress = document.createElement('div');
    progress.className = 'seq-channel-card-progress';
    const progressBar = document.createElement('span');
    const percent = model.total ? Math.min(100, Math.round(model.completed / model.total * 100)) : 0;
    progressBar.style.width = percent + '%';
    progress.appendChild(progressBar);
    card.appendChild(progress);

    const footer = document.createElement('div');
    footer.className = 'seq-channel-card-footer';
    footer.innerHTML =
      '<span>通过 <strong>' + model.passed + '</strong></span>' +
      '<span>失败 <strong>' + model.failed + '</strong></span>' +
      '<span>跳过 <strong>' + model.skipped + '</strong></span>' +
      '<span class="seq-channel-card-total-time">总耗时 <strong class="mono">' + escapeHtml(formatSequenceElapsed(model.elapsedMs)) + '</strong></span>';
    card.appendChild(footer);

    const affordance = document.createElement('span');
    affordance.className = 'seq-channel-card-affordance';
    affordance.textContent = '查看通道详情 →';
    card.appendChild(affordance);
    card.addEventListener('click', function () {
      openSeqChannelDetail(channel.channel_index);
    });
    card.addEventListener('keydown', function (event) {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      openSeqChannelDetail(channel.channel_index);
    });
    host.appendChild(card);
  });
  if (focusedChannelIndex != null) {
    const focusedCard = host.querySelector('.seq-channel-card[data-channel-index="' + focusedChannelIndex + '"]');
    if (focusedCard) focusedCard.focus();
  }
}

function sequenceRunQueueItems() {
  return seqSelected.filter(function (item) {
    return item && item.template_source !== 'group';
  });
}

function sequenceChannelsForDisplay() {
  const enabled = enabledAgentChannels();
  if (!enabled.length && seqChannelProgress.length) {
    return seqChannelProgress.slice().sort(function (a, b) {
      return Number(a.channel_index) - Number(b.channel_index);
    });
  }
  const pending = pendingSequenceChannelsForOperator(enabled, seqSelectedChannelIndexes);
  if (!seqChannelProgress.length) return pending;
  const progressByIndex = {};
  seqChannelProgress.forEach(function (channel) {
    progressByIndex[channel.channel_index] = channel;
  });
  return pending.map(function (channel) {
    return progressByIndex[channel.channel_index] || channel;
  });
}

function openSeqChannelDetail(channelIndex) {
  seqActiveDetailChannelIndex = channelIndex;
  renderSeqChannelDetail();
  const detail = document.getElementById('seq-channel-detail');
  if (detail) detail.scrollIntoView({ block: 'start', behavior: 'smooth' });
}

function closeSeqChannelDetail() {
  seqActiveDetailChannelIndex = null;
  renderSeqChannelDetail();
  const overview = document.getElementById('seq-channel-overview');
  if (overview) overview.scrollIntoView({ block: 'start', behavior: 'smooth' });
}

function moveSeqChannelDetail(offset) {
  const channels = sequenceChannelsForDisplay();
  const currentIndex = channels.findIndex(function (channel) {
    return channel.channel_index === seqActiveDetailChannelIndex;
  });
  if (currentIndex < 0) return;
  const target = channels[currentIndex + offset];
  if (!target) return;
  seqActiveDetailChannelIndex = target.channel_index;
  renderSeqChannelDetail();
}

function appendSequenceJsonBlock(parent, title, value) {
  const details = document.createElement('details');
  details.className = 'seq-channel-step-data';
  const summary = document.createElement('summary');
  summary.textContent = title;
  const pre = document.createElement('pre');
  pre.className = 'mono';
  pre.textContent = value == null ? '—' : JSON.stringify(value, null, 2);
  details.appendChild(summary);
  details.appendChild(pre);
  parent.appendChild(details);
}

function appendSequenceDetailStep(parent, step, model) {
  const row = document.createElement('details');
  row.className = 'seq-channel-step-row';
  row.setAttribute('data-state', sequenceStatusVisualState(step.status));
  row.setAttribute('data-position', String(step.position));
  if ((model.expandedPositions && model.expandedPositions[step.position]) || step.status === 'running' || isSequenceIssueStatus(step.status)) row.open = true;
  const summary = document.createElement('summary');
  summary.className = 'seq-channel-step-summary';
  const number = document.createElement('span');
  number.className = 'seq-channel-step-number mono';
  number.textContent = String(step.position + 1).padStart(2, '0');
  const name = document.createElement('strong');
  name.className = 'seq-channel-step-name';
  name.textContent = step.name;
  const result = document.createElement('span');
  result.className = 'seq-channel-step-status';
  result.textContent = formatStepStatus(step.status === 'pending' ? '' : step.status);
  if (step.status === 'pending') result.textContent = '待执行';
  const measured = document.createElement('span');
  measured.className = 'seq-channel-step-measured mono';
  measured.textContent = formatMeasuredSummary(step.result && step.result.measured);
  const spec = document.createElement('span');
  spec.className = 'seq-channel-step-spec';
  const limits = Array.isArray(step.item && step.item.limits) ? step.item.limits : [];
  spec.textContent = limits.length ? 'Spec · ' + limits.length + ' 项' : '未配置 Spec';
  const stepTime = document.createElement('span');
  stepTime.className = 'seq-channel-step-elapsed mono';
  stepTime.textContent = step.status === 'running' && model.currentElapsedMs != null
    ? formatSequenceElapsed(model.currentElapsedMs)
    : formatSequenceElapsed(step.elapsedMs);
  summary.appendChild(number);
  summary.appendChild(name);
  summary.appendChild(result);
  summary.appendChild(measured);
  summary.appendChild(spec);
  summary.appendChild(stepTime);
  row.appendChild(summary);

  const body = document.createElement('div');
  body.className = 'seq-channel-step-body';
  const metrics = buildSequenceMetricRows(step.item, step.result);
  if (metrics.length) {
    const table = document.createElement('table');
    table.className = 'seq-channel-metrics-table';
    table.innerHTML = '<thead><tr><th>输出</th><th>实测</th><th>下限/期望</th><th>上限</th><th>单位</th><th>结果</th></tr></thead><tbody>' + metrics.map(function (metric) {
      return '<tr><td>' + escapeHtml(metric.output) + '</td><td class="mono">' + escapeHtml(metric.value) + '</td><td class="mono">' + escapeHtml(metric.min) + '</td><td class="mono">' + escapeHtml(metric.max) + '</td><td>' + escapeHtml(metric.unit) + '</td><td>' + escapeHtml(metric.result) + '</td></tr>';
    }).join('') + '</tbody>';
    body.appendChild(table);
  }
  appendSequenceJsonBlock(body, '配置输入', step.item && step.item.inputs);
  appendSequenceJsonBlock(body, '完整输出', step.result && step.result.result);
  appendSequenceJsonBlock(body, '原始步骤 JSON', step.result);
  const logPath = lastAgentStatus && lastAgentStatus.log_dir
    ? lastAgentStatus.log_dir + '\\sequence_runs'
    : 'Agent 日志目录 sequence_runs';
  appendSequenceJsonBlock(body, '运行日志', { path: logPath });
  if (step.result && step.result.error) {
    const error = document.createElement('p');
    error.className = 'seq-channel-step-error mono';
    error.textContent = step.result.error;
    body.appendChild(error);
  }
  row.appendChild(body);
  parent.appendChild(row);
  return row;
}

function formatSequenceGroupStatus(state) {
  if (state === 'disabled') return '已禁用';
  if (state === 'running') return '执行中';
  if (state === 'fail') return '失败';
  if (state === 'pass') return '通过';
  if (state === 'skipped') return '已跳过';
  return '待执行';
}

function renderSeqChannelDetail() {
  const overview = document.getElementById('seq-channel-overview');
  const detail = document.getElementById('seq-channel-detail');
  if (!overview || !detail) return;
  if (seqActiveDetailChannelIndex == null) {
    overview.hidden = false;
    detail.hidden = true;
    return;
  }
  const channels = sequenceChannelsForDisplay();
  const channelIndex = channels.findIndex(function (entry) {
    return entry.channel_index === seqActiveDetailChannelIndex;
  });
  if (channelIndex < 0) {
    seqActiveDetailChannelIndex = null;
    overview.hidden = false;
    detail.hidden = true;
    return;
  }
  const model = buildSequenceChannelDetailModel(channels[channelIndex], seqSelected);
  const cardModel = buildSequenceChannelCardModel(channels[channelIndex], sequenceRunQueueItems());
  overview.hidden = true;
  detail.hidden = false;
  detail.setAttribute('data-state', cardModel.state);
  const title = document.getElementById('seq-channel-detail-title');
  const status = document.getElementById('seq-channel-detail-status');
  const elapsed = document.getElementById('seq-channel-detail-elapsed');
  const counts = document.getElementById('seq-channel-detail-counts');
  if (title) title.textContent = model.name;
  if (status) status.textContent = formatSequenceOverall(model.overall);
  if (elapsed) elapsed.textContent = '总耗时 ' + formatSequenceElapsed(model.elapsedMs);
  if (counts) {
    counts.textContent = model.namedGroupCount + ' 个组 · ' + cardModel.total + ' 个步骤 · 通过 ' + cardModel.passed +
      ' · 失败 ' + cardModel.failed +
      ' · 跳过 ' + cardModel.skipped;
  }

  const prev = document.getElementById('seq-channel-detail-prev');
  const next = document.getElementById('seq-channel-detail-next');
  if (prev) prev.disabled = channelIndex === 0;
  if (next) next.disabled = channelIndex === channels.length - 1;

  const current = document.getElementById('seq-channel-current');
  if (current) {
    current.innerHTML = '';
    const kicker = document.createElement('span');
    kicker.className = 'seq-channel-current-kicker';
    kicker.textContent = model.currentPosition != null ? '正在执行 · 第 ' + (model.currentPosition + 1) + ' 步' : '当前状态';
    const name = document.createElement('strong');
    name.textContent = model.currentName || cardModel.currentName;
    const time = document.createElement('span');
    time.className = 'mono seq-channel-current-time';
    time.textContent = model.currentElapsedMs == null ? '—' : formatSequenceElapsed(model.currentElapsedMs);
    current.appendChild(kicker);
    current.appendChild(name);
    current.appendChild(time);
  }

  const host = document.getElementById('seq-channel-detail-steps');
  if (!host) return;
  const expandedPositions = {};
  host.querySelectorAll('.seq-channel-step-row[open][data-position]').forEach(function (entry) {
    expandedPositions[entry.getAttribute('data-position')] = true;
  });
  const groupOpenByKey = {};
  host.querySelectorAll('.seq-channel-group[data-group-key]').forEach(function (entry) {
    groupOpenByKey[entry.getAttribute('data-group-key')] = entry.open;
  });
  let focusedPosition = null;
  let focusedGroupKey = null;
  if (document.activeElement && host.contains(document.activeElement)) {
    const focusedGroup = document.activeElement.closest('.seq-channel-group[data-group-key]');
    if (focusedGroup && document.activeElement === focusedGroup.querySelector('.seq-channel-group-summary')) {
      focusedGroupKey = focusedGroup.getAttribute('data-group-key');
    } else {
      const focusedRow = document.activeElement.closest('.seq-channel-step-row[data-position]');
      if (focusedRow && document.activeElement === focusedRow.querySelector('.seq-channel-step-summary')) {
        focusedPosition = focusedRow.getAttribute('data-position');
      }
    }
  }
  const previousCurrent = host.getAttribute('data-current-position');
  const nextCurrent = model.currentPosition == null ? '' : String(model.currentPosition);
  host.innerHTML = '';
  host.setAttribute('data-current-position', nextCurrent);
  model.expandedPositions = expandedPositions;
  model.sections.forEach(function (section) {
    const group = document.createElement('details');
    group.className = 'seq-channel-group';
    group.setAttribute('data-group-key', section.key);
    group.setAttribute('data-state', section.summary.state);
    const hasPreservedOpen = Object.prototype.hasOwnProperty.call(groupOpenByKey, section.key);
    group.open = resolveSequenceGroupOpen(
      section.summary.open,
      hasPreservedOpen ? groupOpenByKey[section.key] : null,
      section.summary.state === 'running' || section.summary.state === 'fail'
    );

    const summary = document.createElement('summary');
    summary.className = 'seq-channel-group-summary';
    const marker = document.createElement('span');
    marker.className = 'seq-channel-group-marker';
    marker.textContent = section.kind === 'ungrouped' ? '未分组' : '组';
    const heading = document.createElement('span');
    heading.className = 'seq-channel-group-heading';
    const title = document.createElement('strong');
    title.textContent = section.title;
    heading.appendChild(title);
    if (section.note) {
      const note = document.createElement('span');
      note.className = 'seq-channel-group-note';
      note.textContent = section.note;
      heading.appendChild(note);
    }
    const groupStatus = document.createElement('span');
    groupStatus.className = 'seq-channel-group-status';
    groupStatus.textContent = formatSequenceGroupStatus(section.summary.state);
    const groupCounts = document.createElement('span');
    groupCounts.className = 'seq-channel-group-counts';
    groupCounts.textContent = section.summary.completed + ' / ' + section.summary.total +
      ' · 通过 ' + section.summary.passed +
      ' · 失败 ' + section.summary.failed +
      ' · 跳过 ' + section.summary.skipped;
    summary.appendChild(marker);
    summary.appendChild(heading);
    summary.appendChild(groupStatus);
    summary.appendChild(groupCounts);
    group.appendChild(summary);

    const body = document.createElement('div');
    body.className = 'seq-channel-group-body';
    const guide = document.createElement('span');
    guide.className = 'seq-channel-group-guide';
    guide.setAttribute('aria-hidden', 'true');
    body.appendChild(guide);
    if (section.steps.length) {
      section.steps.forEach(function (step) { appendSequenceDetailStep(body, step, model); });
    } else {
      const empty = document.createElement('p');
      empty.className = 'seq-channel-group-empty';
      empty.textContent = '该组暂无步骤';
      body.appendChild(empty);
    }
    group.appendChild(body);
    host.appendChild(group);
  });
  if (focusedGroupKey != null) {
    const focusedGroup = Array.prototype.find.call(host.querySelectorAll('.seq-channel-group[data-group-key]'), function (entry) {
      return entry.getAttribute('data-group-key') === focusedGroupKey;
    });
    const focusedSummary = focusedGroup && focusedGroup.querySelector('.seq-channel-group-summary');
    focusSequenceDetailSummary(focusedSummary);
  } else if (focusedPosition != null) {
    const focusedSummary = host.querySelector('.seq-channel-step-row[data-position="' + focusedPosition + '"] > summary');
    focusSequenceDetailSummary(focusedSummary);
  }
  if (nextCurrent && nextCurrent !== previousCurrent) {
    const activeRow = host.querySelector('.seq-channel-step-row[data-position="' + nextCurrent + '"]');
    if (activeRow) activeRow.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}

function clearSequenceResultsUi() {
  seqStepResults = {};
  seqChannelProgress = [];
  updateSeqOverall({});
  const resultsEl = document.getElementById('seq-results');
  if (resultsEl) {
    resultsEl.innerHTML = '';
    resultsEl.hidden = true;
  }
  renderSeqChannelCards();
  renderSeqChannelDetail();
  renderSeqSelected();
}

function startSequenceProgressPoll() {
  stopSequenceProgressPoll();
  const generation = seqProgressGeneration;
  seqProgressPollTimer = setInterval(async function () {
    try {
      const resp = await fetch('/api/sequence/run/progress');
      if (!resp.ok) return;
      const prog = await resp.json();
      if (generation !== seqProgressGeneration) return;
      applySequenceProgress(prog);
    } catch (e) {
      /* ignore transient poll errors */
    }
  }, 250);
}

function stopSequenceProgressPoll() {
  seqProgressGeneration += 1;
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
    const units = (centerUnits || []).map(normalizeSettingsUnit).filter(function (u) { return u.symbol; });
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
    if (currentUnit && unitSymbols(centerUnits || []).indexOf(currentUnit) < 0) {
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
  if (seqRunning) return;
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
  await Promise.all([
    loadSeqRegistered(),
    loadQueue(),
    loadSequenceTemplates(),
    loadAgentChannels(),
  ]);
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
    addBtn.disabled = seqRunning;
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
    loadBtn.disabled = seqRunning;
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
  btn.disabled = seqRunning || n < 1;
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
  if (seqRunning) return;
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
  if (seqRunning) return;
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
    tbody.innerHTML = '<tr><td colspan="5" class="empty">队列为空，展开上方「中心全部功能」后添加</td></tr>';
    setSeqControlsDisabled(false);
    seqFocusIndex = null;
    updateSeqInsertBadge();
    updateGroupSelectedBtn();
    updateSeqRunQueueSummary();
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
      row.draggable = !seqRunning;
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
      collapseBtn.disabled = seqRunning;
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
      enabledCb.disabled = seqRunning;
      enabledCb.addEventListener('change', async function () {
        item.enabled = enabledCb.checked;
        await saveQueue();
      });
      enTd.appendChild(enabledCb);
      row.appendChild(enTd);

      const nameTd = document.createElement('td');
      const folderMark = document.createElement('span');
      folderMark.className = 'seq-folder-mark';
      folderMark.textContent = '组 ';
      nameTd.appendChild(folderMark);
      const nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.className = 'seq-group-title';
      nameInput.value = item.name || '分组';
      nameInput.disabled = seqRunning;
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

      const actions = document.createElement('td');
      actions.className = 'seq-row-actions';
      const upBtn = document.createElement('button');
      upBtn.type = 'button';
      upBtn.textContent = '↑';
      upBtn.title = '上移整组';
      upBtn.disabled = seqRunning || i === 0;
      upBtn.addEventListener('click', function () { moveQueueItem(i, -1); });
      const downBtn = document.createElement('button');
      downBtn.type = 'button';
      downBtn.textContent = '↓';
      downBtn.title = '下移整组';
      downBtn.disabled = seqRunning || endOfGroup(i) >= seqSelected.length;
      downBtn.addEventListener('click', function () { moveQueueItem(i, 1); });
      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.textContent = '解散分组';
      removeBtn.title = '删除分组，保留组内步骤到根级';
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
        emptyTd.colSpan = 5;
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
    row.draggable = !seqRunning;
    row.className =
      'seq-row' +
      (inGroup ? ' seq-outline-child' : '') +
      (seqExpandedIndexes[i] ? ' seq-row-expanded' : '') +
      (flag.groupEnabled ? '' : ' seq-step-group-disabled') +
      (seqFocusIndex === i ? ' seq-row-focused' : '') +
      (seqCheckedIndexes[i] ? ' seq-row-picked' : '');
    const pos = item.position != null ? item.position : i;
    const source = item.template_source === 'general' ? 'general' : 'labview';
    const templateId = source === 'general' ? item.general_template_id : item.vi_template_id;
    const name = escapeHtml(item.name || templateId || '—');
    const kindDisplay = kindLabel(item.kind || 'labview');
    const enabled = item.enabled !== false;
    const failPolicy = item.fail_policy === 'continue' ? 'continue' : 'stop';
    const limits = Array.isArray(item.limits) ? item.limits : [];
    const expanded = !!seqExpandedIndexes[i];

    row.innerHTML =
      '<td class="mono"></td>' +
      '<td class="seq-check-cell"></td>' +
      '<td>' + name + '</td>' +
      '<td class="mono">' + kindDisplay + '</td>';

    const indexWrap = document.createElement('span');
    indexWrap.className = 'seq-outline-index';
    const pick = document.createElement('input');
    pick.type = 'checkbox';
    pick.className = 'seq-pick';
    pick.title = '勾选后可「编成一组」';
    pick.checked = !!seqCheckedIndexes[i];
    pick.disabled = seqRunning;
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
    enabledCb.disabled = seqRunning;
    enabledCb.addEventListener('change', async function () {
      item.enabled = enabledCb.checked;
      await saveQueue();
    });
    row.querySelector('.seq-check-cell').appendChild(enabledCb);

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
    detailTd.colSpan = 5;
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
    specBtn.disabled = seqRunning;
    specBtn.addEventListener('click', function () { editLimitsAt(i); });
    detailActions.appendChild(specBtn);

    const failWrap = document.createElement('label');
    failWrap.className = 'seq-fail-cell';
    failWrap.appendChild(document.createTextNode('Fail '));
    const failSel = document.createElement('select');
    failSel.innerHTML = '<option value="stop">停止</option><option value="continue">继续</option>';
    failSel.value = failPolicy;
    failSel.disabled = seqRunning;
    failSel.addEventListener('change', async function () {
      item.fail_policy = failSel.value === 'continue' ? 'continue' : 'stop';
      await saveQueue();
    });
    failWrap.appendChild(failSel);
    detailActions.appendChild(failWrap);
    panel.appendChild(detailActions);

    const resourcesHost = document.createElement('div');
    resourcesHost.className = 'step-resources';
    renderStepResourcesEditor(resourcesHost, item, i);
    panel.appendChild(resourcesHost);

    const measured = document.createElement('div');
    measured.className = 'seq-detail-measured mono';
    if (seqChannelProgress.length) {
      measured.textContent = '实测 / 原始返回见「序列运行」页的通道详情。';
      const openBtn = document.createElement('button');
      openBtn.type = 'button';
      openBtn.className = 'btn-sm seq-open-report-btn';
      openBtn.textContent = '打开通道详情';
      openBtn.addEventListener('click', function (ev) {
        ev.stopPropagation();
        showPage('sequence-run');
        openSeqChannelDetail(seqChannelProgress[0].channel_index);
      });
      panel.appendChild(measured);
      panel.appendChild(openBtn);
    } else {
      measured.textContent = '实测: —（请到「序列运行」页执行后查看）';
      panel.appendChild(measured);
    }

    detailTd.appendChild(panel);
    detailRow.appendChild(detailTd);
    tbody.appendChild(detailRow);
  }
  setSeqControlsDisabled(seqRunning);
  updateSeqInsertBadge();
  updateGroupSelectedBtn();
  updateSeqRunQueueSummary();
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
  editBtn.disabled = seqRunning;
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
        breakpoint: false,
        fail_policy: item.fail_policy === 'continue' ? 'continue' : 'stop',
        limits: Array.isArray(item.limits) ? item.limits : [],
        note: item.note || '',
        resources: Array.isArray(item.resources) ? item.resources : [],
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
    resources: [],
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
  if (seqRunning) {
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
  if (seqDragIndex == null || seqRunning) {
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
  if (container) {
    container.innerHTML = '';
    container.hidden = true;
  }
  const envelope = multiEnvelopeToProgress(data);
  seqChannelProgress = channelProgressFromEnvelope(envelope);
  if (!seqChannelProgress.length) return;
  renderSeqChannelCards();
  renderSeqChannelDetail();
}

function multiEnvelopeToProgress(data) {
  if (!data) return { running: false, channels: [] };
  if (Array.isArray(data.channels) && data.channels.length) {
    return {
      running: false,
      overall: data.overall,
      channels: data.channels.map(function (ch) {
        const resp = ch.response || {};
        return {
          channel_index: ch.channel_index,
          name: ch.channel_name || ch.name || ('CH' + ch.channel_index),
          steps: Array.isArray(resp.steps) ? resp.steps : Array.isArray(ch.steps) ? ch.steps : [],
          overall: resp.overall != null ? resp.overall : ch.overall,
          current_position: null,
          current_name: null,
          elapsed_ms: resp.elapsed_ms != null ? resp.elapsed_ms : ch.elapsed_ms,
          current_step_elapsed_ms: null,
        };
      }),
    };
  }
  return {
    running: false,
    overall: data.overall,
    channels: [
      {
        channel_index: 0,
        name: 'CH0',
        steps: Array.isArray(data.steps) ? data.steps : [],
        overall: data.overall,
        elapsed_ms: data.elapsed_ms,
        current_step_elapsed_ms: null,
      },
    ],
    steps: data.steps,
  };
}

/** Station overall is often "fail" on abort; detect via per-channel aborted/stopped. */
function sequenceWasAborted(data) {
  if (!data) return false;
  if (String(data.overall || '').toLowerCase() === 'aborted') return true;
  function stepsHaveAborted(steps) {
    if (!Array.isArray(steps)) return false;
    for (let i = 0; i < steps.length; i++) {
      if (String((steps[i] && steps[i].status) || '').toLowerCase() === 'aborted') {
        return true;
      }
    }
    return false;
  }
  function channelLooksAborted(ch) {
    if (!ch) return false;
    const resp = ch.response || ch;
    const ov = String(
      (resp && resp.overall != null ? resp.overall : ch.overall) || ''
    ).toLowerCase();
    if (ov === 'aborted') return true;
    if (stepsHaveAborted((resp && resp.steps) || ch.steps)) return true;
    // Cancel path sets stopped + aborted overall; if overall missing, stopped+aborted step counts.
    if (resp && resp.stopped && (ov === 'aborted' || stepsHaveAborted(resp.steps))) {
      return true;
    }
    return false;
  }
  if (Array.isArray(data.channels)) {
    for (let i = 0; i < data.channels.length; i++) {
      if (channelLooksAborted(data.channels[i])) return true;
    }
  }
  return stepsHaveAborted(data.steps);
}

function handleSequenceResponse(data) {
  const envelope = multiEnvelopeToProgress(data);
  applyMultiChannelProgress(envelope);
  updateSeqOverall(data);
  renderSeqResults(data);
  renderSeqSelected();
  if (sequenceWasAborted(data)) {
    showSeqMsg('已中止', false);
    return 'aborted';
  }
  // Per-channel fail_policy stop (not abort).
  if (Array.isArray(data.channels) && data.channels.length) {
    for (let i = 0; i < data.channels.length; i++) {
      const resp = data.channels[i].response || data.channels[i];
      if (resp && resp.stopped) {
        const at = resp.failed_at != null ? resp.failed_at : 0;
        const chName =
          data.channels[i].channel_name ||
          data.channels[i].name ||
          'CH' + data.channels[i].channel_index;
        showSeqMsg(
          '通道 ' +
            chName +
            ' 中止于第 ' +
            (at + 1) +
            ' 步 · 总体：' +
            formatSequenceOverall(data.overall),
          false
        );
        return 'stopped';
      }
    }
  } else if (data.stopped) {
    showSeqMsg(
      '执行中止于第 ' + ((data.failed_at != null ? data.failed_at : 0) + 1) + ' 步',
      false
    );
    return 'stopped';
  }
  if (data.overall === 'pass' || data.overall === 'ok') {
    showSeqMsg('全部执行成功', true);
    const runMsg = document.getElementById('seq-run-msg');
    if (runMsg) {
      runMsg.hidden = true;
      runMsg.textContent = '';
    }
    return 'done';
  }
  showSeqMsg(
    '执行完成 · 总体：' + formatSequenceOverall(data.overall),
    data.overall === 'pass'
  );
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
  if (seqRunning || !seqSelected.length) return;
  const channel_indexes = selectedChannelIndexesForRun();
  if (Array.isArray(channel_indexes) && channel_indexes.length === 0) {
    showSeqMsg('请至少选择一个通道', false);
    return;
  }
  setSeqControlsDisabled(true);
  clearSequenceResultsUi();
  document.getElementById('seq-results').innerHTML = '';
  updateSeqOverall({ overall: 'running' });
  showSeqMsg('执行中…', true);
  const payload = {};
  if (seqActiveTemplateId != null) payload.sequence_template_id = seqActiveTemplateId;
  if (Array.isArray(channel_indexes)) payload.channel_indexes = channel_indexes;
  startSequenceProgressPoll();
  try {
    const resp = await fetch('/api/sequence/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await resp.json();
    if (!resp.ok) {
      setSeqRequestFailureState();
      if (resp.status === 409) {
        const tip = formatBusyConflictMessage(data);
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
    setSeqRequestFailureState();
    showSeqMsg('执行失败: ' + e.message, false);
  } finally {
    stopSequenceProgressPoll();
    setSeqControlsDisabled(false);
    renderSeqChannelPick();
    renderSeqRegistered();
  }
}

async function abortSequence() {
  if (!seqRunning) return;
  const abortBtn = document.getElementById('seq-abort-btn');
  if (abortBtn) abortBtn.disabled = true;
  showSeqMsg('中止中…', true);
  try {
    const resp = await fetch('/api/sequence/run/abort', { method: 'POST' });
    const data = await resp.json();
    if (!resp.ok) {
      const err = data.error && (data.error.message || data.error) || resp.status;
      showSeqMsg('中止失败: ' + err, false);
      if (abortBtn) abortBtn.disabled = false;
      return;
    }
    // Cancel is async: workers stop between steps / lock waits; runSequence handles final result.
    showSeqMsg('中止已请求…', true);
  } catch (e) {
    showSeqMsg('中止失败: ' + e.message, false);
    if (abortBtn) abortBtn.disabled = false;
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
const seqGotoRunBtn = document.getElementById('seq-goto-run-btn');
if (seqGotoRunBtn) {
  seqGotoRunBtn.addEventListener('click', function () {
    showPage('sequence-run');
  });
}
const seqGotoEditBtn = document.getElementById('seq-goto-edit-btn');
if (seqGotoEditBtn) {
  seqGotoEditBtn.addEventListener('click', function () {
    showPage('sequence-edit');
  });
}
const seqChannelDetailBack = document.getElementById('seq-channel-detail-back');
if (seqChannelDetailBack) seqChannelDetailBack.addEventListener('click', closeSeqChannelDetail);
const seqChannelDetailPrev = document.getElementById('seq-channel-detail-prev');
if (seqChannelDetailPrev) {
  seqChannelDetailPrev.addEventListener('click', function () { moveSeqChannelDetail(-1); });
}
const seqChannelDetailNext = document.getElementById('seq-channel-detail-next');
if (seqChannelDetailNext) {
  seqChannelDetailNext.addEventListener('click', function () { moveSeqChannelDetail(1); });
}
const seqInsertGroupBtn = document.getElementById('seq-insert-group');
if (seqInsertGroupBtn) seqInsertGroupBtn.addEventListener('click', insertSeqGroup);
const seqGroupSelectedBtn = document.getElementById('seq-group-selected');
if (seqGroupSelectedBtn) seqGroupSelectedBtn.addEventListener('click', groupCheckedIntoFolder);
const forceReleaseBtn = document.getElementById('force-release-btn');
if (forceReleaseBtn) forceReleaseBtn.addEventListener('click', forceReleaseSlot);
const seqSaveTemplateBtn = document.getElementById('seq-save-template-btn');
if (seqSaveTemplateBtn) seqSaveTemplateBtn.addEventListener('click', saveCurrentQueueAsSequenceTemplate);
const seqAbortBtn = document.getElementById('seq-abort-btn');
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
const settingsVarAddBtn = document.getElementById('settings-var-add-btn');
const settingsChannelAddBtn = document.getElementById('settings-channel-add-btn');
const settingsChannelsSaveBtn = document.getElementById('settings-channels-save-btn');
const settingsImportDeviceCfgBtn = document.getElementById('settings-import-device-cfg-btn');
const settingsDeviceCfgFile = document.getElementById('settings-device-cfg-file');
const settingsImportCalibrationCfgBtn = document.getElementById('settings-import-calibration-cfg-btn');
const settingsCalibrationCfgFile = document.getElementById('settings-calibration-cfg-file');
const settingsDeviceProfileNewBtn = document.getElementById('settings-device-profile-new-btn');
const settingsCalibrationProfileNewBtn = document.getElementById('settings-calibration-profile-new-btn');
const deviceCfgImportCancelBtn = document.getElementById('device-cfg-import-cancel-btn');
const deviceCfgImportApplyBtn = document.getElementById('device-cfg-import-apply-btn');
const profileViewCloseBtn = document.getElementById('profile-view-close-btn');
const profileViewExportBtn = document.getElementById('profile-view-export-btn');
if (settingsSaveBtn) settingsSaveBtn.addEventListener('click', saveAgentSettings);
if (settingsVarAddBtn) settingsVarAddBtn.addEventListener('click', addSettingsVar);
if (settingsChannelAddBtn) settingsChannelAddBtn.addEventListener('click', addAgentChannelRow);
if (settingsChannelsSaveBtn) settingsChannelsSaveBtn.addEventListener('click', saveAgentChannels);
const settingsArrayExpandMode = document.getElementById('settings-array-expand-mode');
if (settingsArrayExpandMode) {
  settingsArrayExpandMode.addEventListener('change', function () {
    agentSettings.array_expand_mode = getArrayExpandModeFromDom();
    markSettingsDirty();
  });
}
function wireIniFileImport(btn, fileInput, kind) {
  if (!btn || !fileInput) return;
  btn.addEventListener('click', function () {
    fileInput.value = '';
    fileInput.click();
  });
  fileInput.addEventListener('change', function () {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function () {
      openProfileImportPreview(String(reader.result || ''), kind, file.name || '');
    };
    reader.onerror = function () {
      showSettingsMsg('读取文件失败', false);
    };
    reader.readAsText(file);
  });
}
wireIniFileImport(settingsImportDeviceCfgBtn, settingsDeviceCfgFile, 'device');
wireIniFileImport(settingsImportCalibrationCfgBtn, settingsCalibrationCfgFile, 'calibration');
const settingsDeviceFlatSaveBtn = document.getElementById('settings-device-flat-save-btn');
const settingsCalibrationFlatSaveBtn = document.getElementById('settings-calibration-flat-save-btn');
if (settingsDeviceFlatSaveBtn) {
  settingsDeviceFlatSaveBtn.addEventListener('click', function () {
    saveActiveProfileFlat('device');
  });
}
if (settingsCalibrationFlatSaveBtn) {
  settingsCalibrationFlatSaveBtn.addEventListener('click', function () {
    saveActiveProfileFlat('calibration');
  });
}
if (settingsDeviceProfileNewBtn) {
  settingsDeviceProfileNewBtn.addEventListener('click', function () {
    createEmptyConfigProfile('device');
  });
}
if (settingsCalibrationProfileNewBtn) {
  settingsCalibrationProfileNewBtn.addEventListener('click', function () {
    createEmptyConfigProfile('calibration');
  });
}
if (deviceCfgImportCancelBtn) {
  deviceCfgImportCancelBtn.addEventListener('click', closeDeviceCfgImportModal);
}
if (deviceCfgImportApplyBtn) {
  deviceCfgImportApplyBtn.addEventListener('click', applyDeviceCfgImportPreview);
}
if (profileViewCloseBtn) {
  profileViewCloseBtn.addEventListener('click', closeProfileViewModal);
}
if (profileViewExportBtn) {
  profileViewExportBtn.addEventListener('click', exportViewedProfileToml);
}
const profileViewModal = document.getElementById('profile-view-modal');
if (profileViewModal) {
  profileViewModal.addEventListener('click', function (ev) {
    if (ev.target === profileViewModal) closeProfileViewModal();
  });
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

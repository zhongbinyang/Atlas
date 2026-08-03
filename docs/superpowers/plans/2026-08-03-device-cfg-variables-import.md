# Device_CFG → Agent Variables Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On the Agent 配置 page, let operators pick a local `Device_CFG.ini`, preview whitelist-mapped address variables, merge them into the settings editor, and save via existing `PUT /api/settings`.

**Architecture:** 100% WebUI for v1: pure JS INI parse + whitelist map + merge into `agentSettings` / DOM; no new center table or Agent upload API. Reuse existing dirty/save flow (`markSettingsDirty` → `saveAgentSettings`). Spec: `docs/superpowers/specs/2026-08-03-device-cfg-variables-import-design.md`.

**Tech Stack:** Agent static UI (`index.html`, `app.js`, `style.css`), `static_ui.rs` string asserts, existing settings APIs.

## Global Constraints

- Do not read `docs/CFG` at Agent runtime.
- Import only whitelist keys: `IP_Add`, `Com_Add`, `Intru_Com_Add`, `COM`, `EVB_SN`, `Port`.
- Variable name = sanitized `{Section}_{Key}`, must match `^[A-Za-z_][A-Za-z0-9_]*$`, max 64.
- Empty values skipped; `##` commented lines skipped.
- Merge: overwrite same name, append new; leave Hostname/IP and other vars alone.
- Primary UX: preview → 合并到编辑区 → user clicks 保存 (no required 导入并保存).
- Do not commit unrelated WIP (grouping / version) in the same commits as this feature unless the user asks.

## File map

| File | Responsibility |
|------|----------------|
| `crates/agent/static/app.js` | Pure parse/map/merge helpers + file/modal wiring |
| `crates/agent/static/index.html` | Import button, hidden file input, preview modal, help bullet |
| `crates/agent/static/style.css` | Preview modal table sizing if needed (reuse `.spec-modal`) |
| `crates/agent/tests/static_ui.rs` | Assert controls + helper names present |
| `docs/api.md` | One short note under Agent settings that Device_CFG import feeds variables |

---

### Task 1: Pure parse / map / merge helpers + failing static_ui gate

**Files:**
- Modify: `crates/agent/tests/static_ui.rs` (settings-related test or new assert block)
- Modify: `crates/agent/static/app.js` (add helpers near settings section, after `isSystemVarName`)

**Interfaces:**
- Produces:
  - `DEVICE_CFG_ADDRESS_KEYS` — object/set of whitelist key names
  - `sanitizeDeviceCfgIdent(raw: string): string`
  - `normalizeDeviceCfgValue(raw: string): string`
  - `parseDeviceCfgIni(text: string): Array<{ section: string, key: string, value: string }>`
  - `mapDeviceCfgToVariables(entries): { rows: Array<{ name, value, description, section, key, status }>, skipped: Array<{ reason, section?, key? }> }` where `status` is computed later against existing names; mapping step may return `mapped` without status
  - `buildDeviceCfgImportPreview(text, existingVariables): { rows: Array<{ name, value, description, section, key, status: 'add'|'update'|'skip' }>, summary: { added, updated, skipped } }`
  - `mergeDeviceCfgPreviewIntoVariables(existingVariables, previewRows): Array<{ name, value, description }>` — applies only `add`/`update` rows

- [ ] **Step 1: Write failing static_ui asserts**

In `settings_page_exposes_units_and_variables` (or adjacent test in `static_ui.rs`), add:

```rust
assert!(
    APP.contains("DEVICE_CFG_ADDRESS_KEYS")
        && APP.contains("parseDeviceCfgIni")
        && APP.contains("buildDeviceCfgImportPreview")
        && APP.contains("mergeDeviceCfgPreviewIntoVariables")
        && APP.contains("sanitizeDeviceCfgIdent"),
    "settings must expose Device_CFG.ini parse/preview/merge helpers"
);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p agent --test static_ui settings_page_exposes_units_and_variables -- --nocapture`

Expected: FAIL — missing helper strings in `APP`.

- [ ] **Step 3: Implement helpers in `app.js`**

Insert after `isSystemVarName` (approx line 168):

```javascript
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
```

- [ ] **Step 4: Run static_ui test to verify it passes**

Run: `cargo test -p agent --test static_ui settings_page_exposes_units_and_variables -- --nocapture`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add crates/agent/static/app.js crates/agent/tests/static_ui.rs
git commit -m "feat(agent): add Device_CFG.ini parse and preview helpers"
```

---

### Task 2: Settings UI chrome — button, file input, preview modal

**Files:**
- Modify: `crates/agent/static/index.html` (vars card head + modal near other modals)
- Modify: `crates/agent/static/style.css` (only if preview table needs scroll; prefer reuse `.spec-modal`)
- Modify: `crates/agent/tests/static_ui.rs`

**Interfaces:**
- Consumes: none from Task 1 runtime yet
- Produces: DOM ids `settings-import-device-cfg-btn`, `settings-device-cfg-file`, `device-cfg-import-modal`, `device-cfg-import-summary`, `device-cfg-import-body`, `device-cfg-import-cancel-btn`, `device-cfg-import-apply-btn`

- [ ] **Step 1: Extend failing asserts for DOM ids**

```rust
assert!(
    INDEX.contains("id=\"settings-import-device-cfg-btn\"")
        && INDEX.contains("id=\"settings-device-cfg-file\"")
        && INDEX.contains("id=\"device-cfg-import-modal\"")
        && INDEX.contains("id=\"device-cfg-import-apply-btn\""),
    "settings page must expose Device_CFG import controls and preview modal"
);
```

- [ ] **Step 2: Run test — expect FAIL**

Run: `cargo test -p agent --test static_ui settings_page_exposes_units_and_variables -- --nocapture`

- [ ] **Step 3: Update `index.html`**

In `#settings-vars-card` `.settings-card-head`, next to `settings-var-add-btn`:

```html
<button type="button" id="settings-import-device-cfg-btn" class="btn-sm" title="从旧测控 Device_CFG.ini 导入地址类变量">导入 Device_CFG…</button>
<input id="settings-device-cfg-file" type="file" accept=".ini,text/plain" hidden>
```

In `settings-help` `<ul>`, add:

```html
<li>可将旧测控 <code class="mono">Device_CFG.ini</code> 导入为地址类变量（如 <code class="mono">${DCA_Setting_Intru_Com_Add}</code>）；导入后需点<strong>保存</strong>。</li>
```

Near other modals (before `</body>` scripts area), add:

```html
<div id="device-cfg-import-modal" class="spec-modal" hidden>
  <div class="spec-modal-card" style="max-width: 42rem;">
    <h3>导入 Device_CFG 预览</h3>
    <p id="device-cfg-import-summary" class="muted-hint"></p>
    <div class="table-scroll" style="max-height: 16rem;">
      <table class="settings-table">
        <thead>
          <tr>
            <th>状态</th>
            <th>变量名</th>
            <th>值</th>
            <th>来源</th>
          </tr>
        </thead>
        <tbody id="device-cfg-import-body"></tbody>
      </table>
    </div>
    <div class="spec-modal-actions">
      <button type="button" id="device-cfg-import-cancel-btn">取消</button>
      <button type="button" id="device-cfg-import-apply-btn" class="btn-primary">合并到编辑区</button>
    </div>
  </div>
</div>
```

- [ ] **Step 4: Run static_ui — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add crates/agent/static/index.html crates/agent/tests/static_ui.rs
git commit -m "feat(agent): add Device_CFG import UI chrome on settings page"
```

---

### Task 3: Wire file picker → preview → merge → dirty

**Files:**
- Modify: `crates/agent/static/app.js` (handlers + listeners near settings button wiring ~4730)

**Interfaces:**
- Consumes: Task 1 helpers; `agentSettings`, `collectSettingsFromDom`, `renderSettingsVars`, `markSettingsDirty`, `showSettingsMsg`
- Produces: `openDeviceCfgImportPreview(text)`, `applyDeviceCfgImportPreview()`, `pendingDeviceCfgPreview` module-level var

- [ ] **Step 1: Add wiring code**

Near other settings `let` state:

```javascript
let pendingDeviceCfgPreview = null;
```

Functions:

```javascript
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
      '将新增 ' +
      preview.summary.added +
      ' 个、覆盖 ' +
      preview.summary.updated +
      ' 个；另跳过 ' +
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
  showSettingsMsg('已合并 ' + n + ' 个变量到编辑区，请保存', true);
}
```

Wire listeners (with other settings buttons):

```javascript
const settingsImportDeviceCfgBtn = document.getElementById('settings-import-device-cfg-btn');
const settingsDeviceCfgFile = document.getElementById('settings-device-cfg-file');
const deviceCfgImportCancelBtn = document.getElementById('device-cfg-import-cancel-btn');
const deviceCfgImportApplyBtn = document.getElementById('device-cfg-import-apply-btn');
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
```

Also assert in `static_ui.rs`:

```rust
assert!(
    APP.contains("openDeviceCfgImportPreview")
        && APP.contains("applyDeviceCfgImportPreview"),
    "settings must wire Device_CFG import preview apply flow"
);
```

- [ ] **Step 2: Run `cargo test -p agent --test static_ui -- --test-threads=4`**

Expected: all PASS

- [ ] **Step 3: Manual smoke (engineer)**

1. Open Agent 配置 page (agent registered).
2. Import `docs/CFG/DUT_1_Config/Device_CFG.ini`.
3. Confirm preview shows e.g. `DCA_Setting_Intru_Com_Add`, `EVB_Setting_IP_Add`; no `EVB_Type`.
4. 合并到编辑区 → status 未保存 → 保存 → reload page, values persist.
5. In sequence/REST, `${DCA_Setting_Intru_Com_Add}` expands.

- [ ] **Step 4: Commit**

```bash
git add crates/agent/static/app.js crates/agent/tests/static_ui.rs
git commit -m "feat(agent): wire Device_CFG import preview and merge into settings"
```

---

### Task 4: Docs note

**Files:**
- Modify: `docs/api.md` (Agent settings / 2.8 section)

- [ ] **Step 1: Add short note**

Under Agent settings section (~2.8), add:

```markdown
配置页支持从旧测控 `Device_CFG.ini` **本地导入**地址类变量（白名单键 → `{Section}_{Key}`），合并进编辑区后经 `PUT /api/settings` 持久化。Agent 运行时不读取磁盘 INI。
```

- [ ] **Step 2: Commit**

```bash
git add docs/api.md
git commit -m "docs: note Device_CFG.ini import into agent settings variables"
```

---

## Spec coverage check

| Spec requirement | Task |
|------------------|------|
| Station layer via variables | Tasks 1–3 |
| Whitelist keys only | Task 1 `DEVICE_CFG_ADDRESS_KEYS` |
| `{Section}_{Key}` + sanitize | Task 1 |
| Skip empty / comments | Task 1 parse |
| Preview add/update counts | Task 3 modal |
| Merge then Save | Task 3 |
| No runtime INI path | Global + Task 4 |
| Calibration / LastInfo deferred | Not in plan (non-goal) |
| static_ui | Tasks 1–3 |
| docs note | Task 4 |

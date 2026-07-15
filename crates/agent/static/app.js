const POLL_MS = 2000;

async function fetchStatus() {
  const resp = await fetch('/api/status');
  if (!resp.ok) return;
  const data = await resp.json();
  document.getElementById('hostname').textContent = data.hostname;
  document.getElementById('ip').textContent = data.ip;
  document.getElementById('cpu').textContent = data.cpu_percent.toFixed(1) + '%';
  document.getElementById('memory').textContent = data.memory_percent.toFixed(1) + '%';
  document.getElementById('busy').textContent = data.busy ? '是' : '否';
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

fetchStatus();
fetchTasks();
setInterval(fetchStatus, POLL_MS);
setInterval(fetchTasks, POLL_MS);

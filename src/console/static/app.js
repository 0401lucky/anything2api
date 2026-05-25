const $ = (sel) => document.querySelector(sel);

const state = {
  accounts: [],
  usage: { totalRequests: 0, byModel: {}, byAccount: {} },
  login: { status: "idle" },
};

async function api(method, path, body) {
  const init = { method, headers: { "content-type": "application/json" }, credentials: "include" };
  if (body !== undefined) init.body = JSON.stringify(body);
  const response = await fetch(`/admin${path}`, init);
  const text = await response.text();
  const data = parseJson(text);
  if (!response.ok) {
    const error = new Error(data?.error?.message || data?.message || `${response.status}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data ?? text;
}

async function refreshAll() {
  setService("同步中", "tone-muted");
  const [accounts, usage, login] = await Promise.all([
    api("GET", "/api/accounts"),
    api("GET", "/api/usage"),
    api("GET", "/api/login/status"),
  ]);
  state.accounts = Array.isArray(accounts) ? accounts : [];
  state.usage = usage || state.usage;
  state.login = login || { status: "idle" };
  render();
  setService("运行中", "tone-ok");
}

function render() {
  renderMetrics();
  renderAccounts();
  renderUsage();
  renderLogin();
}

function renderMetrics() {
  const total = state.accounts.length;
  const active = state.accounts.filter((item) => item.status === "active").length;
  const cooldown = state.accounts.filter((item) => item.status === "cooldown").length;
  $("#metric-total").textContent = total;
  $("#metric-active").textContent = active;
  $("#metric-cooldown").textContent = cooldown;
  $("#metric-requests").textContent = state.usage.totalRequests ?? 0;
}

function renderAccounts() {
  const tbody = $("#accounts-table tbody");
  const filter = $("#status-filter").value;
  const keyword = $("#account-search").value.trim().toLowerCase();
  const rows = state.accounts.filter((account) => {
    const matchStatus = filter === "all" || account.status === filter;
    const haystack = `${account.email ?? ""} ${account.accountId ?? ""}`.toLowerCase();
    return matchStatus && (!keyword || haystack.includes(keyword));
  });

  if (rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" class="empty">暂无账号</td></tr>`;
    return;
  }

  tbody.innerHTML = rows.map((account) => `
    <tr>
      <td>
        <div class="cell-main">${escapeHtml(account.email || "未知邮箱")}</div>
        <div class="cell-sub">${escapeHtml(account.accountId || "—")}</div>
      </td>
      <td>${statusBadge(account.status)}</td>
      <td>${account.strikeCount ?? 0}</td>
      <td>${account.consecutiveUses ?? 0}</td>
      <td>${escapeHtml(account.cooldownUntil || "—")}</td>
      <td>${escapeHtml(account.lastUsedAt || "—")}</td>
      <td class="error-cell" title="${escapeHtml(account.lastError || "")}">${escapeHtml(account.lastError || "—")}</td>
      <td>
        <div class="action-group">
          <button class="link-button" data-act="reactivate" data-id="${escapeHtml(account.accountId)}">激活</button>
          <button class="link-button" data-act="export" data-id="${escapeHtml(account.accountId)}">导出</button>
          <button class="link-button danger-text" data-act="remove" data-id="${escapeHtml(account.accountId)}">删除</button>
        </div>
      </td>
    </tr>
  `).join("");
}

function renderUsage() {
  $("#usage-models").innerHTML = renderUsageRows(state.usage.byModel, "暂无模型统计");
  $("#usage-accounts").innerHTML = renderUsageRows(state.usage.byAccount, "暂无账号统计");
}

function renderUsageRows(source, emptyText) {
  const rows = Object.entries(source || {}).sort((a, b) => (b[1].requests ?? 0) - (a[1].requests ?? 0));
  if (rows.length === 0) return `<div class="empty small">${emptyText}</div>`;
  return rows.slice(0, 8).map(([name, item]) => `
    <div class="mini-row">
      <span title="${escapeHtml(name)}">${escapeHtml(name)}</span>
      <strong>${item.requests ?? 0}</strong>
      <small>${(item.promptChars ?? 0) + (item.completionChars ?? 0)} 字符</small>
    </div>
  `).join("");
}

function renderLogin() {
  const status = state.login.status || "idle";
  $("#login-status-pill").textContent = status;
  $("#login-status-pill").className = `pill ${statusTone(status)}`;
  $("#login-started").textContent = state.login.startedAt ? formatTime(state.login.startedAt) : "—";
  $("#login-session").textContent = state.login.vncSessionId ? state.login.vncSessionId.slice(0, 12) : "—";
  $("#login-error").textContent = state.login.error || "—";
  const canOpen = !!state.login.vncSessionId && ["provisioning", "waiting", "detecting"].includes(status);
  $("#open-vnc-btn").disabled = !canOpen;
  $("#cancel-login-btn").disabled = !canOpen;
}

document.body.addEventListener("click", async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLButtonElement)) return;
  const act = target.dataset.act;
  const id = target.dataset.id;
  if (!act || !id) return;

  try {
    target.disabled = true;
    if (act === "remove") {
      const account = state.accounts.find((item) => item.accountId === id);
      if (!confirm(`确认删除 ${account?.email ?? id}？`)) return;
      await api("DELETE", `/api/accounts/${encodeURIComponent(id)}`);
      toast("账号已删除");
    }
    if (act === "reactivate") {
      await api("POST", `/api/accounts/${encodeURIComponent(id)}/reactivate`);
      toast("账号已激活");
    }
    if (act === "export") {
      const link = document.createElement("a");
      link.href = `/admin/api/accounts/${encodeURIComponent(id)}/export`;
      link.download = `${id}.tar.gz`;
      link.click();
      return;
    }
    await refreshAll();
  } catch (error) {
    toast(`操作失败：${error.message}`, true);
  } finally {
    target.disabled = false;
  }
});

$("#logout-btn").addEventListener("click", async () => {
  await api("POST", "/api/logout");
  location.href = "/admin/login";
});

$("#refresh-btn").addEventListener("click", () => refreshAll().catch(handleRefreshError));
$("#status-filter").addEventListener("change", renderAccounts);
$("#account-search").addEventListener("input", renderAccounts);

$("#add-account-btn").addEventListener("click", async () => {
  const button = $("#add-account-btn");
  button.disabled = true;
  try {
    const data = await api("POST", "/api/login/start");
    state.login = { status: "provisioning", vncSessionId: data.sessionId, wsPort: data.wsPort, startedAt: Date.now() };
    renderLogin();
    openVnc(data.sessionId);
  } catch (error) {
    if (error.status === 409) {
      const status = await api("GET", "/api/login/status");
      state.login = status;
      renderLogin();
      if (status.vncSessionId) {
        openVnc(status.vncSessionId);
        toast("已打开正在进行的登录会话");
        return;
      }
    }
    toast(`启动登录失败：${error.message}`, true);
  } finally {
    button.disabled = false;
  }
});

$("#open-vnc-btn").addEventListener("click", () => {
  if (state.login.vncSessionId) openVnc(state.login.vncSessionId);
});

$("#cancel-login-btn").addEventListener("click", async () => {
  await api("POST", "/api/login/cancel");
  toast("登录已取消");
  await refreshAll();
});

$("#import-btn").addEventListener("click", () => $("#import-file").click());

$("#import-file").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    const response = await fetch("/admin/api/accounts/import", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/gzip" },
      body: file,
    });
    const data = parseJson(await response.text());
    if (!response.ok) throw new Error(data?.error?.message || `${response.status}`);
    toast(`已导入 ${data.email || "账号"}`);
    await refreshAll();
  } catch (error) {
    toast(`导入失败：${error.message}`, true);
  } finally {
    event.target.value = "";
  }
});

function openVnc(sessionId) {
  window.open(`/admin/vnc.html?session=${encodeURIComponent(sessionId)}`, "_blank", "width=1320,height=900");
}

function setService(text, tone) {
  const pill = $("#service-pill");
  pill.textContent = text;
  pill.className = `pill ${tone}`;
}

function handleRefreshError(error) {
  setService("异常", "tone-danger");
  toast(`刷新失败：${error.message}`, true);
}

function statusBadge(status) {
  return `<span class="pill ${statusTone(status)}">${escapeHtml(status || "unknown")}</span>`;
}

function statusTone(status) {
  if (status === "active" || status === "done") return "tone-ok";
  if (status === "cooldown" || status === "waiting" || status === "provisioning" || status === "detecting") return "tone-warn";
  if (status === "deleted" || status === "failed" || status === "cancelled") return "tone-danger";
  return "tone-muted";
}

function toast(message, danger = false) {
  const node = $("#toast");
  node.textContent = message;
  node.className = `toast ${danger ? "danger" : ""}`;
  node.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    node.hidden = true;
  }, 3200);
}

function parseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function formatTime(value) {
  if (typeof value === "number") return new Date(value).toLocaleString();
  return String(value);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[ch]));
}

refreshAll().catch(handleRefreshError);
setInterval(() => refreshAll().catch(handleRefreshError), 15_000);

const $ = (sel) => document.querySelector(sel);

async function api(method, path, body) {
  const init = { method, headers: { "content-type": "application/json" }, credentials: "include" };
  if (body !== undefined) init.body = JSON.stringify(body);
  const response = await fetch(`/admin${path}`, init);
  if (!response.ok) throw new Error(`${response.status}`);
  if (response.headers.get("content-type")?.includes("json")) return response.json();
  return response.text();
}

async function refreshAccounts() {
  const accounts = await api("GET", "/api/accounts");
  const tbody = $("#accounts-table tbody");
  tbody.innerHTML = accounts.map((a) => `
    <tr>
      <td>${escapeHtml(a.email)}</td>
      <td>${a.status}</td>
      <td>${a.strikeCount}</td>
      <td>${a.cooldownUntil ?? "—"}</td>
      <td>
        <button data-act="reactivate" data-id="${a.accountId}">激活</button>
        <button data-act="export" data-id="${a.accountId}">导出</button>
        <button data-act="remove" data-id="${a.accountId}">删除</button>
      </td>
    </tr>
  `).join("");
}

async function refreshUsage() {
  const usage = await api("GET", "/api/usage");
  $("#usage-output").textContent = JSON.stringify(usage, null, 2);
}

document.body.addEventListener("click", async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLButtonElement)) return;
  const act = target.dataset.act;
  const id = target.dataset.id;
  if (!act || !id) return;
  if (act === "remove" && !confirm("确认删除？")) return;
  if (act === "remove") await api("DELETE", `/api/accounts/${id}`);
  if (act === "reactivate") await api("POST", `/api/accounts/${id}/reactivate`);
  if (act === "export") {
    const link = document.createElement("a");
    link.href = `/admin/api/accounts/${id}/export`;
    link.download = `${id}.tar.gz`;
    link.click();
    return;
  }
  await refreshAccounts();
});

$("#logout-btn").addEventListener("click", async () => {
  await api("POST", "/api/logout");
  location.href = "/admin/login";
});

$("#add-account-btn").addEventListener("click", () => {
  alert("添加账号功能将在 VNC Task 完成后启用");
});

$("#import-btn").addEventListener("click", () => $("#import-file").click());

$("#import-file").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  const response = await fetch("/admin/api/accounts/import", {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/gzip" },
    body: file,
  });
  if (!response.ok) {
    alert(`导入失败: ${response.status}`);
    return;
  }
  await refreshAccounts();
});

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

refreshAccounts().then(refreshUsage).catch(() => {});
setInterval(() => { refreshAccounts().catch(() => {}); refreshUsage().catch(() => {}); }, 15_000);

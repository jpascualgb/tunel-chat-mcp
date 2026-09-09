const fragmentCandidate = location.hash.startsWith("#") ? location.hash.slice(1) : "";
const fragmentToken = /^[a-f0-9]{48}$/.test(fragmentCandidate) ? fragmentCandidate : "";
if (fragmentToken) sessionStorage.setItem("mcp-panel-token", fragmentToken);
const token = fragmentToken || sessionStorage.getItem("mcp-panel-token") || "";
if (fragmentToken) history.replaceState(null, "", `${location.pathname}${location.search}`);
const permissionOrder = ["read", "create", "modify", "delete"];
let language = localStorage.getItem("mcp-panel-language") || "es";
let currentState = null;
let pendingModalAction = null;

const translations = {
  es: {
    localControl: "Centro de seguridad local", authorizedWorkspace: "Perfil y espacio autorizados", lastMcp: "Última actividad MCP", latency: "Respuesta local", uptime: "Tiempo activo",
    connected: "Conectado", connecting: "Iniciando conexión…", stopped: "Apagado", readyDetail: "ChatGPT puede usar las herramientas autorizadas", startingDetail: "El proceso está completando la conexión", stoppedDetail: "El panel sigue activo; el túnel está detenido",
    filePermissions: "Permisos de archivos", permissionsHelp: "Actívalos de forma temporal o sin límite de tiempo.", activationDuration: "Duración al activar", unlimited: "Sin límite",
    tunnelControl: "Control del túnel", controlHelp: "Inicia, detén o reinicia esta conexión.", start: "Iniciar", stop: "Apagar", restart: "Reiniciar", windowsStart: "Iniciar con el sistema", windowsStartHelp: "Arranca el túnel al iniciar sesión.",
    securityMode: "Seguridad y autonomía", securityHelp: "Decide cuánto control conservar antes de cada cambio.", approvalTitle: "Aprobar cada modificación", approvalHelp: "Muestra el archivo y una vista previa antes de crear, modificar o eliminar.", autonomousTitle: "Modo autónomo activo", autonomousHelp: "La IA podrá realizar todos los cambios permitidos sin pedir aprobación individual.", sensitiveTitle: "Proteger archivos sensibles", sensitiveHelp: "Bloquea .env, claves, credenciales, .git y enlaces que salgan del espacio autorizado.",
    pendingApprovals: "Aprobaciones pendientes", approvalsHelp: "Revisa el antes y después; cada aprobación solo sirve una vez.", noApprovals: "No hay operaciones esperando aprobación.", before: "Antes", after: "Después", approve: "Permitir", reject: "Rechazar", createAction: "Crear", overwriteAction: "Modificar", deleteAction: "Eliminar",
    backups: "Copias y recuperación", backupsHelp: "Conserva versiones previas y recupera el último cambio.", createBackups: "Crear copias automáticas", retention: "Eliminar cada copia después de", keepForever: "No eliminar automáticamente", undoModification: "Deshacer última modificación", restoreDeleted: "Restaurar último eliminado", copies: "copias disponibles",
    profiles: "Perfiles de carpetas", profilesHelp: "Cada perfil aísla permisos, aprobaciones y copias; al cambiar, el túnel se reinicia.", activeProfile: "Perfil activo", deleteProfile: "Eliminar perfil seleccionado", profileNameLabel: "Nombre", folderPath: "Ruta completa de la carpeta", addProfile: "Añadir perfil",
    auditLog: "Registro de auditoría", auditHelp: "Acciones, rutas, resultado y origen de cada operación.", refresh: "Actualizar", date: "Fecha", source: "Origen", action: "Acción", file: "Archivo / detalle", result: "Resultado", noActivity: "Todavía no hay actividad registrada.",
    localOnly: "Solo accesible desde este equipo · loopback", technicalPanel: "Panel técnico", cancel: "Cancelar", confirm: "Confirmar", saved: "Configuración guardada.", completed: "Acción completada.", genericError: "No se pudo completar la operación.", secureLinkRequired: "Acceso local protegido", secureLinkHelp: "Abre el enlace efímero que muestra el iniciador local.",
    disableApprovalTitle: "¿Activar el modo autónomo?", disableApprovalBody: "La IA podrá crear, modificar y eliminar sin aprobación individual mientras los permisos correspondientes estén activos.", enableAutonomous: "Activar modo autónomo",
    stopTitle: "¿Apagar el túnel?", stopBody: "ChatGPT perderá temporalmente el acceso a la carpeta.", stopConfirm: "Apagar túnel", restartTitle: "¿Reiniciar el túnel?", restartBody: "La conexión se interrumpirá durante unos segundos.", restartConfirm: "Reiniciar",
    restoreBackupTitle: "¿Deshacer la última modificación?", restoreBackupBody: "Se restaurará la versión guardada más reciente.", restoreTrashTitle: "¿Restaurar el último archivo eliminado?", restoreTrashBody: "El archivo volverá a su ruta original.", profileSwitchTitle: "¿Cambiar de perfil?", profileSwitchBody: "El túnel se reiniciará para autorizar únicamente la nueva carpeta.", deleteProfileTitle: "¿Eliminar este perfil?", deleteProfileBody: "La carpeta y sus archivos no se borrarán.",
    permissionLabels: { read: ["Lectura", "Listar carpetas y leer archivos."], create: ["Crear archivos", "Crear archivos nuevos."], modify: ["Modificar archivos", "Sobrescribir archivos existentes."], delete: ["Eliminar archivos", "Mover archivos a la papelera recuperable."] },
  },
  en: {
    localControl: "Local security center", authorizedWorkspace: "Authorized profile and workspace", lastMcp: "Last MCP activity", latency: "Local response", uptime: "Uptime",
    connected: "Connected", connecting: "Starting connection…", stopped: "Stopped", readyDetail: "ChatGPT can use the authorized tools", startingDetail: "The process is completing the connection", stoppedDetail: "The panel is available; the tunnel is stopped",
    filePermissions: "File permissions", permissionsHelp: "Enable them temporarily or without a time limit.", activationDuration: "Duration when enabled", unlimited: "Unlimited",
    tunnelControl: "Tunnel control", controlHelp: "Start, stop or restart this connection.", start: "Start", stop: "Stop", restart: "Restart", windowsStart: "Start with the system", windowsStartHelp: "Starts the tunnel when you sign in.",
    securityMode: "Security and autonomy", securityHelp: "Choose how much control to keep before each change.", approvalTitle: "Approve every change", approvalHelp: "Shows the file and a preview before creating, changing or deleting.", autonomousTitle: "Autonomous mode active", autonomousHelp: "AI can perform all allowed changes without individual approval.", sensitiveTitle: "Protect sensitive files", sensitiveHelp: "Blocks .env, keys, credentials, .git and links outside the workspace.",
    pendingApprovals: "Pending approvals", approvalsHelp: "Review before and after; each approval can be used once.", noApprovals: "No operations are waiting for approval.", before: "Before", after: "After", approve: "Allow", reject: "Reject", createAction: "Create", overwriteAction: "Modify", deleteAction: "Delete",
    backups: "Backups and recovery", backupsHelp: "Keep previous versions and recover the latest change.", createBackups: "Create automatic backups", retention: "Delete each copy after", keepForever: "Never delete automatically", undoModification: "Undo latest modification", restoreDeleted: "Restore latest deleted file", copies: "copies available",
    profiles: "Folder profiles", profilesHelp: "Each profile isolates permissions, approvals and backups; switching restarts the tunnel.", activeProfile: "Active profile", deleteProfile: "Delete selected profile", profileNameLabel: "Name", folderPath: "Full folder path", addProfile: "Add profile",
    auditLog: "Audit log", auditHelp: "Actions, paths, result and source for every operation.", refresh: "Refresh", date: "Date", source: "Source", action: "Action", file: "File / detail", result: "Result", noActivity: "No activity has been recorded yet.",
    localOnly: "Only accessible from this device · loopback", technicalPanel: "Technical panel", cancel: "Cancel", confirm: "Confirm", saved: "Configuration saved.", completed: "Action completed.", genericError: "The operation could not be completed.", secureLinkRequired: "Protected local access", secureLinkHelp: "Open the ephemeral link shown by the local launcher.",
    disableApprovalTitle: "Enable autonomous mode?", disableApprovalBody: "AI will be able to create, modify and delete without individual approval while the related permissions are enabled.", enableAutonomous: "Enable autonomous mode",
    stopTitle: "Stop the tunnel?", stopBody: "ChatGPT will temporarily lose access to the folder.", stopConfirm: "Stop tunnel", restartTitle: "Restart the tunnel?", restartBody: "The connection will be interrupted for a few seconds.", restartConfirm: "Restart",
    restoreBackupTitle: "Undo the latest modification?", restoreBackupBody: "The most recent saved version will be restored.", restoreTrashTitle: "Restore the latest deleted file?", restoreTrashBody: "The file will return to its original path.", profileSwitchTitle: "Switch profile?", profileSwitchBody: "The tunnel will restart and authorize only the new folder.", deleteProfileTitle: "Delete this profile?", deleteProfileBody: "The folder and its files will not be deleted.",
    permissionLabels: { read: ["Read", "List folders and read files."], create: ["Create files", "Create new files."], modify: ["Modify files", "Overwrite existing files."], delete: ["Delete files", "Move files to the recoverable trash."] },
  },
};

function t(key) { return translations[language][key]; }
function escapeHtml(value) { return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]); }

async function api(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { "Content-Type": "application/json", "X-Control-Token": token, ...(options.headers || {}) } });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error?.message || t("genericError"));
  return payload;
}

function showToast(message, isError = false) {
  const toast = document.getElementById("toast");
  toast.textContent = message; toast.classList.toggle("error", isError); toast.hidden = false;
  clearTimeout(showToast.timer); showToast.timer = setTimeout(() => { toast.hidden = true; }, 4200);
}

function openModal({ title, body, confirmLabel, summary = "", action }) {
  pendingModalAction = action;
  document.getElementById("modalTitle").textContent = title;
  document.getElementById("modalBody").textContent = body;
  document.getElementById("modalConfirm").textContent = confirmLabel || t("confirm");
  const summaryElement = document.getElementById("modalSummary"); summaryElement.textContent = summary; summaryElement.hidden = !summary;
  document.getElementById("modalBackdrop").hidden = false; document.getElementById("modalConfirm").focus();
}
function closeModal() { document.getElementById("modalBackdrop").hidden = true; pendingModalAction = null; }

function formatTime(timestamp) {
  if (!timestamp) return "—";
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return "—";
  return new Intl.DateTimeFormat(language === "es" ? "es-ES" : "en-GB", { dateStyle: "short", timeStyle: "medium" }).format(date);
}
function formatDuration(seconds) {
  if (!seconds) return "—";
  const hours = Math.floor(seconds / 3600); const minutes = Math.floor((seconds % 3600) / 60); const rest = seconds % 60;
  return hours ? `${hours}h ${minutes}m` : minutes ? `${minutes}m ${rest}s` : `${rest}s`;
}

function renderPermissions() {
  const list = document.getElementById("permissionList");
  list.innerHTML = permissionOrder.map((permission) => {
    const [label, description] = t("permissionLabels")[permission];
    const expiry = currentState.permissionExpiresAt?.[permission];
    const expiryText = expiry ? `<small>${formatTime(expiry)}</small>` : "";
    return `<div class="permission-row"><div class="permission-mark">${permission === "read" ? "◫" : permission === "create" ? "+" : permission === "modify" ? "✎" : "⌫"}</div><div class="permission-copy"><strong>${label}</strong><span>${description}</span>${expiryText}</div><label class="switch"><input type="checkbox" data-permission="${permission}" ${currentState.permissions[permission] ? "checked" : ""} aria-label="${label}"><span class="switch-track"></span></label></div>`;
  }).join("");
  list.querySelectorAll("input[data-permission]").forEach((input) => input.addEventListener("change", () => changePermission(input)));
}

function actionLabel(action) {
  const known = { create: t("createAction"), sobrescribir: t("overwriteAction"), delete: t("deleteAction") };
  return known[action] || action?.replaceAll("_", " ") || "—";
}

function previewBlock(label, preview) {
  if (!preview) return `<div class="preview empty"><strong>${label}</strong><span>—</span></div>`;
  return `<div class="preview"><strong>${label}</strong><pre>${escapeHtml(preview.content)}</pre>${preview.truncated ? "<small>…</small>" : ""}</div>`;
}

function renderApprovals() {
  const approvals = currentState.pendingApprovals || [];
  document.getElementById("approvalCount").textContent = approvals.length;
  const list = document.getElementById("approvalList");
  if (!approvals.length) { list.innerHTML = `<div class="empty-state">${t("noApprovals")}</div>`; return; }
  list.innerHTML = approvals.map((request) => `<article class="approval-card"><div class="approval-head"><div><span class="action-pill">${escapeHtml(actionLabel(request.action))}</span><strong>${escapeHtml(request.path)}</strong><small>${formatTime(request.createdAt)}</small></div><div class="approval-actions"><button class="button secondary" data-decision="rejected" data-id="${escapeHtml(request.id)}">${t("reject")}</button><button class="button primary" data-decision="approved" data-id="${escapeHtml(request.id)}">${t("approve")}</button></div></div><div class="preview-grid">${previewBlock(t("before"), request.preview?.before)}${previewBlock(t("after"), request.preview?.after)}</div></article>`).join("");
  list.querySelectorAll("button[data-decision]").forEach((button) => button.addEventListener("click", () => decideApproval(button.dataset.id, button.dataset.decision)));
}

function renderProfiles() {
  const select = document.getElementById("profileSelect");
  select.innerHTML = currentState.profiles.profiles.map((profile) => `<option value="${profile.id}" ${profile.id === currentState.profiles.activeProfileId ? "selected" : ""}>${escapeHtml(profile.name)} — ${escapeHtml(profile.workspace)}</option>`).join("");
  document.getElementById("deleteProfile").disabled = currentState.profiles.profiles.length <= 1 || select.value === currentState.profiles.activeProfileId;
}

function renderActivity() {
  const body = document.getElementById("activityList");
  if (!currentState.activity?.length) { body.innerHTML = `<tr><td colspan="5" class="empty-state">${t("noActivity")}</td></tr>`; return; }
  body.innerHTML = currentState.activity.slice(0, 30).map((event) => {
    const detail = event.path || (event.permission ? `${event.permission}: ${event.value ? "ON" : "OFF"}` : event.profileId || event.requestId || "—");
    return `<tr><td>${formatTime(event.timestamp)}</td><td><span class="source-pill">${escapeHtml(event.source)}</span></td><td>${escapeHtml(actionLabel(event.action))}</td><td title="${escapeHtml(detail)}">${escapeHtml(detail)}</td><td><span class="result-pill ${event.result === "error" ? "error" : ""}">${escapeHtml(event.result || "success")}</span></td></tr>`;
  }).join("");
}

function renderState() {
  if (!currentState) return;
  document.querySelector(".status-band").classList.toggle("offline", !currentState.running);
  document.getElementById("statusTitle").textContent = currentState.ready ? t("connected") : currentState.running ? t("connecting") : t("stopped");
  document.getElementById("statusDetail").textContent = currentState.ready ? t("readyDetail") : currentState.running ? t("startingDetail") : t("stoppedDetail");
  const active = currentState.profiles.profiles.find((profile) => profile.id === currentState.profiles.activeProfileId);
  document.getElementById("profileName").textContent = active?.name || "—"; document.getElementById("workspacePath").textContent = currentState.workspace || "—";
  document.getElementById("lastMcp").textContent = formatTime(currentState.connection.lastMcpActivity);
  document.getElementById("latency").textContent = currentState.connection.healthLatencyMs == null ? "—" : `${currentState.connection.healthLatencyMs} ms`;
  document.getElementById("uptime").textContent = formatDuration(currentState.connection.uptimeSeconds);
  document.getElementById("startButton").disabled = currentState.running; document.getElementById("stopButton").disabled = !currentState.running; document.getElementById("restartButton").disabled = !currentState.running;
  document.getElementById("autostartToggle").checked = currentState.autostart;
  document.getElementById("approvalToggle").checked = currentState.settings.approvalRequired;
  document.getElementById("sensitiveToggle").checked = currentState.settings.sensitiveProtection;
  document.getElementById("autonomousWarning").hidden = currentState.settings.approvalRequired;
  document.getElementById("backupToggle").checked = currentState.settings.backupEnabled;
  document.getElementById("backupRetention").value = currentState.settings.backupRetentionDays == null ? "unlimited" : String(currentState.settings.backupRetentionDays);
  document.getElementById("backupRetention").disabled = !currentState.settings.backupEnabled;
  document.getElementById("backupSummary").textContent = `${currentState.backups.count} ${t("copies")}`;
  document.getElementById("restoreBackup").disabled = !currentState.backups.latest;
  document.getElementById("restoreTrash").disabled = !currentState.trash.latest;
  renderPermissions(); renderApprovals(); renderProfiles(); renderActivity();
}

async function refreshState({ quiet = false } = {}) {
  try { currentState = await api("/api/v1/state"); renderState(); } catch (error) { if (!quiet) showToast(error.message, true); }
}

async function changePermission(input) {
  const durationValue = document.getElementById("permissionDuration").value;
  const durationMinutes = input.checked && durationValue !== "unlimited" ? Number(durationValue) : null;
  input.disabled = true;
  try { await api("/api/v1/permissions", { method: "PATCH", body: JSON.stringify({ permission: input.dataset.permission, value: input.checked, durationMinutes }) }); showToast(t("saved")); }
  catch (error) { showToast(error.message, true); }
  finally { await refreshState({ quiet: true }); }
}

async function patchSettings(changes) {
  try { await api("/api/v1/settings", { method: "PATCH", body: JSON.stringify(changes) }); showToast(t("saved")); await refreshState({ quiet: true }); }
  catch (error) { showToast(error.message, true); await refreshState({ quiet: true }); }
}

async function decideApproval(id, status) {
  try { await api(`/api/v1/approvals/${encodeURIComponent(id)}`, { method: "POST", body: JSON.stringify({ status }) }); showToast(t("completed")); await refreshState({ quiet: true }); }
  catch (error) { showToast(error.message, true); }
}

async function performTunnelAction(action) {
  try { await api(`/api/v1/tunnel/${action}`, { method: "POST", body: "{}" }); showToast(t("completed")); await refreshState({ quiet: true }); }
  catch (error) { showToast(error.message, true); }
}

function setLanguage(nextLanguage) {
  language = nextLanguage; localStorage.setItem("mcp-panel-language", language); document.documentElement.lang = language;
  document.querySelectorAll("[data-language]").forEach((button) => button.classList.toggle("active", button.dataset.language === language));
  document.querySelectorAll("[data-i18n]").forEach((element) => { const value = t(element.dataset.i18n); if (typeof value === "string") element.textContent = value; });
  renderState();
}

document.querySelectorAll("[data-language]").forEach((button) => button.addEventListener("click", () => setLanguage(button.dataset.language)));
document.getElementById("refreshButton").addEventListener("click", () => refreshState());
document.getElementById("startButton").addEventListener("click", () => performTunnelAction("start"));
document.getElementById("stopButton").addEventListener("click", () => openModal({ title: t("stopTitle"), body: t("stopBody"), confirmLabel: t("stopConfirm"), action: () => performTunnelAction("stop") }));
document.getElementById("restartButton").addEventListener("click", () => openModal({ title: t("restartTitle"), body: t("restartBody"), confirmLabel: t("restartConfirm"), action: () => performTunnelAction("restart") }));
document.getElementById("approvalToggle").addEventListener("change", (event) => {
  if (!event.target.checked) openModal({ title: t("disableApprovalTitle"), body: t("disableApprovalBody"), confirmLabel: t("enableAutonomous"), action: () => patchSettings({ approvalRequired: false }) });
  else patchSettings({ approvalRequired: true });
  renderState();
});
document.getElementById("sensitiveToggle").addEventListener("change", (event) => patchSettings({ sensitiveProtection: event.target.checked }));
document.getElementById("backupToggle").addEventListener("change", (event) => patchSettings({ backupEnabled: event.target.checked }));
document.getElementById("backupRetention").addEventListener("change", (event) => patchSettings({ backupRetentionDays: event.target.value === "unlimited" ? null : Number(event.target.value) }));
document.getElementById("autostartToggle").addEventListener("change", async (event) => { try { await api("/api/v1/autostart", { method: "PATCH", body: JSON.stringify({ value: event.target.checked }) }); showToast(t("saved")); } catch (error) { showToast(error.message, true); } finally { await refreshState({ quiet: true }); } });
document.getElementById("restoreBackup").addEventListener("click", () => openModal({ title: t("restoreBackupTitle"), body: t("restoreBackupBody"), action: async () => { const precondition = await api("/api/v1/backups/latest/restore-precondition"); await api("/api/v1/backups/latest/restore", { method: "POST", body: JSON.stringify({ expectedCurrentSha256: precondition.currentSha256 }) }); showToast(t("completed")); await refreshState({ quiet: true }); } }));
document.getElementById("restoreTrash").addEventListener("click", () => openModal({ title: t("restoreTrashTitle"), body: t("restoreTrashBody"), action: async () => { await api("/api/v1/trash/latest/restore", { method: "POST", body: "{}" }); showToast(t("completed")); await refreshState({ quiet: true }); } }));
document.getElementById("profileSelect").addEventListener("change", (event) => { const id = event.target.value; openModal({ title: t("profileSwitchTitle"), body: t("profileSwitchBody"), action: async () => { await api("/api/v1/profiles/active", { method: "PATCH", body: JSON.stringify({ id }) }); showToast(t("completed")); await refreshState({ quiet: true }); } }); renderState(); });
document.getElementById("deleteProfile").addEventListener("click", () => { const id = document.getElementById("profileSelect").value; openModal({ title: t("deleteProfileTitle"), body: t("deleteProfileBody"), action: async () => { await api(`/api/v1/profiles/${encodeURIComponent(id)}`, { method: "DELETE" }); showToast(t("completed")); await refreshState({ quiet: true }); } }); });
document.getElementById("profileForm").addEventListener("submit", async (event) => { event.preventDefault(); try { await api("/api/v1/profiles", { method: "POST", body: JSON.stringify({ name: document.getElementById("newProfileName").value, workspace: document.getElementById("newProfilePath").value }) }); event.target.reset(); showToast(t("completed")); await refreshState({ quiet: true }); } catch (error) { showToast(error.message, true); } });
document.getElementById("modalCancel").addEventListener("click", () => { closeModal(); renderState(); });
document.getElementById("modalClose").addEventListener("click", () => { closeModal(); renderState(); });
document.getElementById("modalBackdrop").addEventListener("click", (event) => { if (event.target === event.currentTarget) { closeModal(); renderState(); } });
document.addEventListener("keydown", (event) => { if (event.key === "Escape") { closeModal(); renderState(); } });
document.getElementById("modalConfirm").addEventListener("click", async () => { const action = pendingModalAction; closeModal(); if (action) { try { await action(); } catch (error) { showToast(error.message, true); } } });

setLanguage(language);
if (token) {
  await refreshState();
  setInterval(() => refreshState({ quiet: true }), 3000);
} else {
  document.getElementById("statusTitle").dataset.i18n = "secureLinkRequired";
  document.getElementById("statusDetail").dataset.i18n = "secureLinkHelp";
  setLanguage(language);
  document.querySelectorAll("button, input, select").forEach((element) => { if (!element.matches("[data-language]")) element.disabled = true; });
}

import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  buildSanitizedEnvironment,
  buildTunnelClientEnvironment,
  controlPlaneSecretNames,
} from "./process-environment.mjs";
import {
  appendActivity,
  createProfile,
  decideApproval,
  effectivePermissions,
  pathsOverlap,
  profileDataPaths,
  readApprovals,
  readProfiles,
  readSettings,
  recentActivity,
  updatePermission,
  validateBackupMetadata,
  validateSafeRelativePath,
  verifyAuditChain,
  workspaceFingerprint,
  writeProfiles,
  writeSettings,
} from "./secure-store.mjs";
import {
  atomicRestoreFromFile,
  atomicMoveToNewPath,
  resolveExistingWorkspaceFile,
  resolveNewWorkspaceFile,
  sha256File,
} from "./safe-files.mjs";
import {
  ApiError,
  apiBasePath,
  apiErrorPayload,
  apiSchemas,
  parseApiInput,
} from "./control-api-contract.mjs";
import {
  autostartEnabled as platformAutostartEnabled,
  defaultDataRoot as platformDefaultDataRoot,
  setAutostart as setPlatformAutostart,
} from "./platform-runtime.mjs";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const panelRoot = path.join(projectRoot, "panel");
const defaultDataRoot = process.env.MCP_TUNNEL_DATA_ROOT || platformDefaultDataRoot();
const defaultClientPath = process.env.MCP_TUNNEL_CLIENT_PATH || (process.platform === "win32" ? path.join(projectRoot, "vendor", "tunnel-client", "tunnel-client.exe") : "tunnel-client");

export function loopbackOrigin(host, port) {
  const hostname = host === "::1" ? "[::1]" : host;
  return `http://${hostname}:${port}`;
}

export async function spawnTunnelProcess(command, args, options) {
  const child = spawn(command, args, options);
  try {
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
  } catch (error) {
    throw new Error("No se pudo iniciar tunnel-client. Comprueba su instalacion o la ruta configurada.", { cause: error });
  }
  return child;
}

function jsonResponse(response, status, payload) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  response.end(JSON.stringify(payload));
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 128 * 1024) throw new ApiError(413, "PAYLOAD_TOO_LARGE", "La solicitud supera 128 KiB.");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new ApiError(400, "INVALID_JSON", "El cuerpo de la solicitud no contiene JSON valido.");
  }
}

async function listBackups(backupsRoot, binding) {
  try {
    const items = [];
    for (const entry of await fs.readdir(backupsRoot, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      try {
        const metadata = JSON.parse(await fs.readFile(path.join(backupsRoot, entry.name), "utf8"));
        validateBackupMetadata(metadata, binding);
        items.push(metadata);
      } catch {}
    }
    return items.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  } catch { return []; }
}

async function cleanupExpiredBackups(backupsRoot, retentionDays, binding) {
  if (!retentionDays) return 0;
  const cutoff = Date.now() - retentionDays * 86_400_000;
  let removed = 0;
  for (const metadata of await listBackups(backupsRoot, binding)) {
    if (Date.parse(metadata.createdAt) >= cutoff) continue;
    const validated = validateBackupMetadata(metadata, binding);
    await fs.rm(validated.backupPath, { force: true });
    await fs.rm(validated.metadataPath, { force: true });
    removed += 1;
  }
  return removed;
}

async function validateWorkspace(input, protectedDataRoot = defaultDataRoot) {
  if (typeof input !== "string" || !input.trim()) throw new Error("Indica una ruta de carpeta valida.");
  const workspace = await fs.realpath(input.trim().replace(/^"|"$/g, ""));
  if (!(await fs.stat(workspace)).isDirectory()) throw new Error("La ruta no es una carpeta.");
  if (path.parse(workspace).root.toLowerCase() === workspace.replace(/[\\/]$/, "").toLowerCase()) throw new Error("No se permite autorizar una unidad completa.");
  if (pathsOverlap(workspace, projectRoot)) throw new Error("No se puede autorizar la carpeta del tunel, una carpeta superior ni una carpeta interior.");
  if (pathsOverlap(workspace, protectedDataRoot)) throw new Error("No se puede autorizar la carpeta que contiene los datos privados del tunel ni una carpeta superior.");
  const windowsRoot = process.env.SystemRoot;
  if (windowsRoot && pathsOverlap(workspace, windowsRoot)) throw new Error("No se puede autorizar la carpeta del sistema de Windows.");
  return workspace;
}

export async function createControlPanel(options = {}) {
  const host = options.host || "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "::1") throw new Error("El panel solo puede escuchar en una direccion loopback (127.0.0.1 o ::1).");
  const port = options.port ?? Number(process.env.CONTROL_PANEL_PORT || 8080);
  const tunnelHealthUrl = options.tunnelHealthUrl || "http://127.0.0.1:8082";
  const dataRoot = options.dataRoot || defaultDataRoot;
  const activityPath = options.activityPath || path.join(dataRoot, "activity.jsonl");
  const profilesPath = options.profilesPath || path.join(dataRoot, "profiles.json");
  const clientPath = options.clientPath || defaultClientPath;
  const controlPlaneApiKey = options.controlPlaneApiKey || null;
  const testMode = options.testMode === true;
  const token = randomBytes(24).toString("hex");
  let tunnelProcess = null;
  let tunnelStartedAt = null;
  let testAutostart = false;

  async function log(action, details = {}) {
    await appendActivity(activityPath, { source: "panel", action, ...details });
  }

  async function profiles() {
    return readProfiles(profilesPath, process.env.MCP_WORKSPACE_ROOT || null);
  }

  async function activeProfile() {
    const saved = await profiles();
    return saved.profiles.find((profile) => profile.id === saved.activeProfileId) || null;
  }

  async function activeContext() {
    const profile = await activeProfile();
    if (!profile) throw new Error("No hay ningun perfil de carpeta configurado.");
    const workspace = await validateWorkspace(profile.workspace, dataRoot);
    const paths = profileDataPaths(dataRoot, profile);
    const fingerprint = workspaceFingerprint(workspace);
    return {
      profile,
      workspace,
      fingerprint,
      ...paths,
      binding: { profileId: profile.id, workspaceFingerprint: fingerprint, backupsRoot: paths.backupsRoot },
    };
  }

  async function readyStatus() {
    if (!tunnelProcess) return { ready: false, latencyMs: null };
    if (testMode) return { ready: true, latencyMs: 1 };
    const started = performance.now();
    try {
      const result = await fetch(`${tunnelHealthUrl}/readyz`, { signal: AbortSignal.timeout(1200) });
      return { ready: result.ok, latencyMs: Math.round(performance.now() - started) };
    } catch { return { ready: false, latencyMs: null }; }
  }

  async function startTunnel() {
    if (tunnelProcess) return { changed: false };
    const context = await activeContext();
    if (testMode) {
      tunnelProcess = { pid: 1, kill() {} };
      tunnelStartedAt = new Date().toISOString();
      await log("tunnel_start", { profileId: context.profile.id, workspaceFingerprint: context.fingerprint });
      return { changed: true };
    }
    if (path.isAbsolute(clientPath) || clientPath.includes(path.sep)) await fs.access(clientPath);
    tunnelProcess = await spawnTunnelProcess(clientPath, ["run", "--profile", "pc-personal", "--health.listen-addr", "127.0.0.1:8082"], {
      cwd: projectRoot,
      env: buildTunnelClientEnvironment(process.env, controlPlaneApiKey, {
        MCP_WORKSPACE_ROOT: context.workspace,
        MCP_PROFILE_ID: context.profile.id,
        MCP_SETTINGS_PATH: context.settingsPath,
        MCP_PERMISSIONS_PATH: context.settingsPath,
        MCP_ACTIVITY_PATH: activityPath,
        MCP_APPROVALS_PATH: context.approvalsPath,
        MCP_BACKUPS_ROOT: context.backupsRoot,
        MCP_CONTROL_ROOT: projectRoot,
        MCP_CONTROL_DATA_ROOT: dataRoot,
      }),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    tunnelStartedAt = new Date().toISOString();
    const processReference = tunnelProcess;
    processReference.stdout.on("data", (chunk) => process.stdout.write(chunk));
    processReference.stderr.on("data", (chunk) => process.stderr.write(chunk));
    processReference.once("exit", async (code) => {
      if (tunnelProcess === processReference) tunnelProcess = null;
      await log("tunnel_exit", { code }).catch(() => {});
    });
    await log("tunnel_start", { pid: processReference.pid, profileId: context.profile.id, workspaceFingerprint: context.fingerprint });
    return { changed: true };
  }

  async function stopTunnel() {
    if (!tunnelProcess) return { changed: false };
    const processReference = tunnelProcess;
    if (testMode) {
      tunnelProcess = null;
      await log("tunnel_stop");
      return { changed: true };
    }
    const exited = new Promise((resolve) => processReference.once("exit", resolve));
    processReference.kill();
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
    if (tunnelProcess === processReference) { processReference.kill("SIGKILL"); tunnelProcess = null; }
    await log("tunnel_stop");
    return { changed: true };
  }

  async function restartTunnel() {
    await stopTunnel();
    await startTunnel();
    await log("tunnel_restart");
    return { changed: true };
  }

  async function autostartEnabled() {
    if (testMode) return testAutostart;
    return platformAutostartEnabled({ dataRoot, projectRoot });
  }

  async function setAutostart(value) {
    if (testMode) { testAutostart = value; return; }
    await setPlatformAutostart(value, { dataRoot, projectRoot, clientPath, env: buildSanitizedEnvironment(process.env) });
    await log("autostart_change", { value });
  }

  async function restoreLatestBackup(expectedCurrentSha256 = null) {
    const context = await activeContext();
    const items = await listBackups(context.backupsRoot, context.binding);
    const latest = items[0];
    if (!latest) throw new Error("No hay copias de seguridad disponibles.");
    const validated = validateBackupMetadata(latest, context.binding);
    if (await sha256File(validated.backupPath) !== latest.sha256) throw new Error("La copia de seguridad no supera la verificacion de integridad.");
    validateSafeRelativePath(latest.originalPath);
    let destination;
    let destinationHash = null;
    try {
      const existing = await resolveExistingWorkspaceFile(context.workspace, latest.originalPath);
      destination = existing.realPath;
      if (!/^[a-f0-9]{64}$/.test(expectedCurrentSha256 || "")) {
        const error = new Error("Confirma la huella actual antes de sobrescribir durante la restauracion.");
        error.code = "STATE_CONFLICT";
        throw error;
      }
      destinationHash = expectedCurrentSha256;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      destination = await resolveNewWorkspaceFile(context.workspace, latest.originalPath);
    }
    await atomicRestoreFromFile(validated.backupPath, destination, {
      expectedSourceHash: latest.sha256,
      expectedDestinationHash: destinationHash,
    });
    await log("backup_restored", { profileId: context.profile.id, path: latest.originalPath, backupId: latest.id });
    return latest;
  }

  async function backupRestorePrecondition() {
    const context = await activeContext();
    const latest = (await listBackups(context.backupsRoot, context.binding))[0];
    if (!latest) throw new Error("No hay copias de seguridad disponibles.");
    validateBackupMetadata(latest, context.binding);
    try {
      const existing = await resolveExistingWorkspaceFile(context.workspace, latest.originalPath);
      return { backupId: latest.id, originalPath: latest.originalPath, destinationExists: true, currentSha256: await sha256File(existing.realPath) };
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await resolveNewWorkspaceFile(context.workspace, latest.originalPath);
      return { backupId: latest.id, originalPath: latest.originalPath, destinationExists: false, currentSha256: null };
    }
  }

  async function latestTrashItem() {
    const context = await activeContext().catch(() => null);
    if (!context) return null;
    const trashRoot = path.join(context.workspace, ".mcp-papelera");
    try {
      const items = [];
      for (const entry of await fs.readdir(trashRoot, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        try {
          const metadata = JSON.parse(await fs.readFile(path.join(trashRoot, entry.name), "utf8"));
          validateSafeRelativePath(metadata.originalPath);
          if (typeof metadata.trashFile !== "string" || path.basename(metadata.trashFile) !== metadata.trashFile || entry.name !== `${metadata.trashFile}.json`) continue;
          items.push({ ...metadata, metadataFile: entry.name, workspace: context.workspace, profileId: context.profile.id, trashRoot });
        } catch {}
      }
      return items.sort((a, b) => Date.parse(b.deletedAt) - Date.parse(a.deletedAt))[0] || null;
    } catch { return null; }
  }

  async function restoreLatestTrash() {
    const item = await latestTrashItem();
    if (!item) throw new Error("La papelera recuperable esta vacia.");
    const destination = await resolveNewWorkspaceFile(item.workspace, item.originalPath);
    const trashFilePath = path.resolve(item.trashRoot, item.trashFile);
    if (path.dirname(trashFilePath) !== path.resolve(item.trashRoot)) throw new Error("La entrada de papelera no es valida.");
    await atomicMoveToNewPath(trashFilePath, destination, item.sha256 || null);
    await fs.rm(path.join(item.trashRoot, item.metadataFile), { force: true });
    await log("trash_restored", { path: item.originalPath });
    return item;
  }

  async function state() {
    const context = await activeContext();
    const settings = await readSettings(context.settingsPath);
    const expiredBackups = await cleanupExpiredBackups(context.backupsRoot, settings.backupRetentionDays, context.binding);
    if (expiredBackups) await log("backup_cleanup", { count: expiredBackups });
    const savedProfiles = await profiles();
    const approvalRequests = await readApprovals(context.approvalsPath);
    const activity = await recentActivity(activityPath, 100);
    const backups = await listBackups(context.backupsRoot, context.binding);
    const trash = await latestTrashItem();
    const readiness = await readyStatus();
    const active = savedProfiles.profiles.find((profile) => profile.id === savedProfiles.activeProfileId) || null;
    const lastMcp = activity.find((event) => event.source === "mcp") || null;
    return {
      running: Boolean(tunnelProcess), ready: readiness.ready, pid: tunnelProcess?.pid ?? null, startedAt: tunnelStartedAt,
      workspace: active?.workspace ?? null, workspaceFingerprint: context.fingerprint, profileIsolation: true, settings, permissions: effectivePermissions(settings), permissionExpiresAt: settings.permissionExpiresAt,
      profiles: savedProfiles, pendingApprovals: approvalRequests.filter((item) => item.status === "pending").slice(-20).reverse(),
      backups: { count: backups.length, latest: backups[0] || null }, trash: { latest: trash ? { originalPath: trash.originalPath, deletedAt: trash.deletedAt } : null },
      autostart: await autostartEnabled(), activity, auditIntegrity: await verifyAuditChain(activityPath), panelLanguage: "es", dynamicPermissions: true,
      tunnelAdminUrl: `${tunnelHealthUrl}/ui`,
      connection: { healthLatencyMs: readiness.latencyMs, lastCheckedAt: new Date().toISOString(), lastMcpActivity: lastMcp?.timestamp ?? null, lastMcpAction: lastMcp?.action ?? null, uptimeSeconds: tunnelStartedAt ? Math.max(0, Math.round((Date.now() - Date.parse(tunnelStartedAt)) / 1000)) : 0 },
    };
  }

  function validApiRequest(request) {
    if (request.headers["x-control-token"] !== token) return false;
    const origin = request.headers.origin;
    return !origin || origin === loopbackOrigin(host, server.address().port) || origin === `http://localhost:${server.address().port}`;
  }

  async function serveStatic(response, fileName, contentType) {
    const content = await fs.readFile(path.join(panelRoot, fileName));
    response.writeHead(200, {
      "Content-Type": contentType, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'",
      "Referrer-Policy": "no-referrer",
    });
    response.end(content);
  }

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, request.headers.host ? `http://${request.headers.host}` : loopbackOrigin(host, port));
      const apiPath = url.pathname === apiBasePath ? "/" : url.pathname.startsWith(`${apiBasePath}/`) ? url.pathname.slice(apiBasePath.length) : null;
      if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/ui")) return await serveStatic(response, "index.html", "text/html; charset=utf-8");
      if (request.method === "GET" && url.pathname === "/styles.css") return await serveStatic(response, "styles.css", "text/css; charset=utf-8");
      if (request.method === "GET" && url.pathname === "/app.js") return await serveStatic(response, "app.js", "text/javascript; charset=utf-8");
      if (request.method === "GET" && url.pathname === "/healthz") return jsonResponse(response, 200, { status: "live", tunnelRunning: Boolean(tunnelProcess) });
      if (request.method === "GET" && url.pathname === "/readyz") { const ready = (await readyStatus()).ready; return jsonResponse(response, ready ? 200 : 503, { status: ready ? "ready" : "not_ready" }); }
      if (apiPath && !validApiRequest(request)) return jsonResponse(response, 403, apiErrorPayload("UNAUTHORIZED", "Solicitud local no autorizada."));
      if (request.method === "GET" && apiPath === "/state") return jsonResponse(response, 200, await state());

      if (request.method === "PATCH" && apiPath === "/permissions") {
        const body = parseApiInput(apiSchemas.permissionPatch, await readJsonBody(request));
        const context = await activeContext();
        const settings = await updatePermission(context.settingsPath, body.permission, body.value, body.durationMinutes ?? null);
        await log("permission_change", { profileId: context.profile.id, permission: body.permission, value: body.value, expiresAt: settings.permissionExpiresAt[body.permission] });
        return jsonResponse(response, 200, { permissions: effectivePermissions(settings), settings, restartRequired: false });
      }

      if (request.method === "PATCH" && apiPath === "/settings") {
        const body = parseApiInput(apiSchemas.settingsPatch, await readJsonBody(request));
        const context = await activeContext();
        const settings = await readSettings(context.settingsPath);
        const allowedBoolean = ["approvalRequired", "sensitiveProtection", "backupEnabled"];
        for (const key of allowedBoolean) if (key in body) {
          settings[key] = body[key];
        }
        if ("backupRetentionDays" in body) {
          settings.backupRetentionDays = body.backupRetentionDays;
        }
        await writeSettings(context.settingsPath, settings);
        await log("security_settings_change", { profileId: context.profile.id, changes: body });
        return jsonResponse(response, 200, { settings });
      }

      if (request.method === "POST" && apiPath === "/profiles") {
        const body = parseApiInput(apiSchemas.profileCreate, await readJsonBody(request));
        const workspace = await validateWorkspace(body.workspace, dataRoot);
        const saved = await profiles();
        const profile = createProfile(body.name, workspace);
        saved.profiles.push(profile);
        if (!saved.activeProfileId) saved.activeProfileId = profile.id;
        await writeProfiles(profilesPath, saved);
        await log("profile_created", { profileId: profile.id, workspace });
        return jsonResponse(response, 201, { profiles: saved });
      }

      if (request.method === "PATCH" && apiPath === "/profiles/active") {
        const body = parseApiInput(apiSchemas.activeProfilePatch, await readJsonBody(request));
        const saved = await profiles();
        if (!saved.profiles.some((profile) => profile.id === body.id)) return jsonResponse(response, 404, apiErrorPayload("NOT_FOUND", "Perfil no encontrado."));
        saved.activeProfileId = body.id;
        await writeProfiles(profilesPath, saved);
        await log("profile_selected", { profileId: body.id });
        if (tunnelProcess) await restartTunnel();
        return jsonResponse(response, 200, await state());
      }

      if (request.method === "DELETE" && /^\/profiles\/[^/]+$/.test(apiPath || "")) {
        const id = decodeURIComponent(apiPath.split("/").pop());
        const saved = await profiles();
        if (saved.profiles.length <= 1) return jsonResponse(response, 409, apiErrorPayload("STATE_CONFLICT", "Debe existir al menos un perfil."));
        if (id === saved.activeProfileId) return jsonResponse(response, 409, apiErrorPayload("STATE_CONFLICT", "No puedes borrar el perfil activo."));
        saved.profiles = saved.profiles.filter((profile) => profile.id !== id);
        await writeProfiles(profilesPath, saved);
        await log("profile_deleted", { profileId: id });
        return jsonResponse(response, 200, { profiles: saved });
      }

      if (request.method === "POST" && /^\/approvals\/[^/]+$/.test(apiPath || "")) {
        const id = decodeURIComponent(apiPath.split("/").pop());
        const body = parseApiInput(apiSchemas.approvalDecision, await readJsonBody(request));
        const context = await activeContext();
        const approval = await decideApproval(context.approvalsPath, id, body.status, { profileId: context.profile.id, workspaceFingerprint: context.fingerprint });
        if (!approval) return jsonResponse(response, 404, apiErrorPayload("NOT_FOUND", "Solicitud pendiente no encontrada."));
        await log(`approval_${body.status}`, { profileId: context.profile.id, requestId: id, path: approval.path, requestedAction: approval.action });
        return jsonResponse(response, 200, { approval });
      }

      if (request.method === "GET" && apiPath === "/backups/latest/restore-precondition") {
        return jsonResponse(response, 200, await backupRestorePrecondition());
      }
      if (request.method === "POST" && apiPath === "/backups/latest/restore") {
        const body = parseApiInput(apiSchemas.backupRestore, await readJsonBody(request));
        const restored = await restoreLatestBackup(body.expectedCurrentSha256 ?? null);
        return jsonResponse(response, 200, { restored });
      }
      if (request.method === "POST" && apiPath === "/trash/latest/restore") { const restored = await restoreLatestTrash(); return jsonResponse(response, 200, { restored }); }
      if (request.method === "PATCH" && apiPath === "/autostart") { const body = parseApiInput(apiSchemas.autostartPatch, await readJsonBody(request)); await setAutostart(body.value); return jsonResponse(response, 200, { autostart: await autostartEnabled() }); }

      if (request.method === "POST" && apiPath?.startsWith("/tunnel/")) {
        const action = apiPath.split("/").pop();
        if (action === "start") await startTunnel(); else if (action === "stop") await stopTunnel(); else if (action === "restart") await restartTunnel(); else return jsonResponse(response, 404, apiErrorPayload("NOT_FOUND", "Accion desconocida."));
        return jsonResponse(response, 200, await state());
      }
      return jsonResponse(response, 404, apiErrorPayload("NOT_FOUND", "No encontrado."));
    } catch (error) {
      await log("panel_error", { result: "error", error: error instanceof Error ? error.message : "Error interno." }).catch(() => {});
      if (error instanceof ApiError) return jsonResponse(response, error.status, apiErrorPayload(error.code, error.message, error.details));
      if (error?.code === "STATE_CONFLICT") return jsonResponse(response, 409, apiErrorPayload("STATE_CONFLICT", error.message));
      return jsonResponse(response, 500, apiErrorPayload("INTERNAL_ERROR", "No se pudo completar la operacion."));
    }
  });

  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, host, resolve); });
  const origin = loopbackOrigin(host, server.address().port);
  const panelUrl = `${origin}/ui#${token}`;
  const panelUrlPath = path.join(dataRoot, "panel-url.txt");
  await fs.mkdir(dataRoot, { recursive: true });
  await fs.writeFile(panelUrlPath, panelUrl, { encoding: "utf8", mode: 0o600 });
  if (options.autoStart !== false) await startTunnel();
  return { url: origin, panelUrl, token, state, startTunnel, stopTunnel, restartTunnel, async close() { await stopTunnel(); await new Promise((resolve) => server.close(resolve)); await fs.rm(panelUrlPath, { force: true }).catch(() => {}); } };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const controlPlaneApiKey = process.env.CONTROL_PLANE_API_KEY || null;
  for (const name of controlPlaneSecretNames) delete process.env[name];
  const controller = await createControlPanel({ controlPlaneApiKey, testMode: process.env.CONTROL_PANEL_TEST_MODE === "1" });
  console.log("Panel de control seguro preparado.");
  if (process.env.CONTROL_PANEL_SHOW_URL === "1") console.log(`Panel local: ${controller.panelUrl}`);
  if (process.env.CONTROL_PANEL_OPEN_BROWSER === "1") {
    const command = process.platform === "win32" ? "cmd.exe" : process.platform === "darwin" ? "open" : "xdg-open";
    const args = process.platform === "win32" ? ["/c", "start", "", controller.panelUrl] : [controller.panelUrl];
    const opener = spawn(command, args, { detached: true, env: buildSanitizedEnvironment(process.env), windowsHide: true, stdio: "ignore" });
    opener.on("error", () => {});
    opener.unref();
  }
  let closing = false;
  const shutdown = async () => { if (closing) return; closing = true; await controller.close(); process.exit(0); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

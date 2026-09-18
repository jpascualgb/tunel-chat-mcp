import fs from "node:fs/promises";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createControlPanel, loopbackOrigin, spawnTunnelProcess } from "./control-panel.mjs";
import { profileDataPaths, workspaceFingerprint } from "./secure-store.mjs";

const panelHtml = await fs.readFile(new URL("./panel/index.html", import.meta.url), "utf8");
assert.match(panelHtml, /<title>Túnel Chat MCP<\/title>/);
assert.match(panelHtml, /<h1>Túnel Chat MCP<\/h1>/);

const temporaryBase = await fs.mkdtemp(path.join(os.tmpdir(), "pc-personal-panel-test-"));
const temporaryRoot = path.join(temporaryBase, "workspace");
const physicalDataRoot = path.join(temporaryBase, "data-real");
const dataRoot = path.join(temporaryBase, "data-alias");
await fs.mkdir(temporaryRoot);
await fs.mkdir(physicalDataRoot);
await fs.symlink(physicalDataRoot, dataRoot, process.platform === "win32" ? "junction" : "dir");
const profilesPath = path.join(dataRoot, "profiles.json");
const profile = { id: "test", name: "Pruebas", workspace: await fs.realpath(temporaryRoot) };
const { settingsPath: permissionsPath, approvalsPath, backupsRoot } = profileDataPaths(dataRoot, profile);
const activityPath = path.join(dataRoot, "activity.jsonl");
assert.equal(loopbackOrigin("127.0.0.1", 8080), "http://127.0.0.1:8080");
assert.equal(loopbackOrigin("::1", 8080), "http://[::1]:8080");
await assert.rejects(
  spawnTunnelProcess("secure-mcp-command-that-does-not-exist", [], { cwd: temporaryRoot }),
  /no se pudo iniciar tunnel-client/i,
);
await fs.mkdir(path.dirname(permissionsPath), { recursive: true });
await fs.writeFile(permissionsPath, JSON.stringify({ read: true, create: true, modify: true, delete: true, approvalRequired: true, sensitiveProtection: true, backupEnabled: true, backupRetentionDays: 30 }));
await fs.writeFile(profilesPath, JSON.stringify({ activeProfileId: "test", profiles: [profile] }));
await assert.rejects(
  createControlPanel({ host: "0.0.0.0", port: 0, testMode: true, autoStart: false, dataRoot }),
  /loopback|127\.0\.0\.1/i,
);
const controller = await createControlPanel({
  port: 0,
  testMode: true,
  autoStart: false,
  dataRoot,
});

async function api(route, options = {}) {
  const response = await fetch(`${controller.url}${route}`, {
    ...options,
    headers: { "Content-Type": "application/json", "X-Control-Token": controller.token },
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error?.message || `HTTP ${response.status}`);
  return payload;
}

try {
  const page = await fetch(`${controller.url}/ui`);
  const html = await page.text();
  if (!html.includes("Permisos de archivos") || !html.includes("Aprobaciones pendientes") || !html.includes("data-language=\"en\"") || html.includes("control-token") || !/#\w{48}$/.test(controller.panelUrl)) {
    throw new Error("El panel no contiene la interfaz bilingue esperada.");
  }

  const unauthorized = await fetch(`${controller.url}/api/v1/state`);
  const unauthorizedPayload = await unauthorized.json();
  if (unauthorized.status !== 403 || unauthorizedPayload.error?.code !== "UNAUTHORIZED") {
    throw new Error("La API versionada no devolvio un error de autorizacion estructurado.");
  }

  const invalidPermission = await fetch(`${controller.url}/api/v1/permissions`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "X-Control-Token": controller.token },
    body: JSON.stringify({ permission: "admin", value: true }),
  });
  const invalidPermissionPayload = await invalidPermission.json();
  if (invalidPermission.status !== 422 || invalidPermissionPayload.error?.code !== "VALIDATION_ERROR") {
    throw new Error("La API versionada no valido su contrato de entrada.");
  }

  const missingProfile = await fetch(`${controller.url}/api/v1/profiles/active`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "X-Control-Token": controller.token },
    body: JSON.stringify({ id: "missing-profile" }),
  });
  const missingProfilePayload = await missingProfile.json();
  if (missingProfile.status !== 404 || missingProfilePayload.error?.code !== "NOT_FOUND") {
    throw new Error("La API versionada no mantuvo el contrato de errores de recurso.");
  }

  const initial = await api("/api/v1/state");
  if (initial.running || initial.permissions.delete !== true || initial.settings.approvalRequired !== true || initial.profiles.activeProfileId !== "test" || initial.auditIntegrity !== true) throw new Error("Estado inicial incorrecto.");

  const changed = await api("/api/v1/permissions", {
    method: "PATCH",
    body: JSON.stringify({ permission: "delete", value: false, durationMinutes: null }),
  });
  if (changed.permissions.delete !== false || changed.restartRequired !== false) {
    throw new Error("El cambio dinamico de permisos no funciono.");
  }

  const autonomous = await api("/api/v1/settings", { method: "PATCH", body: JSON.stringify({ approvalRequired: false, backupRetentionDays: 15 }) });
  if (autonomous.settings.approvalRequired !== false || autonomous.settings.backupRetentionDays !== 15) throw new Error("Los ajustes de seguridad no se guardaron.");

  const autostart = await api("/api/v1/autostart", { method: "PATCH", body: JSON.stringify({ value: true }) });
  if (!autostart.autostart) throw new Error("El control de inicio con Windows no funciono.");

  const secondWorkspace = path.join(temporaryRoot, "segundo");
  await fs.mkdir(secondWorkspace);
  const profileResult = await api("/api/v1/profiles", { method: "POST", body: JSON.stringify({ name: "Segundo", workspace: secondWorkspace }) });
  if (profileResult.profiles.profiles.length !== 2) throw new Error("No se pudo crear un perfil.");
  const secondProfile = profileResult.profiles.profiles.find((item) => item.name === "Segundo");
  const secondState = await api("/api/v1/profiles/active", { method: "PATCH", body: JSON.stringify({ id: secondProfile.id }) });
  if (secondState.permissions.delete !== false || secondState.settings.approvalRequired !== true) throw new Error("Los ajustes se filtraron de un perfil a otro.");
  await api("/api/v1/profiles/active", { method: "PATCH", body: JSON.stringify({ id: "test" }) });

  const blockedWorkspaceResponse = await fetch(`${controller.url}/api/v1/profiles`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Control-Token": controller.token },
    body: JSON.stringify({ name: "Control", workspace: path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?:([A-Za-z]:))/, "$1")) }),
  });
  if (blockedWorkspaceResponse.ok) throw new Error("El panel permitio autorizar la carpeta del propio tunel.");

  const blockedDataResponse = await fetch(`${controller.url}/api/v1/profiles`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Control-Token": controller.token },
    body: JSON.stringify({ name: "Datos privados", workspace: physicalDataRoot }),
  });
  if (blockedDataResponse.ok) throw new Error("El panel permitio autorizar sus propios datos privados.");

  await fs.writeFile(approvalsPath, JSON.stringify({ requests: [{ id: "11111111-1111-4111-8111-111111111111", operationKey: "x", status: "pending", createdAt: new Date().toISOString(), profileId: "test", workspaceFingerprint: workspaceFingerprint(profile.workspace), action: "delete", path: "demo.txt" }] }));
  const approval = await api("/api/v1/approvals/11111111-1111-4111-8111-111111111111", { method: "POST", body: JSON.stringify({ status: "approved" }) });
  if (approval.approval.status !== "approved") throw new Error("La decision de aprobacion no funciono.");

  await fs.mkdir(backupsRoot, { recursive: true });
  await fs.writeFile(path.join(temporaryRoot, "restore.txt"), "nuevo");
  await fs.writeFile(path.join(backupsRoot, "backup-test.bin"), "anterior");
  const backupId = `1700000000000-11111111-1111-4111-8111-111111111111`;
  await fs.rename(path.join(backupsRoot, "backup-test.bin"), path.join(backupsRoot, `${backupId}.bin`));
  await fs.writeFile(path.join(backupsRoot, `${backupId}.json`), JSON.stringify({
    id: backupId, createdAt: new Date().toISOString(), profileId: "test", workspaceFingerprint: workspaceFingerprint(profile.workspace), action: "sobrescribir",
    originalPath: "restore.txt", backupFile: `${backupId}.bin`, size: 8, sha256: "1cc40893501a6a30f02e8b24ee70ba2dff7115af4783a67fda2dc4cba4c895d5",
  }));
  const restorePrecondition = await api("/api/v1/backups/latest/restore-precondition");
  const currentRestoreHash = createHash("sha256").update("nuevo").digest("hex");
  if (restorePrecondition.currentSha256 !== currentRestoreHash) throw new Error("La precondicion de restauracion no refleja el archivo actual.");
  const unguardedRestore = await fetch(`${controller.url}/api/v1/backups/latest/restore`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Control-Token": controller.token },
    body: "{}",
  });
  if (unguardedRestore.status !== 409) throw new Error("La restauracion permitio sobrescribir sin comprobar el estado actual.");
  await api("/api/v1/backups/latest/restore", { method: "POST", body: JSON.stringify({ expectedCurrentSha256: currentRestoreHash }) });
  if (await fs.readFile(path.join(temporaryRoot, "restore.txt"), "utf8") !== "anterior") throw new Error("La restauracion de copia no funciono.");

  const trashRoot = path.join(temporaryRoot, ".mcp-papelera");
  await fs.mkdir(trashRoot);
  await fs.writeFile(path.join(trashRoot, "deleted.bin"), "recuperado");
  await fs.writeFile(path.join(trashRoot, "deleted.bin.json"), JSON.stringify({ originalPath: "deleted.txt", trashFile: "deleted.bin", deletedAt: new Date().toISOString() }));
  await api("/api/v1/trash/latest/restore", { method: "POST", body: "{}" });
  if (await fs.readFile(path.join(temporaryRoot, "deleted.txt"), "utf8") !== "recuperado") throw new Error("La restauracion de papelera no funciono.");

  const started = await api("/api/v1/tunnel/start", { method: "POST", body: "{}" });
  if (!started.running || !started.ready) throw new Error("El inicio del tunel no funciono.");
  const restarted = await api("/api/v1/tunnel/restart", { method: "POST", body: "{}" });
  if (!restarted.running) throw new Error("El reinicio del tunel no funciono.");
  const stopped = await api("/api/v1/tunnel/stop", { method: "POST", body: "{}" });
  if (stopped.running) throw new Error("El apagado del tunel no funciono.");

  console.log("Panel verificado: ES/EN, seguridad, perfiles, autostart, aprobaciones y tunel funcionan.");
} finally {
  await controller.close();
  if (path.basename(temporaryBase).startsWith("pc-personal-panel-test-")) {
    await fs.rm(temporaryBase, { recursive: true, force: true });
  }
}

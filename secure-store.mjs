import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

export const permissionNames = ["read", "create", "modify", "delete"];

export const defaultSettings = {
  read: true,
  create: false,
  modify: false,
  delete: false,
  permissionExpiresAt: { read: null, create: null, modify: null, delete: null },
  approvalRequired: true,
  sensitiveProtection: true,
  backupEnabled: true,
  backupRetentionDays: 30,
};

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function readJson(filePath, fallback) {
  try { return JSON.parse(await fs.readFile(filePath, "utf8")); }
  catch { return structuredClone(fallback); }
}

async function writeJsonUnlocked(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.rename(temporaryPath, filePath);
}

export async function withFileLock(filePath, callback) {
  const lockPath = `${filePath}.lock`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  for (let attempt = 0; attempt < 80; attempt += 1) {
    let handle;
    try {
      handle = await fs.open(lockPath, "wx", 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
      try { return await callback(); }
      finally {
        await handle.close().catch(() => {});
        await fs.rm(lockPath, { force: true }).catch(() => {});
      }
    } catch (error) {
      await handle?.close().catch(() => {});
      if (error?.code !== "EEXIST") throw error;
      try {
        const stats = await fs.stat(lockPath);
        if (Date.now() - stats.mtimeMs > 30_000) await fs.rm(lockPath, { force: true });
      } catch {}
      await wait(25 + Math.floor(Math.random() * 25));
    }
  }
  throw new Error("El archivo de seguridad esta ocupado. Vuelve a intentarlo.");
}

export function normalizePathForIdentity(value) {
  return path.resolve(value).replace(/[\\/]+$/, "").normalize("NFC").toLowerCase();
}

export function workspaceFingerprint(workspace) {
  return createHash("sha256").update(normalizePathForIdentity(workspace)).digest("hex");
}

export function profileDataPaths(dataRoot, profile) {
  if (!profile?.id || !/^[a-zA-Z0-9-]{1,80}$/.test(profile.id)) throw new Error("El identificador del perfil no es valido.");
  const root = path.join(dataRoot, "profiles", profile.id);
  return { root, settingsPath: path.join(root, "settings.json"), approvalsPath: path.join(root, "approvals.json"), backupsRoot: path.join(root, "backups") };
}

export function pathsOverlap(first, second) {
  const a = normalizePathForIdentity(first);
  const b = normalizePathForIdentity(second);
  return a === b || a.startsWith(`${b}${path.sep}`) || b.startsWith(`${a}${path.sep}`);
}

export function validateSafeRelativePath(value) {
  const input = typeof value === "string" && value.trim() ? value.trim() : ".";
  if (input.includes("\0") || path.isAbsolute(input) || /^[a-zA-Z]:/.test(input)) throw new Error("Usa una ruta relativa valida dentro de la carpeta autorizada.");
  const segments = input.replace(/\\/g, "/").split("/");
  const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
  for (const segment of segments) {
    if (!segment || segment === ".") continue;
    if (segment === "..") throw new Error("La ruta solicitada queda fuera de la carpeta autorizada.");
    if (segment.includes(":")) throw new Error("No se permiten flujos alternativos de archivos (ADS).");
    if (/[. ]$/.test(segment) || reserved.test(segment)) throw new Error("La ruta contiene un nombre ambiguo o reservado de Windows.");
  }
  return input;
}

export async function readSettings(settingsPath) {
  const saved = await readJson(settingsPath, defaultSettings);
  const expires = saved.permissionExpiresAt || {};
  return {
    read: saved.read === true, create: saved.create === true, modify: saved.modify === true, delete: saved.delete === true,
    permissionExpiresAt: Object.fromEntries(permissionNames.map((name) => [name, typeof expires[name] === "string" ? expires[name] : null])),
    approvalRequired: saved.approvalRequired !== false,
    sensitiveProtection: saved.sensitiveProtection !== false,
    backupEnabled: saved.backupEnabled !== false,
    backupRetentionDays: [15, 30].includes(saved.backupRetentionDays) ? saved.backupRetentionDays : saved.backupRetentionDays === null ? null : 30,
  };
}

export async function writeSettings(settingsPath, settings) {
  await withFileLock(settingsPath, () => writeJsonUnlocked(settingsPath, { ...settings, updatedAtUtc: new Date().toISOString() }));
}

export function effectivePermissions(settings, now = Date.now()) {
  return Object.fromEntries(permissionNames.map((name) => {
    const expiresAt = settings.permissionExpiresAt?.[name];
    return [name, settings[name] === true && (!expiresAt || Date.parse(expiresAt) > now)];
  }));
}

export async function updatePermission(settingsPath, permission, value, durationMinutes = null) {
  return withFileLock(settingsPath, async () => {
    const settings = await readSettings(settingsPath);
    settings[permission] = value;
    settings.permissionExpiresAt[permission] = value && Number.isFinite(durationMinutes) ? new Date(Date.now() + durationMinutes * 60_000).toISOString() : null;
    await writeJsonUnlocked(settingsPath, { ...settings, updatedAtUtc: new Date().toISOString() });
    return settings;
  });
}

async function rotateAuditUnlocked(activityPath, maxBytes, retainedFiles) {
  try { if ((await fs.stat(activityPath)).size < maxBytes) return; }
  catch { return; }
  for (let index = retainedFiles - 1; index >= 1; index -= 1) await fs.rename(`${activityPath}.${index}`, `${activityPath}.${index + 1}`).catch(() => {});
  await fs.rename(activityPath, `${activityPath}.1`);
}

async function lastAuditHash(activityPath) {
  try {
    const lines = (await fs.readFile(activityPath, "utf8")).trim().split(/\r?\n/).filter(Boolean);
    const last = JSON.parse(lines.at(-1));
    return typeof last.eventHash === "string" ? last.eventHash : null;
  } catch { return null; }
}

export async function appendActivity(activityPath, event, options = {}) {
  await withFileLock(activityPath, async () => {
    await fs.mkdir(path.dirname(activityPath), { recursive: true });
    await rotateAuditUnlocked(activityPath, options.maxBytes ?? 5 * 1024 * 1024, options.retainedFiles ?? 5);
    const record = { timestamp: new Date().toISOString(), result: "success", ...event, previousHash: await lastAuditHash(activityPath) };
    record.eventHash = createHash("sha256").update(JSON.stringify(record)).digest("hex");
    await fs.appendFile(activityPath, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
  });
}

export async function recentActivity(activityPath, limit = 100) {
  try {
    const lines = (await fs.readFile(activityPath, "utf8")).trim().split(/\r?\n/).filter(Boolean);
    return lines.slice(-limit).reverse().flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
  } catch { return []; }
}

export async function verifyAuditChain(activityPath) {
  try {
    const lines = (await fs.readFile(activityPath, "utf8")).trim().split(/\r?\n/).filter(Boolean);
    let previousHash = null;
    for (const line of lines) {
      const record = JSON.parse(line);
      const storedHash = record.eventHash;
      const clone = { ...record };
      delete clone.eventHash;
      if (clone.previousHash !== previousHash || storedHash !== createHash("sha256").update(JSON.stringify(clone)).digest("hex")) return false;
      previousHash = storedHash;
    }
    return true;
  } catch { return false; }
}

export async function readProfiles(profilesPath, fallbackWorkspace = null) {
  const fallback = fallbackWorkspace ? { activeProfileId: "default", profiles: [{ id: "default", name: "Principal", workspace: fallbackWorkspace }] } : { activeProfileId: null, profiles: [] };
  const saved = await readJson(profilesPath, fallback);
  const profiles = Array.isArray(saved.profiles) ? saved.profiles.filter((profile) => typeof profile?.id === "string" && /^[a-zA-Z0-9-]{1,80}$/.test(profile.id) && typeof profile?.name === "string" && typeof profile?.workspace === "string") : [];
  const activeProfileId = profiles.some((profile) => profile.id === saved.activeProfileId) ? saved.activeProfileId : profiles[0]?.id ?? null;
  return { activeProfileId, profiles };
}

export async function writeProfiles(profilesPath, profiles) {
  await withFileLock(profilesPath, () => writeJsonUnlocked(profilesPath, { ...profiles, updatedAtUtc: new Date().toISOString() }));
}

export function createProfile(name, workspace) { return { id: randomUUID(), name: name.trim(), workspace }; }

export async function readApprovals(approvalsPath) {
  const saved = await readJson(approvalsPath, { requests: [] });
  return Array.isArray(saved.requests) ? saved.requests : [];
}

async function writeApprovalsUnlocked(approvalsPath, requests) {
  await writeJsonUnlocked(approvalsPath, { requests: requests.slice(-100), updatedAtUtc: new Date().toISOString() });
}

export async function writeApprovals(approvalsPath, requests) { await withFileLock(approvalsPath, () => writeApprovalsUnlocked(approvalsPath, requests)); }

export async function upsertApproval(approvalsPath, request) {
  return withFileLock(approvalsPath, async () => {
    const requests = await readApprovals(approvalsPath);
    const existing = requests.find((item) => item.operationKey === request.operationKey && item.status === "pending");
    if (existing) return existing;
    requests.push(request);
    await writeApprovalsUnlocked(approvalsPath, requests);
    return request;
  });
}

export async function decideApproval(approvalsPath, id, status, expected = null) {
  return withFileLock(approvalsPath, async () => {
    const requests = await readApprovals(approvalsPath);
    const request = requests.find((item) => item.id === id);
    if (!request || request.status !== "pending") return null;
    if (expected && (request.profileId !== expected.profileId || request.workspaceFingerprint !== expected.workspaceFingerprint)) return null;
    request.status = status;
    request.decidedAt = new Date().toISOString();
    await writeApprovalsUnlocked(approvalsPath, requests);
    return request;
  });
}

export async function consumeApproval(approvalsPath, id, operationKey) {
  return withFileLock(approvalsPath, async () => {
    const requests = await readApprovals(approvalsPath);
    const request = requests.find((item) => item.id === id);
    if (!request || request.operationKey !== operationKey || request.status !== "approved") return null;
    if (Date.now() - Date.parse(request.decidedAt || request.createdAt) > 30 * 60_000) return null;
    request.status = "used";
    request.usedAt = new Date().toISOString();
    await writeApprovalsUnlocked(approvalsPath, requests);
    return request;
  });
}

export function isSensitiveRelativePath(relativePath) {
  const normalized = relativePath.replace(/\\/g, "/").normalize("NFC").toLowerCase();
  const parts = normalized.split("/").filter(Boolean);
  const base = parts.at(-1) || "";
  const protectedDirectories = new Set([".git", ".svn", ".hg", ".ssh", ".aws", ".azure", ".gnupg", ".kube", ".docker", ".tunnel-client"]);
  if (parts.some((part) => protectedDirectories.has(part))) return true;
  if (base === ".env" || base.startsWith(".env.")) return true;
  if (["id_rsa", "id_ed25519", "credentials", "credentials.json", "secrets.json", ".npmrc", ".pypirc", "netrc", ".netrc"].includes(base)) return true;
  if ([".pem", ".key", ".pfx", ".p12", ".kdbx", ".keystore", ".jks"].some((extension) => base.endsWith(extension))) return true;
  return false;
}

export function validateBackupMetadata(metadata, binding) {
  const validId = typeof metadata?.id === "string" && /^\d{13}-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(metadata.id);
  if (!validId || metadata.backupFile !== `${metadata.id}.bin`) throw new Error("Metadatos de copia no validos.");
  if (metadata.profileId !== binding.profileId || metadata.workspaceFingerprint !== binding.workspaceFingerprint) throw new Error("La copia no pertenece al perfil activo.");
  if (typeof metadata.originalPath !== "string" || metadata.originalPath === ".") throw new Error("Ruta original de copia no valida.");
  validateSafeRelativePath(metadata.originalPath);
  if (!/^[a-f0-9]{64}$/.test(metadata.sha256 || "")) throw new Error("Huella de copia no valida.");
  const backupPath = path.resolve(binding.backupsRoot, metadata.backupFile);
  const metadataPath = path.resolve(binding.backupsRoot, `${metadata.id}.json`);
  for (const candidate of [backupPath, metadataPath]) {
    const relative = path.relative(path.resolve(binding.backupsRoot), candidate);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("La copia queda fuera del almacen autorizado.");
  }
  return { metadata, backupPath, metadataPath };
}

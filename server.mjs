import fs from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  appendActivity,
  consumeApproval,
  effectivePermissions,
  isSensitiveRelativePath,
  pathsOverlap,
  readApprovals,
  readSettings,
  upsertApproval,
  validateBackupMetadata,
  validateSafeRelativePath,
  workspaceFingerprint,
} from "./secure-store.mjs";
import { atomicRestoreFromFile, atomicWriteBuffer, atomicWriteJsonFile, bufferPreview, readBoundedPreview, sha256File } from "./safe-files.mjs";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = process.env.MCP_WORKSPACE_ROOT?.trim() || null;
const settingsPath = process.env.MCP_SETTINGS_PATH || process.env.MCP_PERMISSIONS_PATH || path.join(projectRoot, ".tunnel-client", "permissions.json");
const activityPath = process.env.MCP_ACTIVITY_PATH || path.join(projectRoot, ".tunnel-client", "activity.jsonl");
const approvalsPath = process.env.MCP_APPROVALS_PATH || path.join(projectRoot, ".tunnel-client", "approvals.json");
const backupsRoot = process.env.MCP_BACKUPS_ROOT || path.join(projectRoot, ".tunnel-client", "backups");
const profileId = process.env.MCP_PROFILE_ID?.trim() || "default";
const controlDataRoot = process.env.MCP_CONTROL_DATA_ROOT?.trim() || null;
const trashName = ".mcp-papelera";
const internalNames = new Set([trashName, ".mcp-copias", ".tunnel-client"]);
const maxListEntries = 500;
const maxReadBytes = 2 * 1024 * 1024;
const maxWriteBytes = 5 * 1024 * 1024;

let workspaceRealRoot = null;
let workspaceInitializationError = null;
if (workspaceRoot) {
  try {
    workspaceRealRoot = await fs.realpath(workspaceRoot);
    if (pathsOverlap(workspaceRealRoot, projectRoot)) throw new Error("La carpeta autorizada no puede contener el codigo del tunel ni estar dentro de el.");
    if (controlDataRoot && pathsOverlap(workspaceRealRoot, controlDataRoot)) throw new Error("La carpeta autorizada no puede contener los datos privados del tunel ni estar dentro de ellos.");
  } catch (error) { workspaceInitializationError = error; workspaceRealRoot = null; }
}
const workspaceId = workspaceRealRoot ? workspaceFingerprint(workspaceRealRoot) : null;
const backupBinding = { profileId, workspaceFingerprint: workspaceId, backupsRoot };

async function audit(action, relativePath, details = {}) {
  await appendActivity(activityPath, { source: "mcp", profileId, workspaceFingerprint: workspaceId, action, path: relativePath, ...details });
}

async function requirePermission(permission) {
  const settings = await readSettings(settingsPath);
  if (!effectivePermissions(settings)[permission]) {
    const labels = { read: "lectura", create: "creacion", modify: "modificacion", delete: "eliminacion" };
    throw new Error(`El permiso de ${labels[permission]} esta desactivado o ha caducado.`);
  }
  return settings;
}

function ensureWorkspaceAvailable() {
  if (!workspaceRoot || !workspaceRealRoot) {
    const detail = workspaceInitializationError ? "La carpeta guardada ya no existe." : "No hay una carpeta autorizada.";
    throw new Error(`${detail} Selecciona un perfil valido en el panel y reinicia el tunel.`);
  }
}

function isInsideWorkspace(candidatePath) {
  const relative = path.relative(workspaceRealRoot, candidatePath);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function relativeForDisplay(candidatePath) {
  const relative = path.relative(workspaceRealRoot, candidatePath);
  return relative === "" ? "." : relative.split(path.sep).join("/");
}

function validateRelativeInput(requestedPath) {
  ensureWorkspaceAvailable();
  const input = validateSafeRelativePath(requestedPath);
  const candidate = path.resolve(workspaceRoot, input);
  const relative = path.relative(path.resolve(workspaceRoot), candidate);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("La ruta solicitada queda fuera de la carpeta autorizada.");
  return candidate;
}

function assertNotSensitive(candidatePath, settings) {
  const relative = path.relative(path.resolve(workspaceRoot), candidatePath);
  const parts = relative.split(path.sep).filter(Boolean).map((part) => part.toLowerCase());
  if (parts.some((part) => internalNames.has(part))) throw new Error("La ruta pertenece al almacenamiento interno protegido del tunel.");
  if (pathsOverlap(candidatePath, projectRoot)) throw new Error("El codigo y la configuracion del tunel estan siempre protegidos.");
  if (controlDataRoot && pathsOverlap(candidatePath, controlDataRoot)) throw new Error("Los datos privados del tunel estan siempre protegidos.");
  if (settings.sensitiveProtection && isSensitiveRelativePath(relative)) throw new Error("El archivo o carpeta esta protegido por la regla de datos sensibles.");
}

async function assertNoSymlinkComponents(candidatePath, includeFinal = true) {
  const root = path.resolve(workspaceRoot);
  const relative = path.relative(root, candidatePath);
  const parts = relative === "" ? [] : relative.split(path.sep);
  let current = root;
  for (const part of (includeFinal ? parts : parts.slice(0, -1))) {
    current = path.join(current, part);
    const stats = await fs.lstat(current);
    if (stats.isSymbolicLink()) throw new Error("No se permite acceder mediante enlaces simbolicos o uniones.");
  }
}

async function resolveAuthorizedPath(requestedPath, expectedType, settings) {
  const candidate = validateRelativeInput(requestedPath);
  assertNotSensitive(candidate, settings);
  await assertNoSymlinkComponents(candidate);
  const stats = await fs.lstat(candidate);
  const realCandidate = await fs.realpath(candidate);
  if (!isInsideWorkspace(realCandidate)) throw new Error("La ruta resuelta queda fuera de la carpeta autorizada.");
  if (expectedType === "directory" && !stats.isDirectory()) throw new Error("La ruta indicada no es una carpeta.");
  if (expectedType === "file" && !stats.isFile()) throw new Error("La ruta indicada no es un archivo normal.");
  return { realPath: realCandidate, stats };
}

async function resolveAuthorizedNewFile(requestedPath, settings) {
  const candidate = validateRelativeInput(requestedPath);
  assertNotSensitive(candidate, settings);
  if (candidate === path.resolve(workspaceRoot)) throw new Error("Debes indicar el nombre de un archivo nuevo.");
  await assertNoSymlinkComponents(candidate, false);
  const parent = path.dirname(candidate);
  if (!(await fs.lstat(parent)).isDirectory()) throw new Error("La carpeta de destino no existe.");
  const realParent = await fs.realpath(parent);
  if (!isInsideWorkspace(realParent)) throw new Error("La carpeta de destino queda fuera de la carpeta autorizada.");
  try { await fs.lstat(candidate); throw new Error("El archivo ya existe; usa sobrescribir."); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  return path.join(realParent, path.basename(candidate));
}

function hashBuffer(buffer) { return createHash("sha256").update(buffer).digest("hex"); }

function decodeContent(content, format) {
  if (format === "base64") {
    const compact = content.replace(/\s/g, "");
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(compact)) throw new Error("El contenido base64 no es valido.");
    return Buffer.from(compact, "base64");
  }
  return Buffer.from(content, "utf8");
}

function operationKey(action, relativePath, contentHash = "", previousHash = "") {
  return createHash("sha256").update(`${profileId}\0${workspaceId}\0${action}\0${relativePath}\0${previousHash}\0${contentHash}`).digest("hex");
}

async function requireLocalApproval(settings, request, approvalId) {
  if (!settings.approvalRequired) return { autonomous: true };
  const key = operationKey(request.action, request.relativePath, request.contentHash, request.previousHash);
  if (approvalId) {
    const approved = await consumeApproval(approvalsPath, approvalId, key);
    if (!approved) throw new Error("La aprobacion local no existe, ha caducado, ya se uso o no coincide con esta operacion.");
    return { approvalId };
  }
  const pending = await upsertApproval(approvalsPath, {
    id: randomUUID(), operationKey: key, status: "pending", createdAt: new Date().toISOString(),
    profileId, workspaceFingerprint: workspaceId,
    action: request.action, path: request.relativePath, preview: request.preview,
  });
  await audit("approval_requested", request.relativePath, { requestId: pending.id, requestedAction: request.action });
  return { pending };
}

function approvalRequiredResult(request) {
  const payload = { realizado: false, aprobacion_local_necesaria: true, solicitud_id: request.id, mensaje: "Aprueba o rechaza la operacion en el panel local. Si la apruebas, repite exactamente la llamada incluyendo aprobacion_id." };
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], structuredContent: payload };
}

async function cleanupBackups(settings) {
  if (!settings.backupRetentionDays) return 0;
  await fs.mkdir(backupsRoot, { recursive: true });
  const cutoff = Date.now() - settings.backupRetentionDays * 86_400_000;
  let removed = 0;
  for (const entry of await fs.readdir(backupsRoot, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const metadataPath = path.join(backupsRoot, entry.name);
    try {
      const metadata = JSON.parse(await fs.readFile(metadataPath, "utf8"));
      const validated = validateBackupMetadata(metadata, backupBinding);
      if (Date.parse(metadata.createdAt) < cutoff) {
        await fs.rm(validated.backupPath, { force: true });
        await fs.rm(validated.metadataPath, { force: true });
        removed += 1;
      }
    } catch {}
  }
  return removed;
}

async function createBackup(filePath, relativePath, action, settings) {
  if (!settings.backupEnabled) return null;
  await cleanupBackups(settings);
  await fs.mkdir(backupsRoot, { recursive: true });
  const id = `${Date.now()}-${randomUUID()}`;
  const backupFile = `${id}.bin`;
  const metadata = {
    id,
    createdAt: new Date().toISOString(),
    profileId,
    workspaceFingerprint: workspaceId,
    action,
    originalPath: relativePath,
    backupFile,
    sha256: await sha256File(filePath),
    size: (await fs.stat(filePath)).size,
  };
  const backupPath = path.join(backupsRoot, backupFile);
  try {
    await atomicRestoreFromFile(filePath, backupPath, { expectedSourceHash: metadata.sha256 });
    await atomicWriteJsonFile(path.join(backupsRoot, `${id}.json`), metadata);
  } catch (error) {
    await fs.rm(backupPath, { force: true }).catch(() => {});
    throw error;
  }
  await audit("backup_created", relativePath, { backupId: id, action });
  return metadata;
}

async function listBackups() {
  try {
    const items = [];
    for (const entry of await fs.readdir(backupsRoot, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      try {
        const metadata = JSON.parse(await fs.readFile(path.join(backupsRoot, entry.name), "utf8"));
        validateBackupMetadata(metadata, backupBinding);
        items.push(metadata);
      } catch {}
    }
    return items.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  } catch { return []; }
}

async function toolError(error, action = "tool_error", relativePath = ".") {
  const message = error instanceof Error ? error.message : "Error desconocido.";
  await audit(action, relativePath, { result: "error", error: message }).catch(() => {});
  return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: message }, null, 2) }], structuredContent: { error: message } };
}

const server = new McpServer({ name: "pc-personal-seguro", version: "3.1.0" }, {
  instructions: "Servidor local limitado a un perfil autorizado. Respeta permisos temporales, bloquea secretos y enlaces, crea copias y registra operaciones. Si exige aprobacion local, pide que se conceda en el panel y repite con aprobacion_id. Nunca ejecutes comandos.",
});

server.registerTool("comprobar_estado_local", {
  title: "Comprobar estado local", description: "Devuelve estado, carpeta, permisos y protecciones activas.", inputSchema: {},
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async () => {
  const settings = await readSettings(settingsPath);
  const backups = await listBackups();
  const approvals = await readApprovals(approvalsPath);
  const payload = {
    conectado: true, servidor: "pc-personal-seguro", version: "3.1.0", sistema: os.platform(), arquitectura: os.arch(), node: process.version,
    perfil_id: profileId, espacio_huella: workspaceId,
    credencial_plano_control_presente: Boolean(process.env.CONTROL_PLANE_API_KEY || process.env.OPENAI_API_KEY || process.env.OPENAI_ADMIN_KEY),
    carpeta_trabajo: workspaceRoot, permisos: effectivePermissions(settings), permisos_caducan: settings.permissionExpiresAt,
    aprobacion_por_operacion: settings.approvalRequired, proteccion_sensible: settings.sensitiveProtection,
    copias_seguridad: { activas: settings.backupEnabled, retencion_dias: settings.backupRetentionDays, cantidad: backups.length },
    aprobaciones_pendientes: approvals.filter((item) => item.status === "pending").length, hora_utc: new Date().toISOString(),
  };
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], structuredContent: payload };
});

server.registerTool("listar_archivos", {
  title: "Listar archivos y carpetas", description: "Lista de forma no recursiva hasta 500 elementos autorizados.", inputSchema: { ruta: z.string().max(1000).optional() },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ ruta }) => {
  try {
    const settings = await requirePermission("read");
    const { realPath } = await resolveAuthorizedPath(ruta || ".", "directory", settings);
    const entries = (await fs.readdir(realPath, { withFileTypes: true }))
      .filter((entry) => !internalNames.has(entry.name.toLowerCase()) && !(settings.sensitiveProtection && isSensitiveRelativePath(relativeForDisplay(path.join(realPath, entry.name)))))
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name, "es"));
    const items = await Promise.all(entries.slice(0, maxListEntries).map(async (entry) => ({ nombre: entry.name, ruta_relativa: relativeForDisplay(path.join(realPath, entry.name)), tipo: entry.isSymbolicLink() ? "enlace_bloqueado" : entry.isDirectory() ? "carpeta" : entry.isFile() ? "archivo" : "otro", tamano_bytes: entry.isFile() ? (await fs.lstat(path.join(realPath, entry.name))).size : null })));
    const payload = { carpeta: relativeForDisplay(realPath), elementos: items, total_en_carpeta: entries.length, resultado_truncado: entries.length > maxListEntries };
    await audit("list", payload.carpeta, { count: items.length });
    return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], structuredContent: payload };
  } catch (error) { return toolError(error, "list_error", ruta || "."); }
});

server.registerTool("leer_archivo", {
  title: "Leer archivo", description: "Lee archivos autorizados por fragmentos de hasta 2 MiB. La huella completa puede omitirse para evitar recorrer archivos grandes.",
  inputSchema: { ruta: z.string().min(1).max(1000), formato: z.enum(["auto", "texto", "base64"]).optional(), offset_bytes: z.number().int().min(0).optional(), max_bytes: z.number().int().min(1).max(maxReadBytes).optional(), incluir_sha256: z.boolean().optional() },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ ruta, formato = "auto", offset_bytes = 0, max_bytes = 512 * 1024, incluir_sha256 = true }) => {
  let handle;
  try {
    const settings = await requirePermission("read");
    const { realPath, stats } = await resolveAuthorizedPath(ruta, "file", settings);
    if (offset_bytes > stats.size) throw new Error("El desplazamiento supera el tamano del archivo.");
    const length = Math.min(max_bytes, stats.size - offset_bytes);
    const buffer = Buffer.alloc(length);
    handle = await fs.open(realPath, "r");
    const { bytesRead } = await handle.read(buffer, 0, length, offset_bytes);
    const chunk = buffer.subarray(0, bytesRead);
    let outputFormat = formato;
    let content;
    if (formato !== "base64") {
      try { content = new TextDecoder("utf-8", { fatal: true }).decode(chunk); outputFormat = "texto"; }
      catch { if (formato === "texto") throw new Error("El fragmento no contiene texto UTF-8 valido."); }
    }
    if (content === undefined) { outputFormat = "base64"; content = chunk.toString("base64"); }
    const payload = { ruta_relativa: relativeForDisplay(realPath), formato: outputFormat, offset_bytes, bytes_devuelto: bytesRead, tamano_total_bytes: stats.size, hay_mas: offset_bytes + bytesRead < stats.size, sha256: incluir_sha256 ? await sha256File(realPath) : null, contenido: content };
    await audit("read", payload.ruta_relativa, { bytes: bytesRead, format: outputFormat });
    return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], structuredContent: payload };
  } catch (error) { return toolError(error, "read_error", ruta); } finally { await handle?.close(); }
});

server.registerTool("modificar_archivo", {
  title: "Crear o modificar archivo", description: "Crea o sobrescribe un archivo. La primera llamada puede generar una solicitud de aprobacion local.",
  inputSchema: { ruta: z.string().min(1).max(1000), contenido: z.string(), formato: z.enum(["texto", "base64"]).optional(), modo: z.enum(["crear", "sobrescribir"]), sha256_esperado: z.string().regex(/^[a-f0-9]{64}$/).optional(), confirmar: z.boolean().optional(), aprobacion_id: z.string().uuid().optional() },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
}, async ({ ruta, contenido, formato = "texto", modo, sha256_esperado, confirmar, aprobacion_id }) => {
  try {
    const settings = await requirePermission(modo === "crear" ? "create" : "modify");
    if (!settings.approvalRequired && confirmar !== true) throw new Error("El modo autonomo exige confirmar=true para cada escritura.");
    const encoded = decodeContent(contenido, formato);
    if (encoded.length > maxWriteBytes) throw new Error("El contenido supera 5 MiB.");
    let destination;
    let previousHash = null;
    let beforePreview = null;
    if (modo === "crear") destination = await resolveAuthorizedNewFile(ruta, settings);
    else {
      destination = (await resolveAuthorizedPath(ruta, "file", settings)).realPath;
      if (!sha256_esperado) throw new Error("Para sobrescribir proporciona el SHA-256 de leer_archivo.");
      previousHash = await sha256File(destination);
      if (previousHash !== sha256_esperado) throw new Error("El archivo cambio desde la ultima lectura.");
      beforePreview = await readBoundedPreview(destination);
    }
    const relative = relativeForDisplay(destination);
    const approval = await requireLocalApproval(settings, { action: modo, relativePath: relative, contentHash: hashBuffer(encoded), previousHash, preview: { before: beforePreview, after: bufferPreview(encoded), size: encoded.length } }, aprobacion_id);
    if (approval.pending) return approvalRequiredResult(approval.pending);
    if (modo === "crear") {
      destination = await resolveAuthorizedNewFile(ruta, settings);
    } else {
      destination = (await resolveAuthorizedPath(ruta, "file", settings)).realPath;
      if (await sha256File(destination) !== previousHash) throw new Error("El archivo cambio despues de la aprobacion local.");
    }
    const backup = modo === "sobrescribir" ? await createBackup(destination, relative, modo, settings) : null;
    await atomicWriteBuffer(destination, encoded, { createOnly: modo === "crear", expectedDestinationHash: previousHash });
    const payload = { modificado: true, operacion: modo, ruta_relativa: relative, tamano_bytes: encoded.length, sha256_anterior: previousHash, sha256_nuevo: hashBuffer(encoded), copia_seguridad_id: backup?.id ?? null, aprobacion: approval.autonomous ? "modo_autonomo" : approval.approvalId };
    await audit(modo, relative, { bytes: encoded.length, previousHash, newHash: payload.sha256_nuevo, backupId: backup?.id, approvalId: approval.approvalId, autonomous: approval.autonomous === true });
    return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], structuredContent: payload };
  } catch (error) { return toolError(error, "write_error", ruta); }
});

server.registerTool("eliminar_archivo", {
  title: "Eliminar archivo", description: "Mueve un archivo a la papelera recuperable y crea copia si esta activada.",
  inputSchema: { ruta: z.string().min(1).max(1000), sha256_esperado: z.string().regex(/^[a-f0-9]{64}$/), confirmar: z.boolean().optional(), aprobacion_id: z.string().uuid().optional() },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
}, async ({ ruta, sha256_esperado, confirmar, aprobacion_id }) => {
  try {
    const settings = await requirePermission("delete");
    if (!settings.approvalRequired && confirmar !== true) throw new Error("El modo autonomo exige confirmar=true para cada eliminacion.");
    let { realPath, stats } = await resolveAuthorizedPath(ruta, "file", settings);
    const relative = relativeForDisplay(realPath);
    const currentHash = await sha256File(realPath);
    if (currentHash !== sha256_esperado) throw new Error("El archivo cambio desde la ultima lectura.");
    const approval = await requireLocalApproval(settings, { action: "delete", relativePath: relative, contentHash: currentHash, preview: { before: await readBoundedPreview(realPath), size: stats.size, after: null } }, aprobacion_id);
    if (approval.pending) return approvalRequiredResult(approval.pending);
    ({ realPath, stats } = await resolveAuthorizedPath(ruta, "file", settings));
    if (await sha256File(realPath) !== currentHash) throw new Error("El archivo cambio despues de la aprobacion local.");
    const backup = await createBackup(realPath, relative, "delete", settings);
    const trashDirectory = path.join(workspaceRealRoot, trashName);
    await fs.mkdir(trashDirectory, { recursive: true });
    const trashPath = path.join(trashDirectory, `${Date.now()}-${randomUUID()}-${path.basename(realPath)}`);
    await fs.rename(realPath, trashPath);
    try {
      await atomicWriteJsonFile(`${trashPath}.json`, { originalPath: relative, trashFile: path.basename(trashPath), deletedAt: new Date().toISOString(), sha256: currentHash });
    } catch (error) {
      await fs.rename(trashPath, realPath).catch(() => {});
      throw error;
    }
    const payload = { eliminado: true, recuperable: true, ruta_original: relative, papelera_local: relativeForDisplay(trashPath), sha256: currentHash, copia_seguridad_id: backup?.id ?? null, aprobacion: approval.autonomous ? "modo_autonomo" : approval.approvalId };
    await audit("delete", relative, { trashPath: payload.papelera_local, backupId: backup?.id, approvalId: approval.approvalId, autonomous: approval.autonomous === true });
    return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], structuredContent: payload };
  } catch (error) { return toolError(error, "delete_error", ruta); }
});

server.registerTool("listar_copias_seguridad", {
  title: "Listar copias de seguridad", description: "Lista las copias recuperables existentes.", inputSchema: {},
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async () => {
  try {
    await requirePermission("read");
    const items = (await listBackups()).slice(0, 100);
    const payload = { copias: items, total: items.length };
    await audit("backup_list", ".", { count: items.length });
    return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], structuredContent: payload };
  } catch (error) { return toolError(error, "backup_list_error", "."); }
});

const transport = new StdioServerTransport();
await server.connect(transport);

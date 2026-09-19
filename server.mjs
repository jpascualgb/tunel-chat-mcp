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
import { assertSingleLinkFile, atomicRestoreFromFile, atomicWriteBuffer, atomicWriteJsonFile, bufferPreview, readBoundedPreview, sha256File } from "./safe-files.mjs";
import { copyTreeToNewPath, inspectTree, moveTreeToNewPath } from "./workspace-tree.mjs";
import { downloadChatGptImage } from "./chatgpt-files.mjs";

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
const maxTreeEntries = 10_000;
const maxTreeBytes = 512 * 1024 * 1024;

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

async function requirePermissions(...permissions) {
  const settings = await readSettings(settingsPath);
  const effective = effectivePermissions(settings);
  for (const permission of permissions) {
    if (effective[permission]) continue;
    const labels = { read: "lectura", create: "creacion", modify: "modificacion", delete: "eliminacion" };
    throw new Error(`El permiso de ${labels[permission]} esta desactivado o ha caducado.`);
  }
  return settings;
}

async function requirePermission(permission) { return requirePermissions(permission); }

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
  const logicalRoot = path.resolve(workspaceRoot);
  let relative = path.relative(logicalRoot, candidatePath);
  const outsideLogicalRoot = relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
  if (outsideLogicalRoot) relative = path.relative(workspaceRealRoot, candidatePath);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("La ruta solicitada queda fuera de la carpeta autorizada.");
  }
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
  if (expectedType === "file") assertSingleLinkFile(stats);
  return { realPath: realCandidate, stats };
}

async function resolveAuthorizedNewFile(requestedPath, settings) {
  return resolveAuthorizedNewEntry(requestedPath, settings, "archivo");
}

async function resolveAuthorizedNewEntry(requestedPath, settings, kind = "elemento") {
  const candidate = validateRelativeInput(requestedPath);
  assertNotSensitive(candidate, settings);
  if (candidate === path.resolve(workspaceRoot)) throw new Error(`Debes indicar el nombre de un ${kind} nuevo.`);
  await assertNoSymlinkComponents(candidate, false);
  const parent = path.dirname(candidate);
  if (!(await fs.lstat(parent)).isDirectory()) throw new Error("La carpeta de destino no existe.");
  const realParent = await fs.realpath(parent);
  if (!isInsideWorkspace(realParent)) throw new Error("La carpeta de destino queda fuera de la carpeta autorizada.");
  try { await fs.lstat(candidate); throw new Error("La ruta de destino ya existe."); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  return path.join(realParent, path.basename(candidate));
}

function requireAutonomousConfirmation(settings, confirmar, action) {
  if (!settings.approvalRequired && confirmar !== true) throw new Error(`El modo autonomo exige confirmar=true para cada ${action}.`);
}

function treeOptions(settings) {
  return {
    maxEntries: maxTreeEntries,
    maxBytes: maxTreeBytes,
    validatePath: async (candidatePath) => assertNotSensitive(candidatePath, settings),
  };
}

function treePreview(snapshot, destination = null) {
  return {
    tipo: snapshot.kind === "directory" ? "carpeta" : "archivo",
    archivos: snapshot.fileCount,
    carpetas: snapshot.directoryCount,
    tamano_bytes: snapshot.totalBytes,
    elementos: snapshot.entries,
    destino: destination,
  };
}

async function ensureTrashDirectory() {
  const trashDirectory = path.join(workspaceRealRoot, trashName);
  await fs.mkdir(trashDirectory, { recursive: true });
  const stats = await fs.lstat(trashDirectory);
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error("La papelera local protegida no es una carpeta valida.");
  const realTrash = await fs.realpath(trashDirectory);
  if (!isInsideWorkspace(realTrash)) throw new Error("La papelera local queda fuera de la carpeta autorizada.");
  return realTrash;
}

function imageDestination(requestedPath, extension) {
  validateRelativeInput(requestedPath);
  const currentExtension = path.extname(requestedPath).toLowerCase();
  if (!currentExtension) return `${requestedPath}${extension}`;
  const compatible = extension === ".jpg" ? [".jpg", ".jpeg"] : [extension];
  if (!compatible.includes(currentExtension)) throw new Error(`La extension de destino debe ser ${compatible.join(" o ")}.`);
  return requestedPath;
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

const server = new McpServer({ name: "pc-personal-seguro", version: "3.2.1" }, {
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
    conectado: true, servidor: "pc-personal-seguro", version: "3.2.1", sistema: os.platform(), arquitectura: os.arch(), node: process.version,
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
    assertSingleLinkFile(await handle.stat());
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
    requireAutonomousConfirmation(settings, confirmar, "escritura");
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
    requireAutonomousConfirmation(settings, confirmar, "eliminacion");
    let { realPath, stats } = await resolveAuthorizedPath(ruta, "file", settings);
    const relative = relativeForDisplay(realPath);
    const currentHash = await sha256File(realPath);
    if (currentHash !== sha256_esperado) throw new Error("El archivo cambio desde la ultima lectura.");
    const approval = await requireLocalApproval(settings, { action: "delete", relativePath: relative, contentHash: currentHash, preview: { before: await readBoundedPreview(realPath), size: stats.size, after: null } }, aprobacion_id);
    if (approval.pending) return approvalRequiredResult(approval.pending);
    ({ realPath, stats } = await resolveAuthorizedPath(ruta, "file", settings));
    if (await sha256File(realPath) !== currentHash) throw new Error("El archivo cambio despues de la aprobacion local.");
    const backup = await createBackup(realPath, relative, "delete", settings);
    const trashDirectory = await ensureTrashDirectory();
    const trashPath = path.join(trashDirectory, `${Date.now()}-${randomUUID()}-${path.basename(realPath)}`);
    await fs.rename(realPath, trashPath);
    try {
      if (await sha256File(trashPath) !== currentHash) throw new Error("El archivo cambio durante el movimiento a la papelera.");
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

server.registerTool("crear_carpeta", {
  title: "Crear carpeta", description: "Crea una carpeta nueva dentro del espacio autorizado. No sobrescribe rutas existentes.",
  inputSchema: { ruta: z.string().min(1).max(1000), confirmar: z.boolean().optional(), aprobacion_id: z.string().uuid().optional() },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, async ({ ruta, confirmar, aprobacion_id }) => {
  try {
    const settings = await requirePermission("create");
    requireAutonomousConfirmation(settings, confirmar, "creacion de carpeta");
    let destination = await resolveAuthorizedNewEntry(ruta, settings, "carpeta");
    const relative = relativeForDisplay(destination);
    const contentHash = hashBuffer(Buffer.from(`directory\0${relative}`, "utf8"));
    const approval = await requireLocalApproval(settings, {
      action: "create_directory", relativePath: relative, contentHash,
      preview: { tipo: "carpeta", destino: relative, after: "carpeta nueva" },
    }, aprobacion_id);
    if (approval.pending) return approvalRequiredResult(approval.pending);
    destination = await resolveAuthorizedNewEntry(ruta, settings, "carpeta");
    await fs.mkdir(destination);
    const payload = { creado: true, tipo: "carpeta", ruta_relativa: relative, aprobacion: approval.autonomous ? "modo_autonomo" : approval.approvalId };
    await audit("create_directory", relative, { approvalId: approval.approvalId, autonomous: approval.autonomous === true });
    return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], structuredContent: payload };
  } catch (error) { return toolError(error, "create_directory_error", ruta); }
});

server.registerTool("copiar_elemento", {
  title: "Copiar archivo o carpeta", description: "Copia un archivo o una carpeta completa a una ruta nueva, verificando limites, enlaces e integridad.",
  inputSchema: { origen: z.string().min(1).max(1000), destino: z.string().min(1).max(1000), confirmar: z.boolean().optional(), aprobacion_id: z.string().uuid().optional() },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, async ({ origen, destino, confirmar, aprobacion_id }) => {
  try {
    const settings = await requirePermissions("read", "create");
    requireAutonomousConfirmation(settings, confirmar, "copia");
    let source = (await resolveAuthorizedPath(origen, "entry", settings)).realPath;
    let destination = await resolveAuthorizedNewEntry(destino, settings);
    const sourceRelative = relativeForDisplay(source);
    const destinationRelative = relativeForDisplay(destination);
    const options = treeOptions(settings);
    const snapshot = await inspectTree(source, options);
    const approval = await requireLocalApproval(settings, {
      action: "copy", relativePath: `${sourceRelative} -> ${destinationRelative}`, contentHash: snapshot.fingerprint,
      preview: treePreview(snapshot, destinationRelative),
    }, aprobacion_id);
    if (approval.pending) return approvalRequiredResult(approval.pending);
    source = (await resolveAuthorizedPath(origen, "entry", settings)).realPath;
    destination = await resolveAuthorizedNewEntry(destino, settings);
    await copyTreeToNewPath(source, destination, snapshot.fingerprint, options);
    const payload = {
      copiado: true, origen: sourceRelative, destino: destinationRelative,
      tipo: snapshot.kind === "directory" ? "carpeta" : "archivo", archivos: snapshot.fileCount,
      carpetas: snapshot.directoryCount, tamano_bytes: snapshot.totalBytes,
      aprobacion: approval.autonomous ? "modo_autonomo" : approval.approvalId,
    };
    await audit("copy", sourceRelative, { destination: destinationRelative, fingerprint: snapshot.fingerprint, files: snapshot.fileCount, directories: snapshot.directoryCount, bytes: snapshot.totalBytes, approvalId: approval.approvalId, autonomous: approval.autonomous === true });
    return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], structuredContent: payload };
  } catch (error) { return toolError(error, "copy_error", `${origen} -> ${destino}`); }
});

server.registerTool("mover_elemento", {
  title: "Mover o renombrar archivo o carpeta", description: "Mueve un elemento a una ruta nueva. Sirve para cortar y pegar o para renombrar.",
  inputSchema: { origen: z.string().min(1).max(1000), destino: z.string().min(1).max(1000), confirmar: z.boolean().optional(), aprobacion_id: z.string().uuid().optional() },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
}, async ({ origen, destino, confirmar, aprobacion_id }) => {
  try {
    const settings = await requirePermissions("modify", "create");
    requireAutonomousConfirmation(settings, confirmar, "movimiento");
    let source = (await resolveAuthorizedPath(origen, "entry", settings)).realPath;
    if (source === workspaceRealRoot) throw new Error("No se puede mover la carpeta autorizada completa.");
    let destination = await resolveAuthorizedNewEntry(destino, settings);
    const sourceRelative = relativeForDisplay(source);
    const destinationRelative = relativeForDisplay(destination);
    const options = treeOptions(settings);
    const snapshot = await inspectTree(source, options);
    const approval = await requireLocalApproval(settings, {
      action: "move", relativePath: `${sourceRelative} -> ${destinationRelative}`, contentHash: snapshot.fingerprint,
      preview: treePreview(snapshot, destinationRelative),
    }, aprobacion_id);
    if (approval.pending) return approvalRequiredResult(approval.pending);
    source = (await resolveAuthorizedPath(origen, "entry", settings)).realPath;
    destination = await resolveAuthorizedNewEntry(destino, settings);
    await moveTreeToNewPath(source, destination, snapshot.fingerprint, options);
    const payload = {
      movido: true, origen: sourceRelative, destino: destinationRelative,
      tipo: snapshot.kind === "directory" ? "carpeta" : "archivo", archivos: snapshot.fileCount,
      carpetas: snapshot.directoryCount, tamano_bytes: snapshot.totalBytes,
      aprobacion: approval.autonomous ? "modo_autonomo" : approval.approvalId,
    };
    await audit("move", sourceRelative, { destination: destinationRelative, fingerprint: snapshot.fingerprint, files: snapshot.fileCount, directories: snapshot.directoryCount, bytes: snapshot.totalBytes, approvalId: approval.approvalId, autonomous: approval.autonomous === true });
    return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], structuredContent: payload };
  } catch (error) { return toolError(error, "move_error", `${origen} -> ${destino}`); }
});

server.registerTool("eliminar_carpeta", {
  title: "Eliminar carpeta", description: "Mueve una carpeta completa a la papelera local recuperable tras verificar todo su contenido.",
  inputSchema: { ruta: z.string().min(1).max(1000), confirmar: z.boolean().optional(), aprobacion_id: z.string().uuid().optional() },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
}, async ({ ruta, confirmar, aprobacion_id }) => {
  try {
    const settings = await requirePermission("delete");
    requireAutonomousConfirmation(settings, confirmar, "eliminacion de carpeta");
    let directory = (await resolveAuthorizedPath(ruta, "directory", settings)).realPath;
    if (directory === workspaceRealRoot) throw new Error("No se puede eliminar la carpeta autorizada completa.");
    const relative = relativeForDisplay(directory);
    const options = treeOptions(settings);
    const snapshot = await inspectTree(directory, options);
    const approval = await requireLocalApproval(settings, {
      action: "delete_directory", relativePath: relative, contentHash: snapshot.fingerprint,
      preview: { ...treePreview(snapshot), after: null },
    }, aprobacion_id);
    if (approval.pending) return approvalRequiredResult(approval.pending);
    directory = (await resolveAuthorizedPath(ruta, "directory", settings)).realPath;
    const current = await inspectTree(directory, options);
    if (current.fingerprint !== snapshot.fingerprint) throw new Error("La carpeta cambio despues de la aprobacion local.");
    const trashDirectory = await ensureTrashDirectory();
    const trashPath = path.join(trashDirectory, `${Date.now()}-${randomUUID()}-${path.basename(directory)}`);
    await fs.rename(directory, trashPath);
    try {
      const moved = await inspectTree(trashPath, { maxEntries: maxTreeEntries, maxBytes: maxTreeBytes });
      if (moved.fingerprint !== snapshot.fingerprint) throw new Error("La carpeta cambio durante el movimiento a la papelera.");
      await atomicWriteJsonFile(`${trashPath}.json`, {
        tipo: "carpeta", originalPath: relative, trashFile: path.basename(trashPath), deletedAt: new Date().toISOString(),
        fingerprint: snapshot.fingerprint, files: snapshot.fileCount, directories: snapshot.directoryCount, size: snapshot.totalBytes,
      });
    } catch (error) {
      await fs.rename(trashPath, directory).catch(() => {});
      throw error;
    }
    const payload = {
      eliminado: true, recuperable: true, tipo: "carpeta", ruta_original: relative,
      papelera_local: relativeForDisplay(trashPath), archivos: snapshot.fileCount,
      carpetas: snapshot.directoryCount, tamano_bytes: snapshot.totalBytes,
      aprobacion: approval.autonomous ? "modo_autonomo" : approval.approvalId,
    };
    await audit("delete_directory", relative, { trashPath: payload.papelera_local, fingerprint: snapshot.fingerprint, files: snapshot.fileCount, directories: snapshot.directoryCount, bytes: snapshot.totalBytes, approvalId: approval.approvalId, autonomous: approval.autonomous === true });
    return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], structuredContent: payload };
  } catch (error) { return toolError(error, "delete_directory_error", ruta); }
});

server.registerTool("guardar_imagen_chatgpt", {
  title: "Guardar imagen de ChatGPT", description: "Descarga de forma segura una imagen PNG, JPEG o WebP recibida por ChatGPT y la crea dentro de la carpeta autorizada.",
  inputSchema: {
    imagen: z.object({
      download_url: z.string().min(1).max(8192), file_id: z.string().min(1).max(1000),
      mime_type: z.string().max(255).optional(), file_name: z.string().max(1000).optional(),
    }).strict(),
    ruta_destino: z.string().min(1).max(1000), confirmar: z.boolean().optional(), aprobacion_id: z.string().uuid().optional(),
  },
  _meta: { "openai/fileParams": ["imagen"] },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
}, async ({ imagen, ruta_destino, confirmar, aprobacion_id }) => {
  try {
    const settings = await requirePermission("create");
    requireAutonomousConfirmation(settings, confirmar, "guardado de imagen");
    validateRelativeInput(ruta_destino);
    const downloaded = await downloadChatGptImage(imagen);
    const finalRequestedPath = imageDestination(ruta_destino, downloaded.extension);
    let destination = await resolveAuthorizedNewFile(finalRequestedPath, settings);
    const relative = relativeForDisplay(destination);
    const approval = await requireLocalApproval(settings, {
      action: "save_chatgpt_image", relativePath: relative, contentHash: downloaded.sha256,
      preview: { tipo: "imagen", mime_type: downloaded.mimeType, tamano_bytes: downloaded.size, sha256: downloaded.sha256, destino: relative, archivo_origen: downloaded.sourceFileName },
    }, aprobacion_id);
    if (approval.pending) return approvalRequiredResult(approval.pending);
    destination = await resolveAuthorizedNewFile(finalRequestedPath, settings);
    await atomicWriteBuffer(destination, downloaded.buffer, { createOnly: true });
    const payload = {
      guardada: true, ruta_relativa: relative, mime_type: downloaded.mimeType,
      tamano_bytes: downloaded.size, sha256: downloaded.sha256, file_id_origen: downloaded.sourceFileId,
      aprobacion: approval.autonomous ? "modo_autonomo" : approval.approvalId,
    };
    await audit("save_chatgpt_image", relative, { mimeType: downloaded.mimeType, bytes: downloaded.size, sha256: downloaded.sha256, sourceFileId: downloaded.sourceFileId, approvalId: approval.approvalId, autonomous: approval.autonomous === true });
    return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], structuredContent: payload };
  } catch (error) { return toolError(error, "save_chatgpt_image_error", ruta_destino); }
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

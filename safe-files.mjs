import fs from "node:fs/promises";
import { constants as fsConstants, createReadStream } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { validateSafeRelativePath } from "./secure-store.mjs";

export const previewReadBytes = 16 * 1024;
export const previewTextCharacters = 4000;

export async function sha256File(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

export async function atomicWriteJsonFile(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await fs.link(temporaryPath, filePath);
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
  }
}

export function bufferPreview(buffer, totalBytes = buffer.length) {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    return {
      format: "text",
      content: text.slice(0, previewTextCharacters),
      truncated: totalBytes > buffer.length || text.length > previewTextCharacters,
      totalBytes,
    };
  } catch {
    return { format: "binary", content: `${totalBytes} bytes`, truncated: totalBytes > buffer.length, totalBytes };
  }
}

export async function readBoundedPreview(filePath) {
  const handle = await fs.open(filePath, "r");
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new Error("La vista previa solo admite archivos normales.");
    const buffer = Buffer.alloc(Math.min(previewReadBytes, stats.size));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return bufferPreview(buffer.subarray(0, bytesRead), stats.size);
  } finally {
    await handle.close();
  }
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function assertNoLinkComponents(root, candidate, includeFinal) {
  const relative = path.relative(root, candidate);
  const parts = relative === "" ? [] : relative.split(path.sep);
  let current = root;
  for (const part of (includeFinal ? parts : parts.slice(0, -1))) {
    current = path.join(current, part);
    const stats = await fs.lstat(current);
    if (stats.isSymbolicLink()) throw new Error("No se permite acceder mediante enlaces simbolicos o uniones.");
  }
}

function workspaceCandidate(root, requestedPath) {
  const input = validateSafeRelativePath(requestedPath);
  const candidate = path.resolve(root, input);
  if (!isInside(root, candidate)) throw new Error("La ruta solicitada queda fuera de la carpeta autorizada.");
  return candidate;
}

export async function resolveExistingWorkspaceFile(workspaceRoot, requestedPath) {
  const root = await fs.realpath(workspaceRoot);
  const candidate = workspaceCandidate(root, requestedPath);
  await assertNoLinkComponents(root, candidate, true);
  const stats = await fs.lstat(candidate);
  if (!stats.isFile()) throw new Error("La ruta indicada no es un archivo normal.");
  const realPath = await fs.realpath(candidate);
  if (!isInside(root, realPath)) throw new Error("La ruta resuelta queda fuera de la carpeta autorizada.");
  return { realPath, stats, relativePath: path.relative(root, realPath).split(path.sep).join("/") };
}

export async function resolveNewWorkspaceFile(workspaceRoot, requestedPath) {
  const root = await fs.realpath(workspaceRoot);
  const candidate = workspaceCandidate(root, requestedPath);
  if (candidate === root) throw new Error("Debes indicar el nombre de un archivo nuevo.");
  await assertNoLinkComponents(root, candidate, false);
  const parent = path.dirname(candidate);
  const parentStats = await fs.lstat(parent);
  if (!parentStats.isDirectory()) throw new Error("La carpeta de destino no existe.");
  const realParent = await fs.realpath(parent);
  if (!isInside(root, realParent)) throw new Error("La carpeta de destino queda fuera de la carpeta autorizada.");
  try {
    await fs.lstat(candidate);
    throw new Error("Ya existe un archivo en la ruta de destino.");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return path.join(realParent, path.basename(candidate));
}

export async function atomicRestoreFromFile(sourcePath, destinationPath, options = {}) {
  const expectedSourceHash = options.expectedSourceHash;
  const expectedDestinationHash = options.expectedDestinationHash ?? null;
  const temporaryPath = path.join(path.dirname(destinationPath), `.${path.basename(destinationPath)}.${randomUUID()}.tmp`);
  try {
    await fs.copyFile(sourcePath, temporaryPath, fsConstants.COPYFILE_EXCL);
    if (expectedSourceHash && await sha256File(temporaryPath) !== expectedSourceHash) {
      throw new Error("La copia temporal no supera la verificacion de integridad.");
    }
    if (expectedDestinationHash === null) {
      await fs.link(temporaryPath, destinationPath);
      return;
    }
    const destinationStats = await fs.lstat(destinationPath);
    if (!destinationStats.isFile() || destinationStats.isSymbolicLink()) {
      throw new Error("El destino de restauracion no es un archivo normal.");
    }
    if (await sha256File(destinationPath) !== expectedDestinationHash) {
      const error = new Error("El archivo de destino cambio antes de la restauracion.");
      error.code = "STATE_CONFLICT";
      throw error;
    }
    await fs.chmod(temporaryPath, destinationStats.mode).catch(() => {});
    await fs.rename(temporaryPath, destinationPath);
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
  }
}

export async function atomicWriteBuffer(destinationPath, buffer, options = {}) {
  if (options.createOnly === true) {
    const temporaryPath = path.join(path.dirname(destinationPath), `.${path.basename(destinationPath)}.${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporaryPath, buffer, { flag: "wx" });
      await fs.link(temporaryPath, destinationPath);
    } finally {
      await fs.rm(temporaryPath, { force: true }).catch(() => {});
    }
    return;
  }
  const expectedDestinationHash = options.expectedDestinationHash;
  if (!/^[a-f0-9]{64}$/.test(expectedDestinationHash || "")) {
    throw new Error("La escritura atomica requiere la huella actual del destino.");
  }
  const temporaryPath = path.join(path.dirname(destinationPath), `.${path.basename(destinationPath)}.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporaryPath, buffer, { flag: "wx" });
    const destinationStats = await fs.lstat(destinationPath);
    if (!destinationStats.isFile() || destinationStats.isSymbolicLink()) throw new Error("El destino no es un archivo normal.");
    if (await sha256File(destinationPath) !== expectedDestinationHash) {
      const error = new Error("El archivo cambio antes de la escritura.");
      error.code = "STATE_CONFLICT";
      throw error;
    }
    await fs.chmod(temporaryPath, destinationStats.mode).catch(() => {});
    await fs.rename(temporaryPath, destinationPath);
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
  }
}

export async function atomicMoveToNewPath(sourcePath, destinationPath, expectedHash = null) {
  const sourceStats = await fs.lstat(sourcePath);
  if (!sourceStats.isFile() || sourceStats.isSymbolicLink()) throw new Error("El origen recuperable no es un archivo normal.");
  if (expectedHash && await sha256File(sourcePath) !== expectedHash) throw new Error("El origen recuperable no supera la verificacion de integridad.");
  await fs.link(sourcePath, destinationPath);
  try {
    if (expectedHash && await sha256File(destinationPath) !== expectedHash) throw new Error("El archivo restaurado no supera la verificacion de integridad.");
    await fs.unlink(sourcePath);
  } catch (error) {
    await fs.rm(destinationPath, { force: true }).catch(() => {});
    throw error;
  }
}

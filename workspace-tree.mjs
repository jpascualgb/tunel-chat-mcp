import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { assertSingleLinkFile, atomicRestoreFromFile, sha256File } from "./safe-files.mjs";

const defaultMaxEntries = 10_000;
const defaultMaxBytes = 512 * 1024 * 1024;

function fingerprintManifest(manifest) {
  return createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
}

function relativeName(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" ? "." : relative.split(path.sep).join("/");
}

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function assertDestinationDoesNotExist(destinationPath) {
  try {
    await fs.lstat(destinationPath);
    throw new Error("La ruta de destino ya existe.");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

export async function inspectTree(sourcePath, options = {}) {
  const maxEntries = options.maxEntries ?? defaultMaxEntries;
  const maxBytes = options.maxBytes ?? defaultMaxBytes;
  const validatePath = options.validatePath ?? (async () => {});
  const root = path.resolve(sourcePath);
  const manifest = [];
  let fileCount = 0;
  let directoryCount = 0;
  let totalBytes = 0;

  async function visit(candidatePath) {
    await validatePath(candidatePath);
    const stats = await fs.lstat(candidatePath);
    const name = relativeName(root, candidatePath);
    if (stats.isSymbolicLink()) throw new Error("No se permiten enlaces simbolicos o uniones dentro del arbol.");
    if (manifest.length >= maxEntries) throw new Error(`El arbol supera el limite de ${maxEntries} elementos.`);

    if (stats.isDirectory()) {
      manifest.push({ path: name, type: "directory" });
      directoryCount += 1;
      const entries = await fs.readdir(candidatePath, { withFileTypes: true });
      entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
      for (const entry of entries) await visit(path.join(candidatePath, entry.name));
      return;
    }

    assertSingleLinkFile(stats);
    totalBytes += stats.size;
    if (totalBytes > maxBytes) throw new Error(`El tamano total del arbol supera el limite de ${maxBytes} bytes.`);
    const sha256 = await sha256File(candidatePath);
    const finalStats = await fs.lstat(candidatePath);
    assertSingleLinkFile(finalStats);
    if (finalStats.size !== stats.size || finalStats.mtimeMs !== stats.mtimeMs) {
      throw new Error("Un archivo cambio mientras se calculaba la huella del arbol.");
    }
    manifest.push({ path: name, type: "file", size: stats.size, sha256 });
    fileCount += 1;
  }

  await visit(root);
  return {
    kind: manifest[0]?.type,
    fileCount,
    directoryCount,
    totalBytes,
    entries: manifest.length,
    fingerprint: fingerprintManifest(manifest),
    manifest,
  };
}

export async function copyTreeToNewPath(sourcePath, destinationPath, expectedFingerprint, options = {}) {
  const source = path.resolve(sourcePath);
  const destination = path.resolve(destinationPath);
  if (source === destination || isInside(source, destination)) {
    throw new Error("No se puede copiar un elemento dentro de si mismo.");
  }
  await assertDestinationDoesNotExist(destination);
  const snapshot = await inspectTree(source, options);
  if (snapshot.fingerprint !== expectedFingerprint) throw new Error("El estado del origen cambio desde que se solicito la operacion.");

  let destinationCreated = false;
  try {
    if (snapshot.kind === "file") {
      await atomicRestoreFromFile(source, destination, { expectedSourceHash: snapshot.manifest[0].sha256 });
      destinationCreated = true;
    } else {
      await fs.mkdir(destination);
      destinationCreated = true;
      for (const entry of snapshot.manifest.slice(1)) {
        const target = path.join(destination, ...entry.path.split("/"));
        if (entry.type === "directory") await fs.mkdir(target);
        else await atomicRestoreFromFile(path.join(source, ...entry.path.split("/")), target, { expectedSourceHash: entry.sha256 });
      }
    }
    const copied = await inspectTree(destination, options);
    if (copied.fingerprint !== snapshot.fingerprint) throw new Error("La copia no supera la verificacion de integridad.");
    return copied;
  } catch (error) {
    if (destinationCreated) await fs.rm(destination, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export async function moveTreeToNewPath(sourcePath, destinationPath, expectedFingerprint, options = {}) {
  const source = path.resolve(sourcePath);
  const destination = path.resolve(destinationPath);
  if (source === destination || isInside(source, destination)) {
    throw new Error("No se puede mover un elemento dentro de si mismo.");
  }
  await assertDestinationDoesNotExist(destination);
  const snapshot = await inspectTree(source, options);
  if (snapshot.fingerprint !== expectedFingerprint) throw new Error("El estado del origen cambio desde que se solicito la operacion.");
  await fs.rename(source, destination);
  try {
    const moved = await inspectTree(destination, options);
    if (moved.fingerprint !== snapshot.fingerprint) throw new Error("El elemento cambio durante el movimiento.");
    return moved;
  } catch (error) {
    try { await fs.rename(destination, source); }
    catch { throw new Error("El movimiento no supero la verificacion y no pudo revertirse de forma automatica.", { cause: error }); }
    throw error;
  }
}

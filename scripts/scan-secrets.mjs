import { execFileSync } from "node:child_process";
import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const defaultProjectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ignoredDirectories = new Set([".git", "node_modules", "vendor"]);
const ignoredFiles = new Set(["scripts/scan-secrets.mjs"]);
const forbiddenPaths = /(^|\/)(\.env(?:\..*)?|control-plane-key\.xml|[^/]+\.(?:pem|p12|pfx|key))$/i;
const secretPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bsk-(?!example_|test_|redacted|placeholder)[A-Za-z0-9_-]{20,}\b/,
  /\btunnel_(?!ID\b)[A-Za-z0-9]{16,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
];
const maximumContentBytes = 2 * 1024 * 1024;

function normalizedPath(relativePath) {
  return relativePath.replaceAll("\\", "/");
}

function inspectPath(findings, relativePath, source) {
  const normalized = normalizedPath(relativePath);
  if (ignoredFiles.has(normalized)) return false;
  if (forbiddenPaths.test(normalized)) findings.add(`${source}: archivo sensible versionado (${normalized})`);
  return true;
}

function inspectContent(findings, relativePath, content, source) {
  if (!inspectPath(findings, relativePath, source) || content.includes("\0")) return;
  for (const pattern of secretPatterns) {
    if (pattern.test(content)) findings.add(`${source}: posible secreto en ${normalizedPath(relativePath)}`);
  }
}

async function readBoundedRegularFile(filePath) {
  const noFollow = process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW;
  const handle = await fs.open(filePath, fsConstants.O_RDONLY | noFollow);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(maximumContentBytes)) return null;
    const buffer = Buffer.alloc(Number(before.size) + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || offset !== Number(after.size)) {
      throw new Error("El archivo cambio durante el escaneo.");
    }
    return buffer.subarray(0, offset).toString("utf8");
  } finally {
    await handle.close();
  }
}

export async function scanWorkingTree(projectRoot = defaultProjectRoot) {
  const findings = new Set();
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(entryPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const relativePath = path.relative(projectRoot, entryPath);
      if (!inspectPath(findings, relativePath, "estado actual")) continue;
      try {
        const content = await readBoundedRegularFile(entryPath);
        if (content !== null) inspectContent(findings, relativePath, content, "estado actual");
      } catch {
        findings.add(`estado actual: no se pudo inspeccionar ${normalizedPath(relativePath)}`);
      }
    }
  }
  await visit(projectRoot);
  return findings;
}

export function scanGitHistory(projectRoot = defaultProjectRoot, findings = new Set()) {
  let commits;
  try {
    commits = execFileSync("git", ["rev-list", "--all"], { cwd: projectRoot, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })
      .split(/\r?\n/)
      .filter(Boolean);
  } catch {
    findings.add("historial: no se pudo leer el historial Git");
    return findings;
  }
  const seen = new Set();
  for (const commit of commits) {
    let tree;
    try {
      tree = execFileSync("git", ["ls-tree", "-r", "-z", "--long", commit], { cwd: projectRoot, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
    } catch {
      findings.add(`historial: no se pudo inspeccionar el commit ${commit}`);
      continue;
    }
    for (const entry of tree.split("\0").filter(Boolean)) {
      const separator = entry.indexOf("\t");
      if (separator < 1) continue;
      const [mode, type, hash, sizeValue] = entry.slice(0, separator).trim().split(/\s+/);
      const relativePath = normalizedPath(entry.slice(separator + 1));
      if (ignoredFiles.has(relativePath) || relativePath.startsWith("node_modules/")) continue;
      if (relativePath.startsWith("vendor/")) {
        findings.add(`historial: archivo privado o de terceros versionado (${relativePath})`);
        continue;
      }
      inspectPath(findings, relativePath, "historial");
      if (type !== "blob" || seen.has(hash)) continue;
      seen.add(hash);
      if (Number(sizeValue) > maximumContentBytes) continue;
      try {
        const content = execFileSync("git", ["cat-file", "-p", hash], { cwd: projectRoot, encoding: "utf8", maxBuffer: 3 * 1024 * 1024 });
        inspectContent(findings, relativePath, content, "historial");
      } catch {
        findings.add(`historial: no se pudo inspeccionar ${relativePath}`);
      }
    }
  }
  return findings;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const findings = scanGitHistory(defaultProjectRoot, await scanWorkingTree(defaultProjectRoot));
  if (findings.size) {
    process.stderr.write(`${[...findings].sort().join("\n")}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write("No se detectaron credenciales ni archivos sensibles en el arbol o el historial Git.\n");
  }
}

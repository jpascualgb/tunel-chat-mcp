import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ignoredDirectories = new Set([".git", "node_modules", "vendor"]);
const sourceFiles = [];

async function visit(directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) await visit(entryPath);
    else if (entry.isFile() && (entry.name.endsWith(".mjs") || entry.name.endsWith(".js"))) sourceFiles.push(entryPath);
  }
}

await visit(projectRoot);
const failures = [];
for (const filePath of sourceFiles.sort()) {
  const result = spawnSync(process.execPath, ["--check", filePath], { encoding: "utf8" });
  if (result.status !== 0) failures.push(`${path.relative(projectRoot, filePath)}: ${result.stderr.trim()}`);
}
if (failures.length) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`${sourceFiles.length} archivos JavaScript superaron la comprobacion sintactica.\n`);
}

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { scanGitHistory, scanWorkingTree } from "./scripts/scan-secrets.mjs";

const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "secure-mcp-secret-scan-"));
try {
  const largeSensitivePath = path.join(temporaryRoot, ".env.large");
  const handle = await fs.open(largeSensitivePath, "w");
  await handle.truncate(3 * 1024 * 1024);
  await handle.close();
  await fs.writeFile(path.join(temporaryRoot, "package-lock.json"), `{"value":"${"sk-" + "a".repeat(32)}"}`, "utf8");

  const findings = await scanWorkingTree(temporaryRoot);
  assert.ok([...findings].some((finding) => finding.includes(".env.large")), "Un archivo sensible grande no fue detectado.");
  assert.ok([...findings].some((finding) => finding.includes("package-lock.json")), "El archivo de bloqueo no fue inspeccionado.");

  const historyRoot = path.join(temporaryRoot, "history");
  await fs.mkdir(historyRoot);
  await fs.writeFile(path.join(historyRoot, "a.txt"), "contenido duplicado", "utf8");
  await fs.writeFile(path.join(historyRoot, "z.key"), "contenido duplicado", "utf8");
  await fs.mkdir(path.join(historyRoot, "vendor"));
  await fs.writeFile(path.join(historyRoot, "vendor", "tunnel-client.exe"), "binario privado", "utf8");
  execFileSync("git", ["init", "--quiet"], { cwd: historyRoot });
  execFileSync("git", ["add", "a.txt", "z.key", "vendor/tunnel-client.exe"], { cwd: historyRoot });
  execFileSync("git", ["-c", "user.name=Security Test", "-c", "user.email=security-test@example.invalid", "commit", "--quiet", "-m", "test"], { cwd: historyRoot });
  const historyFindings = scanGitHistory(historyRoot);
  assert.ok([...historyFindings].some((finding) => finding.includes("z.key")), "Un nombre sensible con contenido duplicado no fue detectado en el historial.");
  assert.ok([...historyFindings].some((finding) => finding.includes("vendor/tunnel-client.exe")), "Un binario privado de vendor no fue detectado en el historial.");
} finally {
  await fs.rm(temporaryRoot, { recursive: true, force: true });
}

console.log("Escaner verificado: examina archivos sensibles grandes y el archivo de bloqueo.");

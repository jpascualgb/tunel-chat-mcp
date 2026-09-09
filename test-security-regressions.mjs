import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { appendActivity, normalizePathForIdentity, readApprovals, readProfiles, readSettings, verifyAuditChain } from "./secure-store.mjs";
import { atomicWriteBuffer, readBoundedPreview, resolveNewWorkspaceFile } from "./safe-files.mjs";

const temporaryBase = await fs.mkdtemp(path.join(os.tmpdir(), "secure-mcp-regressions-"));

try {
  assert.notEqual(
    normalizePathForIdentity("/srv/CaseSensitive", "linux"),
    normalizePathForIdentity("/srv/casesensitive", "linux"),
    "Los perfiles de sistemas sensibles a mayusculas no deben compartir identidad.",
  );
  const corruptSettingsPath = path.join(temporaryBase, "settings.json");
  await fs.writeFile(corruptSettingsPath, "{not-json", "utf8");
  await assert.rejects(
    readSettings(corruptSettingsPath),
    /configuracion de seguridad/i,
    "Una configuracion corrupta no debe reactivar permisos predeterminados.",
  );

  const corruptProfilesPath = path.join(temporaryBase, "profiles.json");
  await fs.writeFile(corruptProfilesPath, "{not-json", "utf8");
  await assert.rejects(
    readProfiles(corruptProfilesPath, path.join(temporaryBase, "fallback")),
    /configuracion de perfiles/i,
    "Una configuracion corrupta no debe recuperar silenciosamente otro espacio.",
  );

  const approvalsPath = path.join(temporaryBase, "approvals.json");
  await fs.writeFile(approvalsPath, JSON.stringify({ requests: [{ id: '\"><img src=x onerror=alert(1)>', status: "pending", createdAt: new Date().toISOString() }] }), "utf8");
  assert.deepEqual(await readApprovals(approvalsPath), [], "Una aprobacion con identificador no valido no debe llegar al panel.");

  const largeFilePath = path.join(temporaryBase, "large-preview.txt");
  const handle = await fs.open(largeFilePath, "w");
  await handle.write("principio visible");
  await handle.truncate(64 * 1024 * 1024);
  await handle.close();
  const preview = await readBoundedPreview(largeFilePath);
  assert.equal(preview.format, "text");
  assert.equal(preview.truncated, true);
  assert.ok(preview.content.length <= 4000, "La vista previa excede el limite visual.");
  assert.equal(preview.totalBytes, 64 * 1024 * 1024);

  const workspace = path.join(temporaryBase, "workspace");
  const outside = path.join(temporaryBase, "outside");
  await fs.mkdir(workspace);
  await fs.mkdir(outside);
  const atomicTarget = path.join(workspace, "atomic.txt");
  await fs.writeFile(atomicTarget, "estado actual", "utf8");
  await assert.rejects(
    atomicWriteBuffer(atomicTarget, Buffer.from("reemplazo"), { expectedDestinationHash: "0".repeat(64) }),
    (error) => error?.code === "STATE_CONFLICT",
    "Una escritura atomica debe rechazar un destino distinto del esperado.",
  );
  assert.equal(await fs.readFile(atomicTarget, "utf8"), "estado actual");

  const auditPath = path.join(temporaryBase, "activity.jsonl");
  await appendActivity(auditPath, { action: "first" }, { maxBytes: 1, retainedFiles: 3 });
  await appendActivity(auditPath, { action: "second" }, { maxBytes: 1, retainedFiles: 3 });
  await appendActivity(auditPath, { action: "third" }, { maxBytes: 1, retainedFiles: 3 });
  assert.equal(await verifyAuditChain(auditPath, 3), true, "La cadena rotada debe conservar su continuidad.");
  const rotatedPath = `${auditPath}.2`;
  const rotatedContent = await fs.readFile(rotatedPath, "utf8");
  await fs.writeFile(rotatedPath, rotatedContent.replace('"result":"success"', '"result":"tampered"'), "utf8");
  assert.equal(await verifyAuditChain(auditPath, 3), false, "El verificador debe detectar cambios en archivos rotados.");

  const junction = path.join(workspace, "junction");
  await fs.symlink(outside, junction, "junction");
  await assert.rejects(
    resolveNewWorkspaceFile(workspace, "junction/escaped.txt"),
    /enlace|union/i,
    "Una restauracion no debe atravesar un enlace o union del espacio autorizado.",
  );

  console.log("Regresiones de seguridad verificadas: configuracion cerrada, vistas acotadas y enlaces bloqueados.");
} finally {
  if (path.basename(temporaryBase).startsWith("secure-mcp-regressions-")) {
    await fs.rm(temporaryBase, { recursive: true, force: true });
  }
}

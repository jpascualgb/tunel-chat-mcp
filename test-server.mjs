import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { consumeApproval, decideApproval, writeApprovals } from "./secure-store.mjs";

const temporaryBase = await fs.mkdtemp(path.join(os.tmpdir(), "pc-personal-mcp-test-"));
const temporaryRoot = path.join(temporaryBase, "workspace");
const stateRoot = path.join(temporaryBase, "state");
await fs.mkdir(temporaryRoot);
await fs.mkdir(stateRoot);
await fs.mkdir(path.join(temporaryRoot, ".MCP-PAPELERA"));
const permissionsPath = path.join(stateRoot, "permissions.json");
const activityPath = path.join(stateRoot, "activity.jsonl");
const approvalsPath = path.join(stateRoot, "approvals.json");
const backupsRoot = path.join(stateRoot, "backups");
await fs.writeFile(path.join(temporaryRoot, "package.json"), '{"name":"pc-personal-mcp"}\n');
await fs.writeFile(permissionsPath, JSON.stringify({ read: true, create: true, modify: true, delete: true }));

const serverPath = new URL("./mcp-launcher.mjs", import.meta.url).pathname.replace(/^\/(?:([A-Za-z]:))/, "$1");
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  env: {
    ...process.env,
    MCP_WORKSPACE_ROOT: temporaryRoot,
    MCP_PERMISSIONS_PATH: permissionsPath,
    MCP_ACTIVITY_PATH: activityPath,
    MCP_APPROVALS_PATH: approvalsPath,
    MCP_BACKUPS_ROOT: backupsRoot,
    MCP_PROFILE_ID: "test-profile",
    MCP_CONTROL_DATA_ROOT: stateRoot,
    CONTROL_PLANE_API_KEY: ["sk", "test-not-a-real-key"].join("-"),
  },
});
const client = new Client({ name: "pc-personal-test", version: "2.0.0" });

function parseResult(result) {
  const text = result.content?.find((item) => item.type === "text")?.text ?? "{}";
  return JSON.parse(text);
}

try {
  await client.connect(transport);
  const tools = await client.listTools();
  for (const expectedTool of [
    "comprobar_estado_local",
    "listar_archivos",
    "leer_archivo",
    "modificar_archivo",
    "eliminar_archivo",
    "listar_copias_seguridad",
  ]) {
    if (!tools.tools.some((tool) => tool.name === expectedTool)) {
      throw new Error(`No se encontro la herramienta esperada: ${expectedTool}.`);
    }
  }

  const status = parseResult(await client.callTool({ name: "comprobar_estado_local", arguments: {} }));
  if (status.carpeta_trabajo !== temporaryRoot || status.permisos.delete !== true || status.credencial_plano_control_presente !== false) {
    throw new Error("El estado no devolvio la carpeta y permisos esperados.");
  }

  const listing = await client.callTool({ name: "listar_archivos", arguments: { ruta: "." } });
  if (listing.isError || !parseResult(listing).elementos.some((item) => item.nombre === "package.json")) {
    throw new Error("listar_archivos no encontro el archivo esperado.");
  }
  if (parseResult(listing).elementos.some((item) => item.nombre.toLowerCase() === ".mcp-papelera")) {
    throw new Error("listar_archivos expuso un directorio interno con distinta capitalizacion.");
  }

  const textReading = await client.callTool({ name: "leer_archivo", arguments: { ruta: "package.json" } });
  const textPayload = parseResult(textReading);
  if (textReading.isError || textPayload.formato !== "texto" || !textPayload.contenido.includes("pc-personal-mcp")) {
    throw new Error("leer_archivo no devolvio el texto esperado.");
  }
  const readingWithoutHash = parseResult(await client.callTool({
    name: "leer_archivo",
    arguments: { ruta: "package.json", incluir_sha256: false },
  }));
  if (readingWithoutHash.sha256 !== null) throw new Error("La lectura no permitio omitir la huella completa para archivos grandes.");

  const escapeAttempt = await client.callTool({ name: "leer_archivo", arguments: { ruta: "../fuera.txt" } });
  if (!escapeAttempt.isError) throw new Error("La proteccion contra escape de ruta no funciono.");

  const adsAttempt = await client.callTool({ name: "leer_archivo", arguments: { ruta: "package.json:secret" } });
  if (!adsAttempt.isError) throw new Error("La proteccion contra flujos ADS de Windows no funciono.");

  const approvalRequest = await client.callTool({
    name: "modificar_archivo",
    arguments: { ruta: "imagen.bin", contenido: "AAECAwQ=", formato: "base64", modo: "crear", confirmar: false },
  });
  const approvalPayload = parseResult(approvalRequest);
  if (approvalRequest.isError || !approvalPayload.aprobacion_local_necesaria || !approvalPayload.solicitud_id) {
    throw new Error("La solicitud de aprobacion local no se genero.");
  }
  await decideApproval(approvalsPath, approvalPayload.solicitud_id, "approved");

  const creation = await client.callTool({
    name: "modificar_archivo",
    arguments: { ruta: "imagen.bin", contenido: "AAECAwQ=", formato: "base64", modo: "crear", aprobacion_id: approvalPayload.solicitud_id },
  });
  if (creation.isError) throw new Error("No se pudo crear un archivo binario autorizado.");

  const approvalTarget = path.join(temporaryRoot, "approval-target.txt");
  await fs.writeFile(approvalTarget, "estado mostrado", "utf8");
  const shownHash = createHash("sha256").update("estado mostrado").digest("hex");
  const staleApprovalRequest = await client.callTool({
    name: "modificar_archivo",
    arguments: { ruta: "approval-target.txt", contenido: "contenido aprobado", modo: "sobrescribir", sha256_esperado: shownHash },
  });
  const staleApprovalId = parseResult(staleApprovalRequest).solicitud_id;
  await decideApproval(approvalsPath, staleApprovalId, "approved");
  await fs.writeFile(approvalTarget, "estado distinto", "utf8");
  const changedHash = createHash("sha256").update("estado distinto").digest("hex");
  const staleApprovalUse = await client.callTool({
    name: "modificar_archivo",
    arguments: { ruta: "approval-target.txt", contenido: "contenido aprobado", modo: "sobrescribir", sha256_esperado: changedHash, aprobacion_id: staleApprovalId },
  });
  if (!staleApprovalUse.isError) throw new Error("Una aprobacion obsoleta autorizo un estado anterior diferente del mostrado.");

  await fs.writeFile(permissionsPath, JSON.stringify({
    read: true, create: true, modify: true, delete: true,
    approvalRequired: false, sensitiveProtection: true, backupEnabled: true, backupRetentionDays: 15,
  }));

  const unconfirmedAutonomousWrite = await client.callTool({
    name: "modificar_archivo",
    arguments: { ruta: "autonomous.txt", contenido: "sin confirmacion", modo: "crear" },
  });
  if (!unconfirmedAutonomousWrite.isError) throw new Error("El modo autonomo escribio sin confirmacion explicita del llamante.");
  const confirmedAutonomousWrite = await client.callTool({
    name: "modificar_archivo",
    arguments: { ruta: "autonomous.txt", contenido: "confirmado", modo: "crear", confirmar: true },
  });
  if (confirmedAutonomousWrite.isError) throw new Error("El modo autonomo rechazo una escritura confirmada.");

  const protectedSecret = await client.callTool({
    name: "modificar_archivo",
    arguments: { ruta: ".env", contenido: "SECRET=1", modo: "crear" },
  });
  if (!protectedSecret.isError) throw new Error("La proteccion de archivos sensibles no funciono.");

  const binaryReading = await client.callTool({
    name: "leer_archivo",
    arguments: { ruta: "imagen.bin", formato: "base64" },
  });
  const binaryPayload = parseResult(binaryReading);
  if (binaryPayload.contenido !== "AAECAwQ=") throw new Error("La lectura binaria base64 no coincide.");

  const wrongHash = await client.callTool({
    name: "modificar_archivo",
    arguments: {
      ruta: "imagen.bin", contenido: "BQYH", formato: "base64", modo: "sobrescribir",
      sha256_esperado: "0".repeat(64), confirmar: true,
    },
  });
  if (!wrongHash.isError) throw new Error("La modificacion con huella incorrecta no fue bloqueada.");

  const overwrite = await client.callTool({
    name: "modificar_archivo",
    arguments: {
      ruta: "imagen.bin", contenido: "BQYH", formato: "base64", modo: "sobrescribir",
      sha256_esperado: binaryPayload.sha256, confirmar: true,
    },
  });
  if (overwrite.isError) throw new Error("No se pudo modificar el archivo binario.");
  const newHash = parseResult(overwrite).sha256_nuevo;

  await fs.writeFile(permissionsPath, JSON.stringify({ read: true, create: true, modify: true, delete: false, approvalRequired: false, backupEnabled: true }));
  const blockedDelete = await client.callTool({
    name: "eliminar_archivo",
    arguments: { ruta: "imagen.bin", sha256_esperado: newHash, confirmar: true },
  });
  if (!blockedDelete.isError) throw new Error("La eliminacion desactivada no fue bloqueada.");

  await fs.writeFile(permissionsPath, JSON.stringify({ read: true, create: true, modify: true, delete: true, approvalRequired: false, backupEnabled: true }));
  const deletion = await client.callTool({
    name: "eliminar_archivo",
    arguments: { ruta: "imagen.bin", sha256_esperado: newHash, confirmar: true },
  });
  if (deletion.isError || !(await fs.stat(path.join(temporaryRoot, ".mcp-papelera"))).isDirectory()) {
    throw new Error("La eliminacion recuperable no funciono.");
  }

  const backups = parseResult(await client.callTool({ name: "listar_copias_seguridad", arguments: {} }));
  if (backups.total < 2) throw new Error("No se crearon copias antes de modificar y eliminar.");

  const atomicId = "22222222-2222-4222-8222-222222222222";
  await writeApprovals(approvalsPath, [{ id: atomicId, operationKey: "atomic-key", status: "approved", createdAt: new Date().toISOString(), decidedAt: new Date().toISOString() }]);
  const consumed = await Promise.all([
    consumeApproval(approvalsPath, atomicId, "atomic-key"),
    consumeApproval(approvalsPath, atomicId, "atomic-key"),
  ]);
  if (consumed.filter(Boolean).length !== 1) throw new Error("Una aprobacion pudo consumirse mas de una vez simultaneamente.");

  console.log("MCP verificado: aprobaciones opcionales, secretos, copias, permisos y papelera funcionan.");
} finally {
  await client.close();
  if (path.basename(temporaryBase).startsWith("pc-personal-mcp-test-")) {
    await fs.rm(temporaryBase, { recursive: true, force: true });
  }
}

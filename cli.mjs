#!/usr/bin/env node
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import {
  autostartEnabled,
  defaultDataRoot,
  deleteControlPlaneKey,
  loadControlPlaneKey,
  platformCapabilities,
  setAutostart,
  storeControlPlaneKey,
  validateControlPlaneKey,
} from "./platform-runtime.mjs";
import { buildSanitizedEnvironment, buildTunnelClientEnvironment } from "./process-environment.mjs";
import { canonicalPathForComparison, createProfile, normalizePathForIdentity, readProfiles, writeProfiles } from "./secure-store.mjs";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));

function parseArguments(argv) {
  const positionals = [];
  const flags = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) { positionals.push(argument); continue; }
    const separator = argument.indexOf("=");
    const name = argument.slice(2, separator === -1 ? undefined : separator);
    const inlineValue = separator === -1 ? undefined : argument.slice(separator + 1);
    if (inlineValue !== undefined) flags.set(name, inlineValue);
    else if (argv[index + 1] && !argv[index + 1].startsWith("--")) flags.set(name, argv[++index]);
    else flags.set(name, true);
  }
  return { positionals, flags };
}

function help() {
  return `Túnel Chat MCP

Uso:
  tunel-chat-mcp platform [--json]
  tunel-chat-mcp credential set [--data-root RUTA]
  tunel-chat-mcp setup --workspace RUTA --tunnel-id tunnel_ID [--client RUTA]
  tunel-chat-mcp run [--workspace RUTA] [--non-interactive] [--data-root RUTA] [--client RUTA]
  tunel-chat-mcp tunnel start|stop|restart|status [--data-root RUTA]
  tunel-chat-mcp autostart enable|disable|status [--data-root RUTA]
  tunel-chat-mcp uninstall --yes [--data-root RUTA]

La clave se solicita de forma oculta o se lee de la entrada estandar; nunca se acepta como argumento.
`;
}

function runChild(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || projectRoot,
      env: options.env || buildSanitizedEnvironment(process.env),
      stdio: options.stdio || "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve(0);
      else reject(new Error(`${path.basename(command)} termino con ${signal || `codigo ${code}`}.`));
    });
  });
}

async function readSecret() {
  if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    return validateControlPlaneKey(Buffer.concat(chunks).toString("utf8"));
  }
  process.stderr.write("Clave del plano de control: ");
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  let value = "";
  try {
    input: for await (const chunk of process.stdin) {
      for (const character of chunk) {
        if (character === "\r" || character === "\n") break input;
        if (character === "\u0003") throw new Error("Operacion cancelada.");
        if (character === "\u007f" || character === "\b") { value = value.slice(0, -1); continue; }
        if (/^[\x20-\x7e]$/.test(character)) value += character;
      }
    }
  } finally {
    process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stderr.write("\n");
  }
  return validateControlPlaneKey(value);
}

async function atomicWriteJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.rename(temporaryPath, filePath);
}

async function validateWorkspace(workspaceValue, dataRoot) {
  if (typeof workspaceValue !== "string" || !workspaceValue.trim()) throw new Error("Falta --workspace RUTA.");
  const workspace = await fs.realpath(path.resolve(workspaceValue));
  if (!(await fs.stat(workspace)).isDirectory()) throw new Error("La carpeta autorizada no es valida.");
  if (path.parse(workspace).root === workspace) throw new Error("No se permite autorizar la raiz completa.");
  const canonicalProjectRoot = await canonicalPathForComparison(projectRoot);
  const canonicalDataRoot = await canonicalPathForComparison(dataRoot);
  const relativeProject = path.relative(workspace, canonicalProjectRoot);
  const relativeWorkspace = path.relative(canonicalProjectRoot, workspace);
  const relativeData = path.relative(workspace, canonicalDataRoot);
  const relativeWorkspaceFromData = path.relative(canonicalDataRoot, workspace);
  if ((!relativeProject.startsWith("..") && !path.isAbsolute(relativeProject)) || (!relativeWorkspace.startsWith("..") && !path.isAbsolute(relativeWorkspace))) {
    throw new Error("La carpeta autorizada no puede contener el programa ni estar dentro de el.");
  }
  if ((!relativeData.startsWith("..") && !path.isAbsolute(relativeData)) || (!relativeWorkspaceFromData.startsWith("..") && !path.isAbsolute(relativeWorkspaceFromData))) {
    throw new Error("La carpeta autorizada y los datos privados no pueden solaparse.");
  }
  if (process.platform === "win32" && process.env.SystemRoot) {
    const relativeSystem = path.relative(await canonicalPathForComparison(process.env.SystemRoot), workspace);
    if (!relativeSystem.startsWith("..") && !path.isAbsolute(relativeSystem)) throw new Error("No se permite autorizar la carpeta de Windows.");
  }
  return workspace;
}

async function askWorkspace(question) {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try { return await terminal.question(question); }
  finally { terminal.close(); }
}

async function savedWorkspace(dataRoot) {
  try {
    const text = await fs.readFile(path.join(dataRoot, "workspace.json"), "utf8");
    const value = JSON.parse(text.replace(/^\uFEFF/, ""));
    if (typeof value?.workspaceRoot !== "string" || !value.workspaceRoot.trim()) throw new Error("invalid workspace");
    return value.workspaceRoot;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error("La configuracion de la carpeta esta danada.");
  }
}

export async function selectRunWorkspace(dataRoot, options = {}) {
  const configuredWorkspace = await savedWorkspace(dataRoot);
  const profilesPath = path.join(dataRoot, "profiles.json");
  const savedProfiles = await readProfiles(profilesPath, configuredWorkspace);
  const activeProfile = savedProfiles.profiles.find((profile) => profile.id === savedProfiles.activeProfileId) || null;
  const currentWorkspace = activeProfile?.workspace || configuredWorkspace;
  let requestedWorkspace = options.workspaceOverride;

  if (requestedWorkspace === undefined && options.interactive === true) {
    const suffix = currentWorkspace ? ` (Enter para conservar ${currentWorkspace})` : "";
    requestedWorkspace = await (options.prompt || askWorkspace)(`Ruta de la carpeta de trabajo${suffix}: `);
  }
  if (typeof requestedWorkspace === "string" && !requestedWorkspace.trim()) requestedWorkspace = undefined;
  const selectedWorkspace = await validateWorkspace(requestedWorkspace ?? currentWorkspace, dataRoot);
  const selectedIdentity = normalizePathForIdentity(selectedWorkspace);
  let selectedProfile = savedProfiles.profiles.find((profile) => normalizePathForIdentity(profile.workspace) === selectedIdentity);
  if (!selectedProfile) {
    selectedProfile = createProfile(path.basename(selectedWorkspace).slice(0, 80) || "Principal", selectedWorkspace);
    savedProfiles.profiles.push(selectedProfile);
  }
  savedProfiles.activeProfileId = selectedProfile.id;
  await writeProfiles(profilesPath, savedProfiles);
  await atomicWriteJson(path.join(dataRoot, "workspace.json"), { workspaceRoot: selectedWorkspace, updatedAtUtc: new Date().toISOString() });
  return selectedWorkspace;
}

export function normalizeClientCommand(value, cwd = projectRoot) {
  const command = typeof value === "string" ? value.trim() : "";
  if (!command || /[\0\r\n]/.test(command)) throw new Error("La ruta o nombre de tunnel-client no es valido.");
  return path.isAbsolute(command) || /[\\/]/.test(command) ? path.resolve(cwd, command) : command;
}

export function validateTunnelId(value) {
  const tunnelId = typeof value === "string" ? value.trim() : "";
  if (!/^tunnel_[a-z0-9]{32}$/.test(tunnelId)) {
    throw new Error("El identificador debe usar tunnel_ seguido de 32 caracteres minusculos o digitos.");
  }
  return tunnelId;
}

function clientCommand(flags) {
  if (flags.get("client")) return normalizeClientCommand(String(flags.get("client")));
  if (process.env.MCP_TUNNEL_CLIENT_PATH) return normalizeClientCommand(process.env.MCP_TUNNEL_CLIENT_PATH);
  if (process.platform === "win32") return path.join(projectRoot, "vendor", "tunnel-client", "tunnel-client.exe");
  return "tunnel-client";
}

async function configure(flags, dataRoot) {
  const tunnelId = validateTunnelId(flags.get("tunnel-id"));
  const workspace = await validateWorkspace(flags.get("workspace"), dataRoot);
  const key = await loadControlPlaneKey({ dataRoot, projectRoot });
  const client = clientCommand(flags);
  const environment = buildTunnelClientEnvironment(process.env, key, { MCP_WORKSPACE_ROOT: workspace, MCP_TUNNEL_DATA_ROOT: dataRoot });
  const serverPath = path.join(projectRoot, "mcp-launcher.mjs");
  const mcpCommand = `${JSON.stringify(process.execPath)} ${JSON.stringify(serverPath)}`;
  await runChild(client, ["init", "--force", "--sample", "sample_mcp_stdio_local", "--profile", "pc-personal", "--tunnel-id", tunnelId, "--mcp-command", mcpCommand], { env: environment });
  await runChild(client, ["doctor", "--profile", "pc-personal", "--explain"], { env: environment });
  await selectRunWorkspace(dataRoot, { workspaceOverride: workspace });
  await atomicWriteJson(path.join(dataRoot, "tunnel.json"), { tunnelId, updatedAtUtc: new Date().toISOString() });
  process.stdout.write("Configuracion verificada y guardada.\n");
}

async function runController(flags, dataRoot) {
  const workspaceOverride = flags.get("workspace");
  if (workspaceOverride === true) throw new Error("Falta el valor de --workspace.");
  const workspace = await selectRunWorkspace(dataRoot, {
    workspaceOverride,
    interactive: !flags.has("non-interactive") && process.stdin.isTTY === true && process.stdout.isTTY === true,
  });
  const key = await loadControlPlaneKey({ dataRoot, projectRoot });
  const environment = buildSanitizedEnvironment(process.env);
  environment.CONTROL_PLANE_API_KEY = key;
  environment.MCP_WORKSPACE_ROOT = workspace;
  environment.MCP_TUNNEL_DATA_ROOT = dataRoot;
  environment.MCP_TUNNEL_CLIENT_PATH = clientCommand(flags);
  environment.CONTROL_PANEL_OPEN_BROWSER = flags.has("non-interactive") ? "0" : "1";
  environment.CONTROL_PANEL_SHOW_URL = flags.has("non-interactive") ? "0" : "1";
  await runChild(process.execPath, [path.join(projectRoot, "control-panel.mjs")], { env: environment });
}

async function callLocalController(dataRoot, action) {
  let panelUrl;
  try { panelUrl = new URL((await fs.readFile(path.join(dataRoot, "panel-url.txt"), "utf8")).trim()); }
  catch { throw new Error("El panel local no esta iniciado."); }
  if (panelUrl.protocol !== "http:" || !["127.0.0.1", "[::1]", "::1"].includes(panelUrl.hostname) || !/^[a-f0-9]{48}$/.test(panelUrl.hash.slice(1))) {
    throw new Error("El enlace guardado del panel local no es valido.");
  }
  const token = panelUrl.hash.slice(1);
  const route = action === "status" ? "/api/v1/state" : `/api/v1/tunnel/${action}`;
  const response = await fetch(`${panelUrl.origin}${route}`, {
    method: action === "status" ? "GET" : "POST",
    headers: { "Content-Type": "application/json", "X-Control-Token": token },
    body: action === "status" ? undefined : "{}",
    signal: AbortSignal.timeout(3000),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error?.message || `El panel respondio HTTP ${response.status}.`);
  process.stdout.write(`${JSON.stringify({ running: payload.running, ready: payload.ready, pid: payload.pid ?? null })}\n`);
}

export async function main(argv = process.argv.slice(2)) {
  const { positionals, flags } = parseArguments(argv);
  const command = positionals[0] || "help";
  const dataRoot = path.resolve(String(flags.get("data-root") || process.env.MCP_TUNNEL_DATA_ROOT || defaultDataRoot()));
  if (/[\0\r\n]/.test(dataRoot)) throw new Error("La ruta de datos contiene caracteres de control.");

  if (command === "help" || command === "--help") { process.stdout.write(help()); return; }
  if (command === "platform") {
    const description = { platform: process.platform, dataRoot, ...platformCapabilities() };
    process.stdout.write(flags.has("json") ? `${JSON.stringify(description)}\n` : `${description.platform}: ${description.credentialStore}; ${description.serviceManager}; ${description.dataRoot}\n`);
    return;
  }
  if (command === "credential" && positionals[1] === "set") {
    await storeControlPlaneKey(await readSecret(), { dataRoot, projectRoot });
    process.stdout.write("Credencial guardada en el almacen seguro del sistema.\n");
    return;
  }
  if (command === "setup") { await configure(flags, dataRoot); return; }
  if (command === "run") { await runController(flags, dataRoot); return; }
  if (command === "tunnel") {
    const action = positionals[1] || "status";
    if (!["start", "stop", "restart", "status"].includes(action)) throw new Error("Accion del tunel desconocida.");
    await callLocalController(dataRoot, action);
    return;
  }
  if (command === "autostart") {
    const action = positionals[1] || "status";
    if (action === "status") { process.stdout.write(`${await autostartEnabled()}\n`); return; }
    if (action !== "enable" && action !== "disable") throw new Error("Accion de autostart desconocida.");
    await setAutostart(action === "enable", { dataRoot, projectRoot, cliPath: fileURLToPath(import.meta.url), clientPath: clientCommand(flags) });
    process.stdout.write(`Inicio automatico ${action === "enable" ? "activado" : "desactivado"}.\n`);
    return;
  }
  if (command === "uninstall") {
    if (!flags.has("yes")) throw new Error("Repite con --yes para desactivar el servicio y eliminar la credencial nativa.");
    await setAutostart(false, { dataRoot, projectRoot });
    await deleteControlPlaneKey({ dataRoot });
    process.stdout.write(`Servicio desactivado y credencial eliminada. Los datos no secretos se conservan en ${dataRoot}.\n`);
    return;
  }
  throw new Error(`Comando desconocido: ${command}.`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`Error: ${error instanceof Error ? error.message : "fallo inesperado"}\n`);
    process.exitCode = 1;
  });
}

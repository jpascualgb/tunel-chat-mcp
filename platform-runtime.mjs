import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSanitizedEnvironment } from "./process-environment.mjs";

const productName = "OpenAI-Secure-MCP-Tunnel";
const serviceId = "com.openai.secure-mcp-tunnel";
const moduleRoot = path.dirname(fileURLToPath(import.meta.url));

export function platformCapabilities(platform = process.platform) {
  if (platform === "win32") return { credentialStore: "DPAPI", serviceManager: "Task Scheduler" };
  if (platform === "darwin") return { credentialStore: "Keychain", serviceManager: "launchd" };
  if (platform === "linux") return { credentialStore: "Secret Service", serviceManager: "systemd --user" };
  throw new Error(`No compatible con la plataforma ${platform}.`);
}

export function defaultDataRoot(platform = process.platform, environment = process.env, home = os.homedir()) {
  if (platform === "win32") return path.join(environment.LOCALAPPDATA || path.join(home, "AppData", "Local"), productName);
  if (platform === "darwin") return path.join(home, "Library", "Application Support", productName);
  if (platform === "linux") return path.join(environment.XDG_STATE_HOME || path.join(home, ".local", "state"), productName.toLowerCase());
  return path.join(home, `.${productName.toLowerCase()}`);
}

export function validateControlPlaneKey(value) {
  const key = typeof value === "string" ? value.trim() : "";
  if (!/^sk-[A-Za-z0-9_-]{16,512}$/.test(key)) {
    throw new Error("La clave tiene un formato no valido; debe empezar por sk- y no contener espacios.");
  }
  return key;
}

function xmlEscape(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function systemdQuote(value) {
  return `"${String(value).replaceAll("%", "%%").replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function validateServiceValues(values) {
  for (const value of values) {
    if (typeof value !== "string" || !value || /[\0\r\n]/.test(value)) {
      throw new Error("Las rutas del servicio no pueden contener caracteres de control.");
    }
  }
}

export function buildLaunchAgent({ nodePath, cliPath, dataRoot, clientPath }) {
  validateServiceValues([nodePath, cliPath, dataRoot, ...(clientPath ? [clientPath] : [])]);
  const serviceArguments = [nodePath, cliPath, "run", "--non-interactive", "--data-root", dataRoot];
  if (clientPath) serviceArguments.push("--client", clientPath);
  const argumentsList = serviceArguments
    .map((value) => `      <string>${xmlEscape(value)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${serviceId}</string>
    <key>ProgramArguments</key>
    <array>
${argumentsList}
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ProcessType</key>
    <string>Interactive</string>
  </dict>
</plist>
`;
}

export function buildSystemdUserUnit({ nodePath, cliPath, dataRoot, clientPath }) {
  validateServiceValues([nodePath, cliPath, dataRoot, ...(clientPath ? [clientPath] : [])]);
  const clientArgument = clientPath ? ` --client ${systemdQuote(clientPath)}` : "";
  return `[Unit]
Description=OpenAI Secure MCP Tunnel
After=network-online.target

[Service]
Type=simple
ExecStart=${[nodePath, cliPath].map(systemdQuote).join(" ")} run --non-interactive --data-root ${systemdQuote(dataRoot)}${clientArgument}
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=default.target
`;
}

function runCommand(command, args, { input, env = buildSanitizedEnvironment(process.env), allowFailure = false, sensitiveValues = [] } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      windowsHide: true,
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0 || allowFailure) return resolve({ code, stdout, stderr });
      let detail = stderr.trim() || stdout.trim() || `codigo ${code}`;
      for (const value of sensitiveValues) if (value) detail = detail.replaceAll(value, "[REDACTED]");
      reject(new Error(`${path.basename(command)} fallo: ${detail}`));
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

function credentialAccount() {
  let account;
  try { account = os.userInfo().username; } catch { account = "current-user"; }
  if (!/^[A-Za-z0-9._@-]{1,128}$/.test(account)) throw new Error("El nombre de la cuenta local no tiene un formato seguro.");
  return account;
}

export async function storeControlPlaneKey(keyValue, options = {}) {
  const key = validateControlPlaneKey(keyValue);
  const platform = options.platform || process.platform;
  platformCapabilities(platform);
  const projectRoot = options.projectRoot || moduleRoot;
  const dataRoot = options.dataRoot || defaultDataRoot(platform);
  await fs.mkdir(dataRoot, { recursive: true, mode: 0o700 });

  if (platform === "win32") {
    const helper = path.join(projectRoot, "credential-store.ps1");
    await runCommand("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", helper, "store", dataRoot], { input: key, sensitiveValues: [key] });
    return;
  }
  if (platform === "darwin") {
    const account = credentialAccount().replaceAll('"', "");
    const command = `add-generic-password -U -a "${account}" -s "${serviceId}" -w "${key}"\n`;
    await runCommand("/usr/bin/security", ["-i"], { input: command, sensitiveValues: [key] });
    return;
  }
  if (platform === "linux") {
    await runCommand("secret-tool", ["store", `--label=${productName}`, "application", serviceId, "credential", "control-plane"], { input: key, sensitiveValues: [key] });
    return;
  }
  platformCapabilities(platform);
}

export async function loadControlPlaneKey(options = {}) {
  const platform = options.platform || process.platform;
  const projectRoot = options.projectRoot || moduleRoot;
  const dataRoot = options.dataRoot || defaultDataRoot(platform);
  let result;
  if (platform === "win32") {
    const helper = path.join(projectRoot, "credential-store.ps1");
    result = await runCommand("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", helper, "load", dataRoot]);
  } else if (platform === "darwin") {
    result = await runCommand("/usr/bin/security", ["find-generic-password", "-a", credentialAccount(), "-s", serviceId, "-w"]);
  } else if (platform === "linux") {
    result = await runCommand("secret-tool", ["lookup", "application", serviceId, "credential", "control-plane"]);
  } else {
    platformCapabilities(platform);
  }
  return validateControlPlaneKey(result.stdout);
}

export async function deleteControlPlaneKey(options = {}) {
  const platform = options.platform || process.platform;
  platformCapabilities(platform);
  const dataRoot = options.dataRoot || defaultDataRoot(platform);
  if (platform === "win32") {
    await fs.rm(path.join(dataRoot, "control-plane-key.dpapi"), { force: true });
    await fs.rm(path.join(dataRoot, "control-plane-key.xml"), { force: true });
    return;
  }
  if (platform === "darwin") {
    await runCommand("/usr/bin/security", ["delete-generic-password", "-a", credentialAccount(), "-s", serviceId], { allowFailure: true });
    return;
  }
  await runCommand("secret-tool", ["clear", "application", serviceId, "credential", "control-plane"], { allowFailure: true });
}

export function autostartPaths(platform = process.platform, home = os.homedir()) {
  if (platform === "darwin") return { definition: path.join(home, "Library", "LaunchAgents", `${serviceId}.plist`) };
  if (platform === "linux") return { definition: path.join(home, ".config", "systemd", "user", `${serviceId}.service`) };
  return {};
}

export async function autostartEnabled(options = {}) {
  const platform = options.platform || process.platform;
  platformCapabilities(platform);
  if (platform === "win32") {
    const taskName = options.taskName || "OpenAI Secure MCP Tunnel - PC personal";
    const result = await runCommand("powershell.exe", ["-NoProfile", "-Command", `(Get-ScheduledTask -TaskName '${taskName.replaceAll("'", "''")}' -ErrorAction SilentlyContinue) -ne $null`], { allowFailure: true });
    return result.code === 0 && result.stdout.trim().toLowerCase() === "true";
  }
  if (platform === "darwin") {
    const result = await runCommand("launchctl", ["print", `gui/${process.getuid()}/${serviceId}`], { allowFailure: true });
    return result.code === 0;
  }
  const result = await runCommand("systemctl", ["--user", "is-enabled", `${serviceId}.service`], { allowFailure: true });
  return result.code === 0 && result.stdout.trim() === "enabled";
}

export async function setAutostart(value, options = {}) {
  const platform = options.platform || process.platform;
  platformCapabilities(platform);
  const projectRoot = options.projectRoot || moduleRoot;
  validateServiceValues([projectRoot, ...(options.dataRoot ? [options.dataRoot] : []), ...(options.clientPath ? [options.clientPath] : [])]);
  if (platform === "win32") {
    const script = path.join(projectRoot, value ? "enable-autostart.ps1" : "disable-autostart.ps1");
    const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script];
    if (value && options.dataRoot) args.push("-DataRoot", options.dataRoot);
    if (value && options.clientPath) args.push("-ClientPath", options.clientPath);
    await runCommand("powershell.exe", args, { env: options.env || buildSanitizedEnvironment(process.env) });
    return;
  }

  const { definition } = autostartPaths(platform, options.home);
  if (!value) {
    if (platform === "darwin") await runCommand("launchctl", ["bootout", `gui/${process.getuid()}`, definition], { allowFailure: true });
    else await runCommand("systemctl", ["--user", "disable", "--now", `${serviceId}.service`], { allowFailure: true });
    await fs.rm(definition, { force: true });
    if (platform === "linux") await runCommand("systemctl", ["--user", "daemon-reload"], { allowFailure: true });
    return;
  }

  const dataRoot = options.dataRoot || defaultDataRoot(platform);
  const cliPath = options.cliPath || path.join(projectRoot, "cli.mjs");
  const clientPath = options.clientPath;
  const nodePath = options.nodePath || process.execPath;
  await fs.mkdir(path.dirname(definition), { recursive: true, mode: 0o700 });
  const content = platform === "darwin"
    ? buildLaunchAgent({ nodePath, cliPath, dataRoot, clientPath })
    : buildSystemdUserUnit({ nodePath, cliPath, dataRoot, clientPath });
  const temp = `${definition}.${process.pid}.tmp`;
  await fs.writeFile(temp, content, { encoding: "utf8", mode: 0o600 });
  await fs.rename(temp, definition);
  if (platform === "darwin") {
    await runCommand("launchctl", ["bootout", `gui/${process.getuid()}`, definition], { allowFailure: true });
    await runCommand("launchctl", ["bootstrap", `gui/${process.getuid()}`, definition]);
  }
  else {
    await runCommand("systemctl", ["--user", "daemon-reload"]);
    await runCommand("systemctl", ["--user", "enable", "--now", `${serviceId}.service`]);
  }
}

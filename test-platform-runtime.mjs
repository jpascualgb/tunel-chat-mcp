import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildLaunchAgent,
  buildSystemdUserUnit,
  deleteControlPlaneKey,
  defaultDataRoot,
  loadControlPlaneKey,
  platformCapabilities,
  storeControlPlaneKey,
  validateControlPlaneKey,
} from "./platform-runtime.mjs";

assert.deepEqual(platformCapabilities("win32"), { credentialStore: "DPAPI", serviceManager: "Task Scheduler" });
assert.deepEqual(platformCapabilities("darwin"), { credentialStore: "Keychain", serviceManager: "launchd" });
assert.deepEqual(platformCapabilities("linux"), { credentialStore: "Secret Service", serviceManager: "systemd --user" });
assert.throws(() => platformCapabilities("freebsd"), /no compatible/i);

assert.equal(defaultDataRoot("win32", { LOCALAPPDATA: "C:\\Local" }, "C:\\Users\\Demo"), path.join("C:\\Local", "OpenAI-Secure-MCP-Tunnel"));
assert.equal(defaultDataRoot("darwin", {}, "/Users/demo"), path.join("/Users/demo", "Library", "Application Support", "OpenAI-Secure-MCP-Tunnel"));
assert.equal(defaultDataRoot("linux", { XDG_STATE_HOME: "/state" }, "/home/demo"), path.join("/state", "openai-secure-mcp-tunnel"));

assert.equal(validateControlPlaneKey("sk-example_1234567890"), "sk-example_1234567890");
assert.throws(() => validateControlPlaneKey("not-a-key"), /formato/i);

const launchAgent = buildLaunchAgent({ nodePath: "/opt/node", cliPath: "/opt/secure tunnel/cli.mjs", dataRoot: "/Users/demo/Library/Application Support/data", clientPath: "/opt/tunnel-client" });
assert.match(launchAgent, /<key>ProgramArguments<\/key>/);
assert.match(launchAgent, /<string>run<\/string>/);
assert.match(launchAgent, /<string>\/opt\/tunnel-client<\/string>/);
assert.doesNotMatch(launchAgent, /CONTROL_PLANE_API_KEY|sk-/);

const systemdUnit = buildSystemdUserUnit({ nodePath: "/usr/bin/node", cliPath: "/opt/secure tunnel/cli.mjs", dataRoot: "/home/demo/.local/state/tunnel", clientPath: "/opt/tunnel-client" });
assert.match(systemdUnit, /ExecStart="\/usr\/bin\/node" "\/opt\/secure tunnel\/cli\.mjs" run/);
assert.match(systemdUnit, /--client "\/opt\/tunnel-client"/);
assert.match(systemdUnit, /WantedBy=default\.target/);
assert.doesNotMatch(systemdUnit, /CONTROL_PLANE_API_KEY|sk-/);
const systemdPercentUnit = buildSystemdUserUnit({ nodePath: "/usr/bin/node", cliPath: "/opt/100%/cli.mjs", dataRoot: "/home/demo/100%/state" });
assert.match(systemdPercentUnit, /\/opt\/100%%\/cli\.mjs/);
assert.match(systemdPercentUnit, /\/home\/demo\/100%%\/state/);
assert.throws(
  () => buildSystemdUserUnit({ nodePath: "/usr/bin/node\nEnvironment=ATTACK=1", cliPath: "/opt/cli.mjs", dataRoot: "/state" }),
  /control|ruta/i,
);

if (process.platform === "win32") {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "secure-mcp-dpapi-"));
  try {
    const testKey = "sk-test_dpapi_roundtrip_1234567890";
    await storeControlPlaneKey(testKey, { dataRoot });
    assert.equal(await loadControlPlaneKey({ dataRoot }), testKey);
    await deleteControlPlaneKey({ dataRoot });
    await assert.rejects(loadControlPlaneKey({ dataRoot }), /credencial|clave|guardada/i);
  } finally {
    await fs.rm(dataRoot, { recursive: true, force: true });
  }

  const helperRoot = await fs.mkdtemp(path.join(os.tmpdir(), "secure-mcp-env-"));
  const previousOpenAiKey = process.env.OPENAI_API_KEY;
  try {
    await fs.writeFile(path.join(helperRoot, "credential-store.ps1"), `param($Action, $DataRoot)
[Console]::In.ReadToEnd() | Out-Null
if ($env:OPENAI_API_KEY -or $env:OPENAI_ADMIN_KEY -or $env:CONTROL_PLANE_API_KEY) {
  Write-Error "El proceso auxiliar heredo una credencial."
  exit 32
}
`, "utf8");
    process.env.OPENAI_API_KEY = "ambient-secret-that-must-not-be-inherited";
    await storeControlPlaneKey("sk-test_sanitized_child_1234567890", {
      dataRoot: path.join(helperRoot, "data"),
      projectRoot: helperRoot,
    });
  } finally {
    if (previousOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousOpenAiKey;
    await fs.rm(helperRoot, { recursive: true, force: true });
  }
}
assert.throws(
  () => buildLaunchAgent({ nodePath: "/opt/node", cliPath: "/opt/cli.mjs", dataRoot: "/state\u0000escape" }),
  /control|ruta/i,
);

console.log("Plataformas verificadas: almacenes nativos y servicios de usuario se seleccionan sin incluir secretos.");

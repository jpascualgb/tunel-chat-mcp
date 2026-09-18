import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeClientCommand, selectRunWorkspace, validateTunnelId } from "./cli.mjs";
import { readProfiles } from "./secure-store.mjs";

const cliPath = fileURLToPath(new URL("./cli.mjs", import.meta.url));
assert.equal(normalizeClientCommand("tunnel-client", "/opt/app"), "tunnel-client");
assert.equal(normalizeClientCommand("./bin/tunnel-client", "/opt/app"), path.resolve("/opt/app", "./bin/tunnel-client"));
assert.equal(validateTunnelId(`tunnel_${"a".repeat(32)}`), `tunnel_${"a".repeat(32)}`);
assert.throws(() => validateTunnelId(`tunnel_${"A".repeat(32)}`), /32 caracteres minusculos/i);
const result = spawnSync(process.execPath, [cliPath, "platform", "--json"], { encoding: "utf8" });
assert.equal(result.status, 0, result.stderr);
const description = JSON.parse(result.stdout);
assert.equal(description.platform, process.platform);
assert.ok(description.dataRoot);
assert.ok(description.credentialStore);
assert.ok(description.serviceManager);

const helpResult = spawnSync(process.execPath, [cliPath, "--help"], { encoding: "utf8" });
assert.equal(helpResult.status, 0, helpResult.stderr);
assert.match(helpResult.stdout, /Túnel Chat MCP/);
assert.match(helpResult.stdout, /tunel-chat-mcp platform/);

const badCommand = spawnSync(process.execPath, [cliPath, "definitely-unknown"], { encoding: "utf8" });
assert.notEqual(badCommand.status, 0);
assert.match(badCommand.stderr, /comando desconocido/i);

const guardedUninstall = spawnSync(process.execPath, [cliPath, "uninstall"], { encoding: "utf8" });
assert.notEqual(guardedUninstall.status, 0);
assert.match(guardedUninstall.stderr, /--yes/);

const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "secure-mcp-cli-"));
try {
  const dataRoot = path.join(temporaryRoot, "data");
  const firstWorkspace = path.join(temporaryRoot, "first");
  const secondWorkspace = path.join(temporaryRoot, "second");
  await fs.mkdir(dataRoot);
  await fs.mkdir(firstWorkspace);
  await fs.mkdir(secondWorkspace);
  await fs.writeFile(path.join(dataRoot, "workspace.json"), JSON.stringify({ workspaceRoot: firstWorkspace }), "utf8");

  const selected = await selectRunWorkspace(dataRoot, {
    interactive: true,
    prompt: async () => secondWorkspace,
  });
  assert.equal(selected, await fs.realpath(secondWorkspace));
  const profiles = await readProfiles(path.join(dataRoot, "profiles.json"));
  assert.equal(profiles.profiles.find((profile) => profile.id === profiles.activeProfileId)?.workspace, selected);

  const retained = await selectRunWorkspace(dataRoot, {
    interactive: true,
    prompt: async () => "",
  });
  assert.equal(retained, selected, "Enter debe conservar el perfil activo.");

  const dataAlias = path.join(temporaryRoot, "data-alias");
  await fs.symlink(dataRoot, dataAlias, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(
    selectRunWorkspace(dataAlias, { workspaceOverride: dataRoot }),
    /datos privados|solaparse/i,
  );
} finally {
  await fs.rm(temporaryRoot, { recursive: true, force: true });
}

console.log("CLI multiplataforma verificada.");

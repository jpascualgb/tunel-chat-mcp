import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  buildSanitizedEnvironment,
  buildTunnelClientEnvironment,
  controlPlaneSecretNames,
} from "./process-environment.mjs";

const source = {
  PATH: "C:\\Windows\\System32",
  SAFE_VALUE: "visible",
  CONTROL_PLANE_API_KEY: "runtime-secret",
  OPENAI_API_KEY: "general-secret",
  OPENAI_ADMIN_KEY: "admin-secret",
  OPENAI_ORG_ID: "org-example",
};

const sanitized = buildSanitizedEnvironment(source);
for (const name of controlPlaneSecretNames) {
  assert.equal(sanitized[name], undefined, `${name} se filtro a un proceso auxiliar.`);
}
assert.equal(sanitized.SAFE_VALUE, "visible");
assert.equal(sanitized.OPENAI_ORG_ID, "org-example");
assert.equal(source.CONTROL_PLANE_API_KEY, "runtime-secret", "La funcion modifico el entorno de entrada.");

const tunnelEnvironment = buildTunnelClientEnvironment(source, "dedicated-runtime-secret", {
  MCP_WORKSPACE_ROOT: "C:\\workspace",
});
assert.equal(tunnelEnvironment.CONTROL_PLANE_API_KEY, "dedicated-runtime-secret");
assert.equal(tunnelEnvironment.OPENAI_API_KEY, undefined);
assert.equal(tunnelEnvironment.OPENAI_ADMIN_KEY, undefined);
assert.equal(tunnelEnvironment.MCP_WORKSPACE_ROOT, "C:\\workspace");
assert.equal(tunnelEnvironment.SAFE_VALUE, "visible");

assert.throws(
  () => buildTunnelClientEnvironment(source, "", {}),
  /credencial.*plano de control/i,
  "El cliente del tunel se inicio sin credencial dedicada.",
);

const setupScript = await readFile(new URL("./setup-tunnel.ps1", import.meta.url), "utf8");
assert.doesNotMatch(
  setupScript,
  /\$env:CONTROL_PLANE_API_KEY\s*=/i,
  "La configuracion no debe publicar la credencial en el entorno del proceso PowerShell.",
);
const protectionScript = await readFile(new URL("./protect-key.ps1", import.meta.url), "utf8");
assert.match(protectionScript, /control-plane-key\.dpapi/i);
assert.doesNotMatch(protectionScript, /Export-Clixml/i);

console.log("Entorno verificado: solo tunnel-client recibe deliberadamente la credencial.");

// Remove control-plane credentials before the MCP server code is loaded.
for (const name of [
  "CONTROL_PLANE_API_KEY",
  "OPENAI_API_KEY",
  "OPENAI_ADMIN_KEY",
  "OPENAI_ORG_ID",
  "OPENAI_PROJECT_ID",
]) {
  delete process.env[name];
}

await import("./server.mjs");

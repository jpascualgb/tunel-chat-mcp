import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { autostartPaths, deleteControlPlaneKey, setAutostart } from "./platform-runtime.mjs";

const serviceId = "com.openai.secure-mcp-tunnel";
const ok = { code: 0, stdout: "", stderr: "" };
const unavailable = { code: 1, stdout: "", stderr: "provider unavailable" };
const keychainAbsent = { ...ok, code: 44, stderr: "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.\n" };

// Only the OS process boundary is simulated; the production command runner,
// result handling and filesystem operations are exercised on every platform.
async function withNativeCommands(handler, action) {
  const originalSpawn = childProcess.spawn;
  const uidDescriptor = Object.getOwnPropertyDescriptor(process, "getuid");
  const calls = [];
  Object.defineProperty(process, "getuid", { configurable: true, value: () => 501 });
  childProcess.spawn = (command, args) => {
    calls.push({ command, args });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    queueMicrotask(() => {
      try {
        const result = handler(command, args);
        const finish = () => {
          child.stdout.end(result.stdout || "");
          child.stderr.end(result.stderr || "");
          if (!result.outputAfterExit) child.emit("exit", result.code, result.signal || null);
          child.emit("close", result.code, result.signal || null);
        };
        if (result.outputAfterExit) {
          child.emit("exit", result.code, result.signal || null);
          queueMicrotask(finish);
        } else finish();
      } catch (error) { child.emit("error", error); }
    });
    return child;
  };
  syncBuiltinESMExports();
  try { await action(calls); }
  finally {
    childProcess.spawn = originalSpawn;
    syncBuiltinESMExports();
    if (uidDescriptor) Object.defineProperty(process, "getuid", uidDescriptor);
    else delete process.getuid;
  }
}

for (const platform of ["darwin", "linux"]) {
  test(`${platform}: credential deletion reports native failures`, async () => {
    await withNativeCommands(() => unavailable, async () => {
      await assert.rejects(deleteControlPlaneKey({ platform }), /credencial|elimin|fallo/i);
    });
  });

  test(`${platform}: successful deletion must not leave a credential behind`, async () => {
    await withNativeCommands((command, args) => {
      if (["clear", "delete-generic-password"].includes(args[0])) return ok;
      return { ...ok, stdout: "remaining credential metadata" };
    }, async () => {
      await assert.rejects(deleteControlPlaneKey({ platform }), /credencial|elimin/i);
    });
  });

  test(`${platform}: already absent credential is idempotent`, async () => {
    await withNativeCommands((command, args) => {
      if (platform === "darwin") return keychainAbsent;
      return args[0] === "clear" ? { ...ok, code: 1 } : ok;
    }, async () => {
      await deleteControlPlaneKey({ platform });
      await deleteControlPlaneKey({ platform });
    });
  });

  test(`${platform}: deleted credential with confirmed absence succeeds`, async () => {
    await withNativeCommands((command, args) => {
      if (["clear", "delete-generic-password"].includes(args[0])) return ok;
      return platform === "darwin" ? keychainAbsent : ok;
    }, async () => { await deleteControlPlaneKey({ platform }); });
  });

  test(`${platform}: verification failure does not report credential deletion`, async () => {
    await withNativeCommands((command, args) => {
      if (["clear", "delete-generic-password"].includes(args[0])) return ok;
      return unavailable;
    }, async () => {
      await assert.rejects(deleteControlPlaneKey({ platform }), /credencial|elimin|fallo/i);
    });
  });

  for (const scenario of ["stop-fails", "still-active", "query-fails", "success", "already-absent"]) {
    test(`${platform}: service deactivation ${scenario}`, async () => {
      const home = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-service-safety-"));
      const { definition } = autostartPaths(platform, home);
      await fs.mkdir(path.dirname(definition), { recursive: true });
      await fs.writeFile(definition, "service definition");
      let active = scenario !== "already-absent";
      const handler = (command, args) => {
        if (args.includes("print") || args.includes("show")) {
          if (scenario === "query-fails") return unavailable;
          if (platform === "darwin") return active ? ok : {
            ...ok, code: 113, stderr: `Could not find service "${serviceId}" in domain for user gui: 501`,
          };
          return { ...ok, stdout: `LoadState=loaded\nActiveState=${active ? "active" : "inactive"}\nUnitFileState=${active ? "enabled" : "disabled"}\n` };
        }
        if (args.includes("bootout") || args.includes("disable")) {
          if (scenario === "stop-fails") return unavailable;
          if (scenario !== "still-active") active = false;
          return ok;
        }
        if (args.includes("daemon-reload")) return ok;
        throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
      };
      try {
        await withNativeCommands(handler, async () => {
          const operation = () => setAutostart(false, { platform, home });
          if (["success", "already-absent"].includes(scenario)) {
            await operation();
            assert.equal(active, false);
            await assert.rejects(fs.stat(definition), { code: "ENOENT" });
          } else {
            await assert.rejects(operation);
            assert.equal(await fs.readFile(definition, "utf8"), "service definition", "Keep service configuration when stopping is not confirmed.");
          }
        });
      } finally { await fs.rm(home, { recursive: true, force: true }); }
    });
  }
}

test("linux: silent clear failure cannot hide a locked item", async () => {
  await withNativeCommands((command, args) => args[0] === "clear"
    ? { ...ok, code: 1 }
    : { ...ok, stdout: "[/locked-item]\nlabel = tunnel credential\n" }, async () => {
    await assert.rejects(deleteControlPlaneKey({ platform: "linux" }), /credencial|elimin/i);
  });
});

test("credential command killed by a signal is not success", async () => {
  await withNativeCommands(() => ({ ...ok, code: null, signal: "SIGTERM" }), async () => {
    await assert.rejects(deleteControlPlaneKey({ platform: "linux" }), /credencial|elimin|fallo/i);
  });
});

test("missing GUI domain is an error, not an absent macOS service", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-missing-gui-"));
  try {
    await withNativeCommands(() => ({ ...ok, code: 113, stderr: "Could not find domain for user gui: 501" }), async () => {
      await assert.rejects(setAutostart(false, { platform: "darwin", home }));
    });
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});

test("macOS: keychain search errors preceding item-not-found are not absence", async () => {
  await withNativeCommands(() => ({ ...keychainAbsent,
    stderr: `security: SecKeychainSearchCreateFromAttributes: Invalid keychain.\n${keychainAbsent.stderr}`,
  }), async () => {
    await assert.rejects(deleteControlPlaneKey({ platform: "darwin" }), /credencial|elimin|fallo/i);
  });
});

test("linux: daemon reload failure is reported", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-service-reload-"));
  try {
    await withNativeCommands((command, args) => args.includes("show")
      ? { ...ok, stdout: "LoadState=not-found\nActiveState=inactive\nUnitFileState=\n" }
      : unavailable, async () => {
      await assert.rejects(setAutostart(false, { platform: "linux", home }), /fallo/i);
    });
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});

test("credential verification never includes provider secrets in errors", async () => {
  const marker = "PRIVATE_CREDENTIAL_OUTPUT";
  await withNativeCommands((command, args) => args[0] === "clear" ? ok : { ...ok, stdout: marker }, async () => {
    await assert.rejects(deleteControlPlaneKey({ platform: "linux" }), (error) => !error.message.includes(marker));
  });
});

test("late stderr after process exit cannot turn a deletion failure into absence", async () => {
  await withNativeCommands((command, args) => args[0] === "clear"
    ? { ...unavailable, outputAfterExit: true } : ok, async () => {
    await assert.rejects(deleteControlPlaneKey({ platform: "linux" }), /credencial|elimin|fallo/i);
  });
});

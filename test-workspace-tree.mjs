import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { copyTreeToNewPath, inspectTree, moveTreeToNewPath } from "./workspace-tree.mjs";

const temporaryBase = await fs.mkdtemp(path.join(os.tmpdir(), "tunel-chat-tree-test-"));
try {
  const source = path.join(temporaryBase, "source");
  const destination = path.join(temporaryBase, "destination");
  await fs.mkdir(path.join(source, "nested"), { recursive: true });
  await fs.writeFile(path.join(source, "one.txt"), "uno", "utf8");
  await fs.writeFile(path.join(source, "nested", "two.txt"), "dos", "utf8");

  const snapshot = await inspectTree(source, { maxEntries: 10, maxBytes: 1024 });
  assert.equal(snapshot.kind, "directory");
  assert.equal(snapshot.fileCount, 2);
  assert.equal(snapshot.directoryCount, 2);
  assert.equal(snapshot.totalBytes, 6);
  assert.match(snapshot.fingerprint, /^[a-f0-9]{64}$/);

  await copyTreeToNewPath(source, destination, snapshot.fingerprint, { maxEntries: 10, maxBytes: 1024 });
  assert.equal(await fs.readFile(path.join(destination, "nested", "two.txt"), "utf8"), "dos");

  const movedDestination = path.join(temporaryBase, "moved-destination");
  const destinationSnapshot = await inspectTree(destination, { maxEntries: 10, maxBytes: 1024 });
  await moveTreeToNewPath(destination, movedDestination, destinationSnapshot.fingerprint, { maxEntries: 10, maxBytes: 1024 });
  assert.equal(await fs.readFile(path.join(movedDestination, "nested", "two.txt"), "utf8"), "dos");
  await assert.rejects(fs.stat(destination), { code: "ENOENT" });

  await fs.writeFile(path.join(source, "one.txt"), "cambio", "utf8");
  await assert.rejects(
    copyTreeToNewPath(source, path.join(temporaryBase, "stale-copy"), snapshot.fingerprint, { maxEntries: 10, maxBytes: 1024 }),
    /cambio|huella|estado/i,
  );

  const external = path.join(temporaryBase, "external");
  await fs.mkdir(external);
  await fs.writeFile(path.join(external, "outside.txt"), "fuera", "utf8");
  const link = path.join(source, "nested", "external-link");
  try {
    await fs.symlink(external, link, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(inspectTree(source, { maxEntries: 10, maxBytes: 1024 }), /enlace|union/i);
    await fs.unlink(link);
  } catch (error) {
    if (!["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) throw error;
  }

  const hardLinkSource = path.join(temporaryBase, "hard-source.txt");
  await fs.writeFile(hardLinkSource, "externo", "utf8");
  await fs.link(hardLinkSource, path.join(source, "hard-link.txt"));
  await assert.rejects(inspectTree(source, { maxEntries: 20, maxBytes: 1024 }), /enlaces? duros?/i);
  await fs.unlink(path.join(source, "hard-link.txt"));

  await assert.rejects(inspectTree(source, { maxEntries: 2, maxBytes: 1024 }), /elementos/i);
  await assert.rejects(inspectTree(source, { maxEntries: 20, maxBytes: 1 }), /tamano/i);

  console.log("Arboles verificados: huellas, limites, copias y enlaces bloqueados.");
} finally {
  await fs.rm(temporaryBase, { recursive: true, force: true });
}

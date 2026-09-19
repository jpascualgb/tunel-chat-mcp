import assert from "node:assert/strict";
import { downloadChatGptImage, validateDownloadedImage } from "./chatgpt-files.mjs";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const descriptor = { download_url: "https://files.example.test/generated.png", file_id: "file_123", mime_type: "image/png", file_name: "generated.png" };

const validated = validateDownloadedImage(png, descriptor, "image/png");
assert.equal(validated.mimeType, "image/png");
assert.equal(validated.extension, ".png");
assert.match(validated.sha256, /^[a-f0-9]{64}$/);

await assert.rejects(
  downloadChatGptImage({ ...descriptor, download_url: "http://files.example.test/generated.png" }),
  /HTTPS/i,
);
await assert.rejects(
  downloadChatGptImage({ ...descriptor, download_url: "https://127.0.0.1/generated.png" }),
  /privada|reservada|publica/i,
);
await assert.rejects(
  downloadChatGptImage({ ...descriptor, download_url: "https://[::1]/generated.png" }),
  /privada|reservada|publica/i,
);
await assert.rejects(
  downloadChatGptImage({ ...descriptor, download_url: "https://[::ffff:127.0.0.1]/generated.png" }),
  /privada|reservada|publica/i,
);
await assert.rejects(
  downloadChatGptImage({ ...descriptor, download_url: "https://[2002:7f00:1::]/generated.png" }),
  /privada|reservada|publica/i,
);

const downloaded = await downloadChatGptImage(descriptor, {
  resolveHost: async () => [{ address: "93.184.216.34", family: 4 }],
  requestOnce: async () => ({ statusCode: 200, headers: { "content-type": "image/png" }, body: png }),
});
assert.equal(downloaded.sourceFileId, "file_123");
assert.deepEqual(downloaded.buffer, png);

await assert.rejects(
  downloadChatGptImage(descriptor, {
    resolveHost: async () => [{ address: "10.0.0.1", family: 4 }],
    requestOnce: async () => { throw new Error("No debe alcanzarse la red."); },
  }),
  /privada|reservada|publica/i,
);
await assert.rejects(
  downloadChatGptImage(descriptor, {
    resolveHost: async () => [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.1", family: 4 }],
    requestOnce: async () => { throw new Error("No debe alcanzarse la red."); },
  }),
  /privada|reservada|publica/i,
);

await assert.rejects(
  downloadChatGptImage(descriptor, {
    resolveHost: async () => [{ address: "93.184.216.34", family: 4 }],
    requestOnce: async () => ({ statusCode: 200, headers: { "content-type": "text/html" }, body: Buffer.from("<html></html>") }),
  }),
  /imagen|formato|contenido/i,
);

await assert.rejects(
  downloadChatGptImage(descriptor, {
    resolveHost: async () => [{ address: "93.184.216.34", family: 4 }],
    requestOnce: async () => ({ statusCode: 302, headers: { location: "https://127.0.0.1/private.png" }, body: Buffer.alloc(0) }),
  }),
  /privada|reservada|publica/i,
);

console.log("Archivos de ChatGPT verificados: esquema, imagenes y red privada bloqueada.");

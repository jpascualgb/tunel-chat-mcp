import assert from "node:assert/strict";
import {
  createPinnedLookup,
  downloadChatGptFile,
  downloadChatGptImage,
  validateDownloadedFile,
  validateDownloadedImage,
} from "./chatgpt-files.mjs";
import { createStagedTransferStore } from "./staged-transfers.mjs";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const descriptor = { download_url: "https://files.example.test/generated.png", file_id: "file_123", mime_type: "image/png", file_name: "generated.png" };

const pinnedLookup = createPinnedLookup({ address: "93.184.216.34", family: 4 });
await new Promise((resolve, reject) => {
  pinnedLookup("files.example.test", { all: true }, (error, addresses) => {
    if (error) return reject(error);
    try {
      assert.deepEqual(addresses, [{ address: "93.184.216.34", family: 4 }]);
      resolve();
    } catch (assertionError) { reject(assertionError); }
  });
});
await new Promise((resolve, reject) => {
  pinnedLookup("files.example.test", {}, (error, address, family) => {
    if (error) return reject(error);
    try {
      assert.equal(address, "93.184.216.34");
      assert.equal(family, 4);
      resolve();
    } catch (assertionError) { reject(assertionError); }
  });
});
assert.throws(
  () => createPinnedLookup({ address: "not-an-ip", family: 4 }),
  /direccion IP valida/,
);

const validated = validateDownloadedImage(png, descriptor, "image/png");
assert.equal(validated.mimeType, "image/png");
assert.equal(validated.extension, ".png");
assert.match(validated.sha256, /^[a-f0-9]{64}$/);

const pdfDescriptor = { download_url: "https://files.example.test/report.pdf", file_id: "file_pdf", mime_type: "application/pdf", file_name: "report.pdf" };
const pdf = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF", "ascii");
const validatedPdf = validateDownloadedFile(pdf, pdfDescriptor, "application/pdf");
assert.equal(validatedPdf.mimeType, "application/pdf");
assert.equal(validatedPdf.extension, ".pdf");
assert.equal(validatedPdf.kind, "pdf");

const docxDescriptor = {
  download_url: "https://files.example.test/report.docx", file_id: "file_docx",
  mime_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", file_name: "report.docx",
};
const docx = Buffer.concat([
  Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  Buffer.from("[Content_Types].xml\0word/document.xml", "ascii"),
]);
const validatedDocx = validateDownloadedFile(docx, docxDescriptor, "application/octet-stream");
assert.equal(validatedDocx.extension, ".docx");
assert.equal(validatedDocx.kind, "documento_word");
const macroDocx = Buffer.concat([docx, Buffer.from("word/vbaProject.bin", "ascii")]);
assert.throws(
  () => validateDownloadedFile(macroDocx, docxDescriptor, "application/octet-stream"),
  /macro|bloquead/i,
  "Los documentos Office con macros deben rechazarse aunque usen una extension no macro.",
);

const odtDescriptor = {
  download_url: "https://files.example.test/report.odt", file_id: "file_odt",
  mime_type: "application/vnd.oasis.opendocument.text", file_name: "report.odt",
};
const odt = Buffer.concat([
  Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  Buffer.from("mimetype\0application/vnd.oasis.opendocument.text", "ascii"),
]);
const validatedOdt = validateDownloadedFile(odt, odtDescriptor, "application/octet-stream");
assert.equal(validatedOdt.extension, ".odt");
assert.equal(validatedOdt.kind, "documento_odf");

const csvDescriptor = { download_url: "https://files.example.test/data.csv", file_id: "file_csv", mime_type: "text/csv", file_name: "data.csv" };
const csv = Buffer.from("nombre,valor\nuno,1\n", "utf8");
const validatedCsv = validateDownloadedFile(csv, csvDescriptor, "text/csv; charset=utf-8");
assert.equal(validatedCsv.extension, ".csv");
assert.equal(validatedCsv.kind, "texto");

for (const fileName of ["programa.exe", "script.ps1", "acceso.lnk", "documento.docm", "pagina.html", "imagen.svg"]) {
  assert.throws(
    () => validateDownloadedFile(Buffer.from("contenido", "utf8"), { ...csvDescriptor, file_name: fileName }, "application/octet-stream"),
    /no (?:esta )?permitid|bloquead|peligros/i,
    `${fileName} debe estar bloqueado.`,
  );
}
assert.throws(
  () => validateDownloadedFile(pdf, { ...pdfDescriptor, file_name: "report.csv", mime_type: "text/csv" }, "application/pdf"),
  /extension|tipo|formato/i,
  "Un PDF disfrazado de CSV debe rechazarse.",
);

const downloadedPdf = await downloadChatGptFile(pdfDescriptor, {
  resolveHost: async () => [{ address: "93.184.216.34", family: 4 }],
  requestOnce: async () => ({ statusCode: 200, headers: { "content-type": "application/pdf" }, body: pdf }),
});
assert.equal(downloadedPdf.kind, "pdf");
assert.deepEqual(downloadedPdf.buffer, pdf);

let releasePendingDownloads;
let markBothDownloadsStarted;
let startedDownloads = 0;
const pendingDownloadsReleased = new Promise((resolve) => { releasePendingDownloads = resolve; });
const bothDownloadsStarted = new Promise((resolve) => { markBothDownloadsStarted = resolve; });
const pendingOptions = {
  resolveHost: async () => [{ address: "93.184.216.34", family: 4 }],
  requestOnce: async () => {
    startedDownloads += 1;
    if (startedDownloads === 2) markBothDownloadsStarted();
    await pendingDownloadsReleased;
    return { statusCode: 200, headers: { "content-type": "application/pdf" }, body: pdf };
  },
};
const firstPendingDownload = downloadChatGptFile(pdfDescriptor, pendingOptions);
const secondPendingDownload = downloadChatGptFile({ ...pdfDescriptor, file_id: "file_pdf_2" }, pendingOptions);
await bothDownloadsStarted;
await assert.rejects(
  downloadChatGptFile({ ...pdfDescriptor, file_id: "file_pdf_3" }, {
    resolveHost: pendingOptions.resolveHost,
    requestOnce: async () => ({ statusCode: 200, headers: { "content-type": "application/pdf" }, body: pdf }),
  }),
  /simultaneas|concurrencia/i,
);
releasePendingDownloads();
await Promise.all([firstPendingDownload, secondPendingDownload]);

await assert.rejects(
  downloadChatGptFile({ ...pdfDescriptor, download_url: "https://127.0.0.1/report.pdf" }),
  /privada|reservada|publica/i,
);

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

let stagedNow = 1_000;
const stagedTransfers = createStagedTransferStore({
  ttlMs: 30_000,
  maxEntries: 2,
  maxBytes: 12,
  now: () => stagedNow,
});
const stagedPayload = { size: 5, marker: "TUNEL_CHAT_MCP_330" };
stagedTransfers.set("approval-1", stagedPayload);
assert.equal(stagedTransfers.get("approval-1"), stagedPayload, "La descarga aprobable debe permanecer disponible entre turnos.");
assert.throws(
  () => stagedTransfers.set("approval-too-large", { size: 13 }),
  /limite|memoria|pendientes/i,
  "El almacenamiento temporal debe limitar la memoria retenida.",
);
stagedNow += 29_000;
stagedTransfers.set("approval-1", { size: 5, marker: "REINTENTO" });
stagedNow += 1_001;
assert.equal(stagedTransfers.get("approval-1"), null, "Una descarga temporal caducada no debe poder confirmarse.");
assert.equal(stagedTransfers.size, 0, "Las descargas caducadas deben liberar memoria.");

console.log("Archivos de ChatGPT verificados: imagenes, documentos, concurrencia y red privada bloqueada.");

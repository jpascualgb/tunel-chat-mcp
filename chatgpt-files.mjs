import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import https from "node:https";
import { BlockList, isIP } from "node:net";

export const maxChatGptImageBytes = 20 * 1024 * 1024;
export const maxChatGptFileBytes = 50 * 1024 * 1024;
export const maxConcurrentChatGptDownloads = 2;
const maxRedirects = 3;
const requestTimeoutMs = 15_000;
let activeChatGptDownloads = 0;

const genericBinaryMimeTypes = new Set(["application/octet-stream", "binary/octet-stream"]);
const blockedMimeTypes = new Set([
  "application/hta", "application/java-archive", "application/vnd.android.package-archive",
  "application/vnd.microsoft.portable-executable", "application/x-bat", "application/x-dosexec",
  "application/x-executable", "application/x-httpd-php", "application/x-msdownload", "application/x-msdos-program",
  "application/x-msi", "application/x-powershell", "application/x-sh", "image/svg+xml", "text/html",
]);
const blockedFileExtensions = new Set([
  ".app", ".appx", ".appxbundle", ".apk", ".bat", ".bash", ".cmd", ".com", ".command", ".cpl",
  ".deb", ".desktop", ".dll", ".dmg", ".docm", ".dotm", ".exe", ".fish", ".hta", ".htm",
  ".html", ".img", ".inf", ".iso", ".jar", ".js", ".jse", ".lnk", ".mjs", ".msi", ".msix",
  ".msp", ".php", ".pkg", ".pl", ".potm", ".ppam", ".pptm", ".ps1", ".psd1", ".psm1",
  ".py", ".pyw", ".rb", ".reg", ".rpm", ".scf", ".scr", ".sh", ".sldm", ".svg", ".svgz",
  ".url", ".vbe", ".vbs", ".vhd", ".vhdx", ".war", ".wsf", ".wsh", ".xhtml", ".xlam",
  ".xlsm", ".xltm", ".zsh",
]);

const textFormats = [
  { extensions: [".txt", ".log"], mimeType: "text/plain", mimeTypes: ["text/plain"] },
  { extensions: [".md", ".markdown"], mimeType: "text/markdown", mimeTypes: ["text/markdown", "text/plain"] },
  { extensions: [".csv"], mimeType: "text/csv", mimeTypes: ["text/csv", "application/csv", "text/plain"] },
  { extensions: [".tsv"], mimeType: "text/tab-separated-values", mimeTypes: ["text/tab-separated-values", "text/plain"] },
  { extensions: [".json"], mimeType: "application/json", mimeTypes: ["application/json", "text/json", "text/plain"], json: true },
  { extensions: [".jsonl", ".ndjson"], mimeType: "application/x-ndjson", mimeTypes: ["application/x-ndjson", "application/jsonl", "text/plain"] },
  { extensions: [".ipynb"], mimeType: "application/x-ipynb+json", mimeTypes: ["application/x-ipynb+json", "application/json", "text/plain"], json: true },
  { extensions: [".yaml", ".yml"], mimeType: "application/yaml", mimeTypes: ["application/yaml", "application/x-yaml", "text/yaml", "text/x-yaml", "text/plain"] },
  { extensions: [".xml"], mimeType: "application/xml", mimeTypes: ["application/xml", "text/xml", "text/plain"] },
  { extensions: [".ics"], mimeType: "text/calendar", mimeTypes: ["text/calendar", "text/plain"] },
  { extensions: [".vcf"], mimeType: "text/vcard", mimeTypes: ["text/vcard", "text/x-vcard", "text/plain"] },
  { extensions: [".srt"], mimeType: "application/x-subrip", mimeTypes: ["application/x-subrip", "text/plain"] },
  { extensions: [".vtt"], mimeType: "text/vtt", mimeTypes: ["text/vtt", "text/plain"] },
];

const binaryFormats = {
  pdf: { kind: "pdf", extension: ".pdf", extensions: [".pdf"], mimeType: "application/pdf", mimeTypes: ["application/pdf"] },
  png: { kind: "imagen", extension: ".png", extensions: [".png"], mimeType: "image/png", mimeTypes: ["image/png"] },
  jpeg: { kind: "imagen", extension: ".jpg", extensions: [".jpg", ".jpeg"], mimeType: "image/jpeg", mimeTypes: ["image/jpeg", "image/jpg"] },
  webp: { kind: "imagen", extension: ".webp", extensions: [".webp"], mimeType: "image/webp", mimeTypes: ["image/webp"] },
  gif: { kind: "imagen", extension: ".gif", extensions: [".gif"], mimeType: "image/gif", mimeTypes: ["image/gif"] },
  rtf: { kind: "documento_rtf", extension: ".rtf", extensions: [".rtf"], mimeType: "application/rtf", mimeTypes: ["application/rtf", "text/rtf"] },
  docx: { kind: "documento_word", extension: ".docx", extensions: [".docx"], mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", mimeTypes: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/zip", "application/x-zip-compressed"] },
  xlsx: { kind: "hoja_calculo", extension: ".xlsx", extensions: [".xlsx"], mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", mimeTypes: ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/zip", "application/x-zip-compressed"] },
  pptx: { kind: "presentacion", extension: ".pptx", extensions: [".pptx"], mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", mimeTypes: ["application/vnd.openxmlformats-officedocument.presentationml.presentation", "application/zip", "application/x-zip-compressed"] },
  odt: { kind: "documento_odf", extension: ".odt", extensions: [".odt"], mimeType: "application/vnd.oasis.opendocument.text", mimeTypes: ["application/vnd.oasis.opendocument.text", "application/zip"] },
  ods: { kind: "hoja_calculo_odf", extension: ".ods", extensions: [".ods"], mimeType: "application/vnd.oasis.opendocument.spreadsheet", mimeTypes: ["application/vnd.oasis.opendocument.spreadsheet", "application/zip"] },
  odp: { kind: "presentacion_odf", extension: ".odp", extensions: [".odp"], mimeType: "application/vnd.oasis.opendocument.presentation", mimeTypes: ["application/vnd.oasis.opendocument.presentation", "application/zip"] },
  epub: { kind: "libro_electronico", extension: ".epub", extensions: [".epub"], mimeType: "application/epub+zip", mimeTypes: ["application/epub+zip", "application/zip"] },
  zip: { kind: "archivo_comprimido", extension: ".zip", extensions: [".zip"], mimeType: "application/zip", mimeTypes: ["application/zip", "application/x-zip-compressed"] },
  mp3: { kind: "audio", extension: ".mp3", extensions: [".mp3"], mimeType: "audio/mpeg", mimeTypes: ["audio/mpeg", "audio/mp3"] },
  wav: { kind: "audio", extension: ".wav", extensions: [".wav"], mimeType: "audio/wav", mimeTypes: ["audio/wav", "audio/x-wav", "audio/wave"] },
  flac: { kind: "audio", extension: ".flac", extensions: [".flac"], mimeType: "audio/flac", mimeTypes: ["audio/flac", "audio/x-flac"] },
  ogg: { kind: "audio_video", extension: ".ogg", extensions: [".ogg", ".oga", ".ogv"], mimeType: "application/ogg", mimeTypes: ["application/ogg", "audio/ogg", "video/ogg"] },
  mp4: { kind: "video", extension: ".mp4", extensions: [".mp4", ".m4a"], mimeType: "video/mp4", mimeTypes: ["video/mp4", "audio/mp4", "application/mp4"] },
  webm: { kind: "video", extension: ".webm", extensions: [".webm"], mimeType: "video/webm", mimeTypes: ["video/webm", "audio/webm"] },
};

const blockedAddresses = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24],
  ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
]) blockedAddresses.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 96], ["::1", 128], ["64:ff9b::", 96], ["64:ff9b:1::", 48],
  ["100::", 64], ["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
]) blockedAddresses.addSubnet(network, prefix, "ipv6");

function validateDescriptor(file) {
  if (!file || typeof file !== "object" || Array.isArray(file)) throw new Error("ChatGPT no proporciono un archivo valido.");
  if (typeof file.download_url !== "string" || !file.download_url.trim()) throw new Error("Falta download_url en el archivo de ChatGPT.");
  if (typeof file.file_id !== "string" || !file.file_id.trim()) throw new Error("Falta file_id en el archivo de ChatGPT.");
  for (const property of ["mime_type", "file_name"]) {
    if (file[property] !== undefined && typeof file[property] !== "string") throw new Error(`${property} debe ser texto.`);
  }
}

function resourcePhrase(resourceLabel, capitalize = false) {
  const phrase = resourceLabel === "imagen" ? "la imagen" : "el archivo";
  return capitalize ? `${phrase[0].toUpperCase()}${phrase.slice(1)}` : phrase;
}

function validateHttpsUrl(rawUrl, resourceLabel = "archivo") {
  let url;
  try { url = new URL(rawUrl); } catch { throw new Error("La URL de descarga no es valida."); }
  if (url.protocol !== "https:") throw new Error(`${resourcePhrase(resourceLabel, true)} solo puede descargarse mediante HTTPS.`);
  if (url.username || url.password) throw new Error("La URL de descarga no puede incluir credenciales.");
  if (url.port && url.port !== "443") throw new Error("La URL de descarga solo puede usar el puerto HTTPS 443.");
  return url;
}

function urlHostname(url) {
  return url.hostname.startsWith("[") && url.hostname.endsWith("]") ? url.hostname.slice(1, -1) : url.hostname;
}

function isPublicAddress(address) {
  const mappedMatch = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(address);
  if (mappedMatch) {
    const high = Number.parseInt(mappedMatch[1], 16);
    const low = Number.parseInt(mappedMatch[2], 16);
    return isPublicAddress(`${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`);
  }
  const detectedFamily = isIP(address);
  if (!detectedFamily) return false;
  const normalizedFamily = detectedFamily === 6 ? "ipv6" : "ipv4";
  return !blockedAddresses.check(address, normalizedFamily);
}

async function defaultResolveHost(hostname) {
  if (isIP(hostname)) return [{ address: hostname, family: isIP(hostname) }];
  return lookup(hostname, { all: true, verbatim: true });
}

function ensurePublicAddresses(addresses) {
  if (!Array.isArray(addresses) || addresses.length === 0) throw new Error("No se pudo resolver un destino de red publico.");
  if (addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new Error("La URL apunta a una direccion privada, local o reservada y ha sido bloqueada.");
  }
}

export function createPinnedLookup(pinnedAddress) {
  const address = pinnedAddress?.address;
  const family = pinnedAddress?.family ?? isIP(address);
  if (typeof address !== "string" || (family !== 4 && family !== 6) || isIP(address) !== family) {
    throw new Error("No se pudo fijar una direccion IP valida para la descarga.");
  }
  return (_hostname, options, callback) => {
    if (options && typeof options === "object" && options.all === true) {
      callback(null, [{ address, family }]);
      return;
    }
    callback(null, address, family);
  };
}

async function defaultRequestOnce(url, pinnedAddress, maxBytes = maxChatGptImageBytes, requestPolicy = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (error) reject(error); else resolve(value);
    };
    const hostname = urlHostname(url);
    const resourceLabel = requestPolicy.resourceLabel || "archivo";
    const requestOptions = {
      protocol: "https:", hostname, port: 443, path: `${url.pathname}${url.search}`,
      method: "GET", rejectUnauthorized: true,
      headers: { Accept: requestPolicy.accept || "application/octet-stream", "User-Agent": "tunel-chat-mcp/3.3" },
      lookup: createPinnedLookup(pinnedAddress),
    };
    if (!isIP(hostname)) requestOptions.servername = hostname;
    const request = https.request(requestOptions, (response) => {
      const contentLength = Number(response.headers["content-length"] ?? 0);
      if (Number.isFinite(contentLength) && contentLength > maxBytes) {
        const error = new Error(`${resourcePhrase(resourceLabel, true)} supera el limite de ${maxBytes} bytes.`);
        response.destroy(error);
        finish(error);
        return;
      }
      const chunks = [];
      let total = 0;
      response.on("data", (chunk) => {
        total += chunk.length;
        if (total > maxBytes) {
          const error = new Error(`${resourcePhrase(resourceLabel, true)} supera el limite de ${maxBytes} bytes.`);
          response.destroy(error);
          finish(error);
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => finish(null, { statusCode: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) }));
      response.on("error", (error) => finish(error));
    });
    request.setTimeout(requestTimeoutMs, () => request.destroy(new Error(`La descarga de ${resourcePhrase(resourceLabel)} agoto el tiempo de espera.`)));
    request.on("error", (error) => finish(error));
    request.end();
  });
}

function normalizedMime(value) {
  return typeof value === "string" ? value.split(";", 1)[0].trim().toLowerCase() : "";
}

function descriptorExtension(fileName) {
  if (typeof fileName !== "string") return "";
  const match = /(?:^|[\\/])?[^\\/]*?(\.[a-z0-9]{1,12})$/i.exec(fileName.trim());
  return match ? match[1].toLowerCase() : "";
}

function assertAllowedDescriptor(extension, descriptor, responseContentType) {
  if (extension && blockedFileExtensions.has(extension)) {
    throw new Error(`La extension ${extension} esta bloqueada por seguridad y no esta permitida.`);
  }
  for (const mime of [normalizedMime(descriptor?.mime_type), normalizedMime(responseContentType)].filter(Boolean)) {
    if (blockedMimeTypes.has(mime) || /macroenabled\.12$/.test(mime)) {
      throw new Error(`El tipo ${mime} esta bloqueado por seguridad y no esta permitido.`);
    }
  }
}

function hasPrefix(buffer, bytes) {
  return buffer.length >= bytes.length && buffer.subarray(0, bytes.length).equals(Buffer.from(bytes));
}

function detectZipFormat(buffer) {
  const includes = (value) => buffer.includes(value, 0, "latin1");
  if (includes("vbaProject.bin") || includes("macroEnabled")) {
    throw new Error("El archivo ZIP u Office contiene macros y ha sido bloqueado.");
  }
  if (includes("[Content_Types].xml")) {
    if (includes("word/")) return binaryFormats.docx;
    if (includes("xl/")) return binaryFormats.xlsx;
    if (includes("ppt/")) return binaryFormats.pptx;
  }
  if (includes("application/vnd.oasis.opendocument.text")) return binaryFormats.odt;
  if (includes("application/vnd.oasis.opendocument.spreadsheet")) return binaryFormats.ods;
  if (includes("application/vnd.oasis.opendocument.presentation")) return binaryFormats.odp;
  if (includes("application/epub+zip") || includes("META-INF/container.xml")) return binaryFormats.epub;
  return binaryFormats.zip;
}

function detectKnownBinaryFormat(buffer) {
  if (buffer.length >= 5 && buffer.subarray(0, 5).toString("ascii") === "%PDF-") return binaryFormats.pdf;
  if (hasPrefix(buffer, [137, 80, 78, 71, 13, 10, 26, 10])) return binaryFormats.png;
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff && buffer.at(-2) === 0xff && buffer.at(-1) === 0xd9) return binaryFormats.jpeg;
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return binaryFormats.webp;
  if (buffer.length >= 6 && ["GIF87a", "GIF89a"].includes(buffer.subarray(0, 6).toString("ascii"))) return binaryFormats.gif;
  if (buffer.length >= 5 && buffer.subarray(0, 5).toString("ascii") === "{\\rtf") return binaryFormats.rtf;
  if (hasPrefix(buffer, [0x50, 0x4b, 0x03, 0x04]) || hasPrefix(buffer, [0x50, 0x4b, 0x05, 0x06]) || hasPrefix(buffer, [0x50, 0x4b, 0x07, 0x08])) return detectZipFormat(buffer);
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WAVE") return binaryFormats.wav;
  if (buffer.length >= 4 && buffer.subarray(0, 4).toString("ascii") === "fLaC") return binaryFormats.flac;
  if (buffer.length >= 4 && buffer.subarray(0, 4).toString("ascii") === "OggS") return binaryFormats.ogg;
  if (buffer.length >= 3 && buffer.subarray(0, 3).toString("ascii") === "ID3") return binaryFormats.mp3;
  if (buffer.length >= 2 && buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0) return binaryFormats.mp3;
  if (buffer.length >= 12 && buffer.subarray(4, 8).toString("ascii") === "ftyp") return binaryFormats.mp4;
  if (hasPrefix(buffer, [0x1a, 0x45, 0xdf, 0xa3])) return binaryFormats.webm;
  return null;
}

function assertMimeCompatibility(format, descriptor, responseContentType) {
  const permitted = new Set(format.mimeTypes);
  for (const mime of [normalizedMime(descriptor?.mime_type), normalizedMime(responseContentType)].filter(Boolean)) {
    if (!genericBinaryMimeTypes.has(mime) && !permitted.has(mime)) {
      throw new Error(`El tipo declarado ${mime} no coincide con el formato real del archivo.`);
    }
  }
}

function textFormatFor(extension, descriptor, responseContentType) {
  if (extension) return textFormats.find((format) => format.extensions.includes(extension)) ?? null;
  const declaredMime = normalizedMime(descriptor?.mime_type);
  const responseMime = normalizedMime(responseContentType);
  const usefulMime = [declaredMime, responseMime].find((mime) => mime && !genericBinaryMimeTypes.has(mime));
  if (!usefulMime) return null;
  return textFormats.find((format) => format.mimeTypes.includes(usefulMime)) ?? null;
}

function validatedFileResult(buffer, descriptor, format, extension) {
  return {
    buffer,
    kind: format.kind ?? "texto",
    mimeType: format.mimeType,
    extension,
    allowedExtensions: [...format.extensions],
    size: buffer.length,
    sha256: createHash("sha256").update(buffer).digest("hex"),
    sourceFileId: descriptor.file_id,
    sourceFileName: descriptor.file_name ?? null,
  };
}

function detectImageFormat(buffer) {
  const detected = detectKnownBinaryFormat(buffer);
  if (detected && [binaryFormats.png, binaryFormats.jpeg, binaryFormats.webp].includes(detected)) {
    return { mimeType: detected.mimeType, extension: detected.extension };
  }
  throw new Error("El contenido descargado no tiene un formato de imagen PNG, JPEG o WebP admitido.");
}

export function validateDownloadedImage(buffer, descriptor, responseContentType = "") {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error("La descarga no contiene una imagen.");
  if (buffer.length > maxChatGptImageBytes) throw new Error(`La imagen supera el limite de ${maxChatGptImageBytes} bytes.`);
  const detected = detectImageFormat(buffer);
  const declaredMime = normalizedMime(descriptor?.mime_type);
  const responseMime = normalizedMime(responseContentType);
  for (const mime of [declaredMime, responseMime].filter(Boolean)) {
    if (mime !== "application/octet-stream" && mime !== detected.mimeType) {
      throw new Error("El tipo declarado no coincide con el formato real de la imagen.");
    }
  }
  return {
    buffer,
    ...detected,
    allowedExtensions: detected.extension === ".jpg" ? [".jpg", ".jpeg"] : [detected.extension],
    size: buffer.length,
    sha256: createHash("sha256").update(buffer).digest("hex"),
    sourceFileId: descriptor.file_id,
    sourceFileName: descriptor.file_name ?? null,
  };
}

export function validateDownloadedFile(buffer, descriptor, responseContentType = "") {
  validateDescriptor(descriptor);
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error("La descarga no contiene un archivo.");
  if (buffer.length > maxChatGptFileBytes) throw new Error(`El archivo supera el limite de ${maxChatGptFileBytes} bytes.`);

  const extension = descriptorExtension(descriptor.file_name);
  assertAllowedDescriptor(extension, descriptor, responseContentType);
  const binaryFormat = detectKnownBinaryFormat(buffer);
  if (binaryFormat) {
    if (extension && !binaryFormat.extensions.includes(extension)) {
      throw new Error(`La extension ${extension} no coincide con el formato real del archivo.`);
    }
    assertMimeCompatibility(binaryFormat, descriptor, responseContentType);
    return validatedFileResult(buffer, descriptor, binaryFormat, extension || binaryFormat.extension);
  }

  let decoded;
  try { decoded = new TextDecoder("utf-8", { fatal: true }).decode(buffer); }
  catch { throw new Error("El formato binario del archivo no esta admitido."); }
  if (decoded.includes("\0")) throw new Error("El archivo de texto contiene bytes nulos y ha sido bloqueado.");
  const textFormat = textFormatFor(extension, descriptor, responseContentType);
  if (!textFormat) throw new Error(`La extension ${extension || "sin extension"} no esta permitida para archivos descargados.`);
  assertMimeCompatibility(textFormat, descriptor, responseContentType);
  if (textFormat.json) {
    try { JSON.parse(decoded); } catch { throw new Error("El archivo JSON no contiene JSON valido."); }
  }
  return validatedFileResult(buffer, descriptor, textFormat, extension || textFormat.extensions[0]);
}

async function downloadChatGptResource(file, options, policy) {
  validateDescriptor(file);
  if (activeChatGptDownloads >= maxConcurrentChatGptDownloads) {
    throw new Error(`Se alcanzo el limite de ${maxConcurrentChatGptDownloads} descargas simultaneas de ChatGPT.`);
  }
  activeChatGptDownloads += 1;
  try {
    const resolveHost = options.resolveHost ?? defaultResolveHost;
    const requestOnce = options.requestOnce ?? defaultRequestOnce;
    let url = validateHttpsUrl(file.download_url, policy.resourceLabel);

    for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
      const hostname = urlHostname(url);
      const addressFamily = isIP(hostname);
      const addresses = addressFamily ? [{ address: hostname, family: addressFamily }] : await resolveHost(hostname);
      ensurePublicAddresses(addresses);
      const response = await requestOnce(url, addresses[0], policy.maxBytes, {
        accept: policy.accept,
        resourceLabel: policy.resourceLabel,
      });
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        if (redirects === maxRedirects) throw new Error("La descarga supera el limite de redirecciones.");
        const location = Array.isArray(response.headers?.location) ? response.headers.location[0] : response.headers?.location;
        if (!location) throw new Error("La redireccion de descarga no incluye destino.");
        url = validateHttpsUrl(new URL(location, url).href, policy.resourceLabel);
        continue;
      }
      if (response.statusCode !== 200) throw new Error(`La descarga de ChatGPT respondio con HTTP ${response.statusCode}.`);
      const contentType = Array.isArray(response.headers?.["content-type"]) ? response.headers["content-type"][0] : response.headers?.["content-type"];
      return policy.validate(response.body, file, contentType);
    }
    throw new Error(`No se pudo descargar ${resourcePhrase(policy.resourceLabel)} de ChatGPT.`);
  } finally {
    activeChatGptDownloads -= 1;
  }
}

export async function downloadChatGptImage(file, options = {}) {
  return downloadChatGptResource(file, options, {
    resourceLabel: "imagen",
    maxBytes: maxChatGptImageBytes,
    accept: "image/png,image/jpeg,image/webp,application/octet-stream;q=0.5",
    validate: validateDownloadedImage,
  });
}

export async function downloadChatGptFile(file, options = {}) {
  return downloadChatGptResource(file, options, {
    resourceLabel: "archivo",
    maxBytes: maxChatGptFileBytes,
    accept: "*/*",
    validate: validateDownloadedFile,
  });
}

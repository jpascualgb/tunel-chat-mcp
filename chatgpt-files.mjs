import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import https from "node:https";
import { BlockList, isIP } from "node:net";

export const maxChatGptImageBytes = 20 * 1024 * 1024;
const maxRedirects = 3;
const requestTimeoutMs = 15_000;

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

function validateHttpsUrl(rawUrl) {
  let url;
  try { url = new URL(rawUrl); } catch { throw new Error("La URL de descarga no es valida."); }
  if (url.protocol !== "https:") throw new Error("La imagen solo puede descargarse mediante HTTPS.");
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

async function defaultRequestOnce(url, pinnedAddress, maxBytes = maxChatGptImageBytes) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (error) reject(error); else resolve(value);
    };
    const hostname = urlHostname(url);
    const requestOptions = {
      protocol: "https:", hostname, port: 443, path: `${url.pathname}${url.search}`,
      method: "GET", rejectUnauthorized: true,
      headers: { Accept: "image/png,image/jpeg,image/webp,application/octet-stream;q=0.5", "User-Agent": "tunel-chat-mcp/3.2" },
      lookup: (_hostname, _options, callback) => callback(null, pinnedAddress.address, pinnedAddress.family),
    };
    if (!isIP(hostname)) requestOptions.servername = hostname;
    const request = https.request(requestOptions, (response) => {
      const contentLength = Number(response.headers["content-length"] ?? 0);
      if (Number.isFinite(contentLength) && contentLength > maxBytes) {
        const error = new Error(`La imagen supera el limite de ${maxBytes} bytes.`);
        response.destroy(error);
        finish(error);
        return;
      }
      const chunks = [];
      let total = 0;
      response.on("data", (chunk) => {
        total += chunk.length;
        if (total > maxBytes) {
          const error = new Error(`La imagen supera el limite de ${maxBytes} bytes.`);
          response.destroy(error);
          finish(error);
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => finish(null, { statusCode: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) }));
      response.on("error", (error) => finish(error));
    });
    request.setTimeout(requestTimeoutMs, () => request.destroy(new Error("La descarga de la imagen agoto el tiempo de espera.")));
    request.on("error", (error) => finish(error));
    request.end();
  });
}

function normalizedMime(value) {
  return typeof value === "string" ? value.split(";", 1)[0].trim().toLowerCase() : "";
}

function detectImageFormat(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return { mimeType: "image/png", extension: ".png" };
  }
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff && buffer.at(-2) === 0xff && buffer.at(-1) === 0xd9) {
    return { mimeType: "image/jpeg", extension: ".jpg" };
  }
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") {
    return { mimeType: "image/webp", extension: ".webp" };
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
    size: buffer.length,
    sha256: createHash("sha256").update(buffer).digest("hex"),
    sourceFileId: descriptor.file_id,
    sourceFileName: descriptor.file_name ?? null,
  };
}

export async function downloadChatGptImage(file, options = {}) {
  validateDescriptor(file);
  const resolveHost = options.resolveHost ?? defaultResolveHost;
  const requestOnce = options.requestOnce ?? defaultRequestOnce;
  let url = validateHttpsUrl(file.download_url);

  for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
    const hostname = urlHostname(url);
    const addressFamily = isIP(hostname);
    const addresses = addressFamily ? [{ address: hostname, family: addressFamily }] : await resolveHost(hostname);
    ensurePublicAddresses(addresses);
    const response = await requestOnce(url, addresses[0], maxChatGptImageBytes);
    if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
      if (redirects === maxRedirects) throw new Error("La descarga supera el limite de redirecciones.");
      const location = Array.isArray(response.headers?.location) ? response.headers.location[0] : response.headers?.location;
      if (!location) throw new Error("La redireccion de descarga no incluye destino.");
      url = validateHttpsUrl(new URL(location, url).href);
      continue;
    }
    if (response.statusCode !== 200) throw new Error(`La descarga de ChatGPT respondio con HTTP ${response.statusCode}.`);
    const contentType = Array.isArray(response.headers?.["content-type"]) ? response.headers["content-type"][0] : response.headers?.["content-type"];
    return validateDownloadedImage(response.body, file, contentType);
  }
  throw new Error("No se pudo descargar la imagen de ChatGPT.");
}

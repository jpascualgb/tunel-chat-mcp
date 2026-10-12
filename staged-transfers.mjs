export function createStagedTransferStore(options = {}) {
  const ttlMs = options.ttlMs ?? 30 * 60_000;
  const maxEntries = options.maxEntries ?? 4;
  const maxBytes = options.maxBytes ?? 100 * 1024 * 1024;
  const now = options.now ?? Date.now;
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new Error("La caducidad temporal no es valida.");
  if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) throw new Error("El limite de transferencias pendientes no es valido.");
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("El limite de memoria temporal no es valido.");

  const entries = new Map();
  let retainedBytes = 0;

  function cleanup() {
    const currentTime = now();
    for (const [id, entry] of entries) {
      if (entry.expiresAt > currentTime) continue;
      entries.delete(id);
      retainedBytes -= entry.size;
    }
  }

  return {
    set(id, value) {
      cleanup();
      if (typeof id !== "string" || !id) throw new Error("El identificador de aprobacion temporal no es valido.");
      const size = value?.size;
      if (!Number.isSafeInteger(size) || size < 0) throw new Error("El tamano de la transferencia temporal no es valido.");
      const previous = entries.get(id);
      const nextCount = entries.size + (previous ? 0 : 1);
      const nextBytes = retainedBytes - (previous?.size ?? 0) + size;
      if (nextCount > maxEntries || nextBytes > maxBytes) {
        throw new Error("Se alcanzo el limite seguro de memoria para transferencias pendientes.");
      }
      if (previous) retainedBytes -= previous.size;
      entries.set(id, { value, size, expiresAt: previous?.expiresAt ?? now() + ttlMs });
      retainedBytes += size;
    },
    get(id) {
      cleanup();
      return entries.get(id)?.value ?? null;
    },
    delete(id) {
      cleanup();
      const entry = entries.get(id);
      if (!entry) return false;
      entries.delete(id);
      retainedBytes -= entry.size;
      return true;
    },
    clear() {
      entries.clear();
      retainedBytes = 0;
    },
    get size() {
      cleanup();
      return entries.size;
    },
    get bytes() {
      cleanup();
      return retainedBytes;
    },
  };
}

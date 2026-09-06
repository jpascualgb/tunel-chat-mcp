export const controlPlaneSecretNames = Object.freeze([
  "CONTROL_PLANE_API_KEY",
  "OPENAI_API_KEY",
  "OPENAI_ADMIN_KEY",
]);

export function buildSanitizedEnvironment(source = process.env) {
  const environment = { ...source };
  for (const name of controlPlaneSecretNames) delete environment[name];
  return environment;
}

export function buildTunnelClientEnvironment(source, controlPlaneApiKey, additions = {}) {
  if (typeof controlPlaneApiKey !== "string" || !controlPlaneApiKey.trim()) {
    throw new Error("No hay una credencial valida para el plano de control.");
  }
  const environment = buildSanitizedEnvironment({ ...source, ...additions });
  environment.CONTROL_PLANE_API_KEY = controlPlaneApiKey;
  return environment;
}

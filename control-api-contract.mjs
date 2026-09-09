import { z } from "zod";

export const apiBasePath = "/api/v1";

export class ApiError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const apiSchemas = Object.freeze({
  permissionPatch: z.object({
    permission: z.enum(["read", "create", "modify", "delete"]),
    value: z.boolean(),
    durationMinutes: z.union([z.literal(10), z.literal(30), z.literal(60), z.null()]).optional(),
  }).strict(),
  settingsPatch: z.object({
    approvalRequired: z.boolean().optional(),
    sensitiveProtection: z.boolean().optional(),
    backupEnabled: z.boolean().optional(),
    backupRetentionDays: z.union([z.literal(15), z.literal(30), z.null()]).optional(),
  }).strict().refine((value) => Object.keys(value).length > 0, "Incluye al menos un ajuste."),
  profileCreate: z.object({ name: z.string().trim().min(1).max(80), workspace: z.string().trim().min(1).max(4096) }).strict(),
  activeProfilePatch: z.object({ id: z.string().regex(/^[a-zA-Z0-9-]{1,80}$/) }).strict(),
  approvalDecision: z.object({ status: z.enum(["approved", "rejected"]) }).strict(),
  autostartPatch: z.object({ value: z.boolean() }).strict(),
  backupRestore: z.object({ expectedCurrentSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable().optional() }).strict(),
  empty: z.object({}).strict(),
});

export function parseApiInput(schema, value) {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new ApiError(422, "VALIDATION_ERROR", "La solicitud no cumple el contrato de la API.", parsed.error.flatten());
  }
  return parsed.data;
}

export function apiErrorPayload(code, message, details = undefined) {
  return { error: { code, message, ...(details === undefined ? {} : { details }) } };
}

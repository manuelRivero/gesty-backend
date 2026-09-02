import type { Request, Response } from "express";
import { z } from "zod";
import {
  ASSIGNABLE_BUSINESS_USER_ROLES,
  type BusinessUserRole
} from "../types/auth";
import {
  BusinessUserManagementError,
  createAdminBusinessUser,
  deleteAdminBusinessUser,
  getAdminBusinessUserById,
  listAdminBusinessUsers,
  updateAdminBusinessUser,
  type AdminBusinessUserActor
} from "../services/adminBusinessUsers.service";

const postgresUuid = z.string().regex(
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/,
  "UUID inválido"
);

const idParamSchema = z.object({
  id: postgresUuid
});

const assignableRole = z.enum(ASSIGNABLE_BUSINESS_USER_ROLES);

const createSchema = z.object({
  email: z.string().trim().email().max(255),
  name: z.string().trim().min(1).max(120),
  role: assignableRole,
  password: z.string().min(8).max(200).optional()
});

const updateSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    role: assignableRole.optional(),
    password: z.string().min(8).max(200).optional()
  })
  .refine(
    (v) =>
      v.name !== undefined ||
      v.role !== undefined ||
      v.password !== undefined,
    { message: "Indicá al menos un campo para actualizar" }
  );

function actorFromRequest(req: Request): AdminBusinessUserActor | null {
  const userId = req.user?.userId;
  const role = req.user?.role as BusinessUserRole | undefined;
  if (!userId || !role) return null;
  return { userId, role };
}

function statusForCode(code: BusinessUserManagementError["code"]): number {
  switch (code) {
    case "NOT_FOUND":
      return 404;
    case "ALREADY_MEMBER":
    case "LAST_OWNER":
      return 409;
    case "FORBIDDEN_ROLE":
    case "CANNOT_TARGET_OWNER":
    case "CANNOT_MANAGE_SELF":
      return 403;
    case "PASSWORD_REQUIRED":
      return 400;
    default:
      return 400;
  }
}

function handleManagementError(res: Response, err: unknown): boolean {
  if (err instanceof BusinessUserManagementError) {
    res.status(statusForCode(err.code)).json({
      error: err.message,
      code: err.code
    });
    return true;
  }
  return false;
}

export async function getBusinessUsers(req: Request, res: Response) {
  const businessId = req.user?.businessId;
  if (!businessId) {
    return res.status(401).json({ error: "No autenticado" });
  }

  const items = await listAdminBusinessUsers({ businessId });
  return res.json({ items });
}

export async function getBusinessUserById(req: Request, res: Response) {
  const businessId = req.user?.businessId;
  if (!businessId) {
    return res.status(401).json({ error: "No autenticado" });
  }

  const parsedParams = idParamSchema.safeParse(req.params);
  if (!parsedParams.success) {
    return res.status(400).json({ error: "id inválido" });
  }

  const row = await getAdminBusinessUserById({
    businessId,
    id: parsedParams.data.id
  });
  if (!row) {
    return res.status(404).json({ error: "Usuario no encontrado" });
  }

  return res.json(row);
}

export async function postBusinessUser(req: Request, res: Response) {
  const businessId = req.user?.businessId;
  const actor = actorFromRequest(req);
  if (!businessId || !actor) {
    return res.status(401).json({ error: "No autenticado" });
  }

  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: "Body inválido",
      details: parsed.error.flatten()
    });
  }

  try {
    const row = await createAdminBusinessUser({
      businessId,
      actor,
      ...parsed.data
    });
    return res.status(201).json(row);
  } catch (err) {
    if (handleManagementError(res, err)) return;
    throw err;
  }
}

export async function patchBusinessUser(req: Request, res: Response) {
  const businessId = req.user?.businessId;
  const actor = actorFromRequest(req);
  if (!businessId || !actor) {
    return res.status(401).json({ error: "No autenticado" });
  }

  const parsedParams = idParamSchema.safeParse(req.params);
  if (!parsedParams.success) {
    return res.status(400).json({ error: "id inválido" });
  }

  const parsedBody = updateSchema.safeParse(req.body);
  if (!parsedBody.success) {
    return res.status(400).json({
      error: "Body inválido",
      details: parsedBody.error.flatten()
    });
  }

  try {
    const row = await updateAdminBusinessUser({
      businessId,
      actor,
      id: parsedParams.data.id,
      ...parsedBody.data
    });
    return res.json(row);
  } catch (err) {
    if (handleManagementError(res, err)) return;
    throw err;
  }
}

export async function removeBusinessUser(req: Request, res: Response) {
  const businessId = req.user?.businessId;
  const actor = actorFromRequest(req);
  if (!businessId || !actor) {
    return res.status(401).json({ error: "No autenticado" });
  }

  const parsedParams = idParamSchema.safeParse(req.params);
  if (!parsedParams.success) {
    return res.status(400).json({ error: "id inválido" });
  }

  try {
    const row = await deleteAdminBusinessUser({
      businessId,
      actor,
      id: parsedParams.data.id
    });
    return res.json({ success: true, id: row.id });
  } catch (err) {
    if (handleManagementError(res, err)) return;
    throw err;
  }
}

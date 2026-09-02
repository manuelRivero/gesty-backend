import { prisma } from "../lib/prisma";
import { hashPassword } from "./auth.service";
import {
  type AssignableBusinessUserRole,
  type BusinessUserRole,
  isAssignableBusinessUserRole,
  parseBusinessUserRole
} from "../types/auth";

export type BusinessUserManagementCode =
  | "NOT_FOUND"
  | "ALREADY_MEMBER"
  | "FORBIDDEN_ROLE"
  | "CANNOT_TARGET_OWNER"
  | "CANNOT_MANAGE_SELF"
  | "LAST_OWNER"
  | "PASSWORD_REQUIRED";

export class BusinessUserManagementError extends Error {
  readonly code: BusinessUserManagementCode;

  constructor(code: BusinessUserManagementCode, message: string) {
    super(message);
    this.name = "BusinessUserManagementError";
    this.code = code;
  }
}

type MembershipRow = {
  id: string;
  user_id: string;
  business_id: string | null;
  role: string;
  created_at: Date | null;
  app_user: {
    id: string;
    email: string;
    name: string | null;
    created_at: Date | null;
  };
};

export type AdminBusinessUserDto = {
  id: string;
  userId: string;
  email: string;
  name: string | null;
  role: BusinessUserRole;
  createdAt: Date | null;
  userCreatedAt: Date | null;
};

export type AdminBusinessUserActor = {
  userId: string;
  role: BusinessUserRole;
};

const membershipInclude = {
  app_user: {
    select: { id: true, email: true, name: true, created_at: true }
  }
} as const;

function mapAdminBusinessUser(row: MembershipRow): AdminBusinessUserDto {
  return {
    id: row.id,
    userId: row.user_id,
    email: row.app_user.email,
    name: row.app_user.name,
    role: parseBusinessUserRole(row.role),
    createdAt: row.created_at,
    userCreatedAt: row.app_user.created_at
  };
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function normalizeName(name: string): string {
  return name.trim().replace(/\s+/g, " ");
}

function assertAssignableRole(role: string): AssignableBusinessUserRole {
  if (!isAssignableBusinessUserRole(role)) {
    throw new BusinessUserManagementError(
      "FORBIDDEN_ROLE",
      "Rol no asignable en el negocio"
    );
  }
  return role;
}

function assertActorCanAssignRole(
  actorRole: BusinessUserRole,
  targetRole: AssignableBusinessUserRole
): void {
  if (actorRole === "OWNER") return;
  if (actorRole === "ADMIN" && targetRole !== "OWNER") return;
  throw new BusinessUserManagementError(
    "FORBIDDEN_ROLE",
    "No podés asignar ese rol"
  );
}

function assertActorCanManageTarget(
  actorRole: BusinessUserRole,
  targetRole: BusinessUserRole
): void {
  if (targetRole === "SUPER_ADMIN") {
    throw new BusinessUserManagementError(
      "FORBIDDEN_ROLE",
      "No se puede gestionar esa membresía"
    );
  }
  if (actorRole === "OWNER") return;
  if (actorRole === "ADMIN" && targetRole !== "OWNER") return;
  throw new BusinessUserManagementError(
    "CANNOT_TARGET_OWNER",
    "Un ADMIN no puede gestionar un OWNER"
  );
}

async function countOwners(businessId: string): Promise<number> {
  return prisma.business_user.count({
    where: { business_id: businessId, role: "OWNER" }
  });
}

async function findMembershipInBusiness(params: {
  businessId: string;
  id: string;
}): Promise<MembershipRow | null> {
  const row = await prisma.business_user.findFirst({
    where: {
      id: params.id,
      business_id: params.businessId
    },
    include: membershipInclude
  });
  return row as MembershipRow | null;
}

export async function listAdminBusinessUsers(params: {
  businessId: string;
}): Promise<AdminBusinessUserDto[]> {
  const rows = await prisma.business_user.findMany({
    where: { business_id: params.businessId },
    include: membershipInclude,
    orderBy: [{ created_at: "asc" }]
  });
  return (rows as MembershipRow[]).map(mapAdminBusinessUser);
}

export async function getAdminBusinessUserById(params: {
  businessId: string;
  id: string;
}): Promise<AdminBusinessUserDto | null> {
  const row = await findMembershipInBusiness(params);
  return row ? mapAdminBusinessUser(row) : null;
}

export async function createAdminBusinessUser(params: {
  businessId: string;
  actor: AdminBusinessUserActor;
  email: string;
  name: string;
  role: string;
  password?: string;
}): Promise<AdminBusinessUserDto> {
  const role = assertAssignableRole(params.role);
  assertActorCanAssignRole(params.actor.role, role);

  const email = normalizeEmail(params.email);
  const name = normalizeName(params.name);
  const existingUser = await prisma.appUser.findUnique({
    where: { email }
  });

  if (existingUser) {
    const already = await prisma.business_user.findFirst({
      where: {
        user_id: existingUser.id,
        business_id: params.businessId
      },
      select: { id: true }
    });
    if (already) {
      throw new BusinessUserManagementError(
        "ALREADY_MEMBER",
        "El usuario ya pertenece a este negocio"
      );
    }

    await prisma.appUser.update({
      where: { id: existingUser.id },
      data: { name }
    });

    const row = await prisma.business_user.create({
      data: {
        user_id: existingUser.id,
        business_id: params.businessId,
        role
      },
      include: membershipInclude
    });
    return mapAdminBusinessUser(row as MembershipRow);
  }

  const password = params.password?.trim() ?? "";
  if (password.length < 8) {
    throw new BusinessUserManagementError(
      "PASSWORD_REQUIRED",
      "La contraseña es obligatoria (mínimo 8 caracteres) para un usuario nuevo"
    );
  }

  const passwordHash = await hashPassword(password);
  const row = await prisma.$transaction(async (tx) => {
    const user = await tx.appUser.create({
      data: {
        email,
        name,
        password_hash: passwordHash
      }
    });
    return tx.business_user.create({
      data: {
        user_id: user.id,
        business_id: params.businessId,
        role
      },
      include: membershipInclude
    });
  });

  return mapAdminBusinessUser(row as MembershipRow);
}

export async function updateAdminBusinessUser(params: {
  businessId: string;
  actor: AdminBusinessUserActor;
  id: string;
  name?: string;
  role?: string;
  password?: string;
}): Promise<AdminBusinessUserDto> {
  const existing = await findMembershipInBusiness({
    businessId: params.businessId,
    id: params.id
  });
  if (!existing) {
    throw new BusinessUserManagementError(
      "NOT_FOUND",
      "Usuario no encontrado"
    );
  }

  const currentRole = parseBusinessUserRole(existing.role);
  assertActorCanManageTarget(params.actor.role, currentRole);

  const nextRole =
    params.role !== undefined ? assertAssignableRole(params.role) : undefined;

  if (nextRole !== undefined) {
    if (existing.user_id === params.actor.userId) {
      throw new BusinessUserManagementError(
        "CANNOT_MANAGE_SELF",
        "No podés cambiar tu propio rol"
      );
    }
    assertActorCanAssignRole(params.actor.role, nextRole);
    if (currentRole === "OWNER" && nextRole !== "OWNER") {
      const owners = await countOwners(params.businessId);
      if (owners <= 1) {
        throw new BusinessUserManagementError(
          "LAST_OWNER",
          "No se puede quitar el último OWNER del negocio"
        );
      }
    }
  }

  const password = params.password?.trim();
  if (password !== undefined && password.length > 0 && password.length < 8) {
    throw new BusinessUserManagementError(
      "PASSWORD_REQUIRED",
      "La contraseña debe tener al menos 8 caracteres"
    );
  }

  const passwordHash = password ? await hashPassword(password) : null;
  const nextName =
    params.name !== undefined ? normalizeName(params.name) : undefined;

  const row = await prisma.$transaction(async (tx) => {
    const userUpdate: { password_hash?: string; name?: string } = {};
    if (passwordHash) userUpdate.password_hash = passwordHash;
    if (nextName !== undefined) userUpdate.name = nextName;
    if (Object.keys(userUpdate).length > 0) {
      await tx.appUser.update({
        where: { id: existing.user_id },
        data: userUpdate
      });
    }
    return tx.business_user.update({
      where: { id: existing.id },
      data: nextRole !== undefined ? { role: nextRole } : {},
      include: membershipInclude
    });
  });

  return mapAdminBusinessUser(row as MembershipRow);
}

export async function deleteAdminBusinessUser(params: {
  businessId: string;
  actor: AdminBusinessUserActor;
  id: string;
}): Promise<{ id: string }> {
  const existing = await findMembershipInBusiness({
    businessId: params.businessId,
    id: params.id
  });
  if (!existing) {
    throw new BusinessUserManagementError(
      "NOT_FOUND",
      "Usuario no encontrado"
    );
  }

  if (existing.user_id === params.actor.userId) {
    throw new BusinessUserManagementError(
      "CANNOT_MANAGE_SELF",
      "No podés eliminarte a vos mismo"
    );
  }

  const currentRole = parseBusinessUserRole(existing.role);
  assertActorCanManageTarget(params.actor.role, currentRole);

  if (currentRole === "OWNER") {
    const owners = await countOwners(params.businessId);
    if (owners <= 1) {
      throw new BusinessUserManagementError(
        "LAST_OWNER",
        "No se puede quitar el último OWNER del negocio"
      );
    }
  }

  await prisma.business_user.delete({
    where: { id: existing.id }
  });

  return { id: existing.id };
}

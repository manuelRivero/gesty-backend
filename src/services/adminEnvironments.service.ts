import { prisma } from "../lib/prisma";

type EnvironmentRow = {
  id: string;
  business_id: string;
  name: string;
  description: string | null;
  is_outdoor: boolean | null;
  is_active: boolean | null;
  created_at: Date | null;
};

function mapAdminEnvironment(row: EnvironmentRow) {
  return {
    id: row.id,
    businessId: row.business_id,
    name: row.name,
    description: row.description,
    isOutdoor: row.is_outdoor ?? false,
    isActive: row.is_active ?? true,
    createdAt: row.created_at
  };
}

export type AdminEnvironmentDto = ReturnType<typeof mapAdminEnvironment>;

export async function listAdminEnvironments(params: {
  businessId: string;
}): Promise<AdminEnvironmentDto[]> {
  const rows = await prisma.environment.findMany({
    where: { business_id: params.businessId },
    orderBy: { name: "asc" }
  });
  return rows.map((row) => mapAdminEnvironment(row as EnvironmentRow));
}

export async function getAdminEnvironmentById(params: {
  businessId: string;
  id: string;
}): Promise<AdminEnvironmentDto | null> {
  const row = await prisma.environment.findFirst({
    where: {
      id: params.id,
      business_id: params.businessId
    }
  });
  return row ? mapAdminEnvironment(row as EnvironmentRow) : null;
}

export async function createAdminEnvironment(params: {
  businessId: string;
  name: string;
  description?: string | null;
  isOutdoor?: boolean;
  isActive?: boolean;
}): Promise<AdminEnvironmentDto> {
  const row = await prisma.environment.create({
    data: {
      business_id: params.businessId,
      name: params.name,
      ...(params.description !== undefined
        ? { description: params.description }
        : {}),
      is_outdoor: params.isOutdoor ?? false,
      is_active: params.isActive ?? true
    }
  });
  return mapAdminEnvironment(row as EnvironmentRow);
}

export async function updateAdminEnvironment(params: {
  businessId: string;
  id: string;
  name?: string;
  description?: string | null;
  isOutdoor?: boolean;
  isActive?: boolean;
}): Promise<AdminEnvironmentDto | null> {
  const existing = await prisma.environment.findFirst({
    where: {
      id: params.id,
      business_id: params.businessId
    },
    select: { id: true }
  });
  if (!existing) return null;

  const row = await prisma.environment.update({
    where: { id: params.id },
    data: {
      ...(params.name !== undefined ? { name: params.name } : {}),
      ...(params.description !== undefined
        ? { description: params.description }
        : {}),
      ...(params.isOutdoor !== undefined ? { is_outdoor: params.isOutdoor } : {}),
      ...(params.isActive !== undefined ? { is_active: params.isActive } : {})
    }
  });
  return mapAdminEnvironment(row as EnvironmentRow);
}

/** Baja lógica: `is_active = false` (preserva vínculos con mesas y reservas). */
export async function deleteAdminEnvironment(params: {
  businessId: string;
  id: string;
}): Promise<{ id: string } | null> {
  const existing = await prisma.environment.findFirst({
    where: {
      id: params.id,
      business_id: params.businessId
    },
    select: { id: true }
  });
  if (!existing) return null;

  await prisma.environment.update({
    where: { id: params.id },
    data: { is_active: false }
  });
  return { id: params.id };
}

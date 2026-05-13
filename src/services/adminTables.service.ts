import { prisma } from "../lib/prisma";

type TableWithEnvironment = {
  id: string;
  business_id: string;
  environment_id: string;
  name: string;
  capacity: number;
  is_active: boolean | null;
  created_at: Date | null;
  x: number | null;
  y: number | null;
  shape: string | null;
  width: number | null;
  height: number | null;
  rotation: number | null;
  environment: { id: string; name: string };
};

function mapAdminTable(row: TableWithEnvironment) {
  return {
    id: row.id,
    businessId: row.business_id,
    environmentId: row.environment_id,
    environmentName: row.environment.name,
    name: row.name,
    capacity: row.capacity,
    isActive: row.is_active ?? true,
    createdAt: row.created_at,
    x: row.x,
    y: row.y,
    shape: row.shape,
    width: row.width,
    height: row.height,
    rotation: row.rotation
  };
}

const tableInclude = {
  environment: { select: { id: true, name: true } }
} as const;

export type AdminTableDto = ReturnType<typeof mapAdminTable>;

export async function listAdminTables(params: { businessId: string }) {
  const rows = await prisma.table.findMany({
    where: { business_id: params.businessId },
    include: tableInclude,
    orderBy: [
      { environment: { name: "asc" } },
      { name: "asc" },
      { capacity: "asc" }
    ]
  });
  return rows.map((row) => mapAdminTable(row as TableWithEnvironment));
}

export async function getAdminTableById(params: {
  businessId: string;
  id: string;
}): Promise<AdminTableDto | null> {
  const row = await prisma.table.findFirst({
    where: {
      id: params.id,
      business_id: params.businessId
    },
    include: tableInclude
  });
  return row ? mapAdminTable(row as TableWithEnvironment) : null;
}

async function assertEnvironmentInBusiness(
  businessId: string,
  environmentId: string
): Promise<boolean> {
  const env = await prisma.environment.findFirst({
    where: {
      id: environmentId,
      business_id: businessId
    },
    select: { id: true }
  });
  return Boolean(env);
}

export async function createAdminTable(params: {
  businessId: string;
  environmentId: string;
  name: string;
  capacity: number;
  isActive?: boolean;
  x?: number | null;
  y?: number | null;
  shape?: string | null;
  width?: number | null;
  height?: number | null;
  rotation?: number | null;
}): Promise<AdminTableDto | "ENVIRONMENT_NOT_FOUND"> {
  const ok = await assertEnvironmentInBusiness(
    params.businessId,
    params.environmentId
  );
  if (!ok) {
    return "ENVIRONMENT_NOT_FOUND";
  }

  const row = await prisma.table.create({
    data: {
      business_id: params.businessId,
      environment_id: params.environmentId,
      name: params.name,
      capacity: params.capacity,
      is_active: params.isActive ?? true,
      ...(params.x !== undefined ? { x: params.x } : {}),
      ...(params.y !== undefined ? { y: params.y } : {}),
      ...(params.shape !== undefined ? { shape: params.shape } : {}),
      ...(params.width !== undefined ? { width: params.width } : {}),
      ...(params.height !== undefined ? { height: params.height } : {}),
      ...(params.rotation !== undefined ? { rotation: params.rotation } : {})
    },
    include: tableInclude
  });
  return mapAdminTable(row as TableWithEnvironment);
}

export async function updateAdminTable(params: {
  businessId: string;
  id: string;
  environmentId?: string;
  name?: string;
  capacity?: number;
  isActive?: boolean;
  x?: number | null;
  y?: number | null;
  shape?: string | null;
  width?: number | null;
  height?: number | null;
  rotation?: number | null;
}): Promise<AdminTableDto | null | "ENVIRONMENT_NOT_FOUND"> {
  const existing = await prisma.table.findFirst({
    where: {
      id: params.id,
      business_id: params.businessId
    },
    select: { id: true }
  });
  if (!existing) {
    return null;
  }

  if (params.environmentId !== undefined) {
    const ok = await assertEnvironmentInBusiness(
      params.businessId,
      params.environmentId
    );
    if (!ok) {
      return "ENVIRONMENT_NOT_FOUND";
    }
  }

  const row = await prisma.table.update({
    where: { id: params.id },
    data: {
      ...(params.environmentId !== undefined
        ? { environment_id: params.environmentId }
        : {}),
      ...(params.name !== undefined ? { name: params.name } : {}),
      ...(params.capacity !== undefined ? { capacity: params.capacity } : {}),
      ...(params.isActive !== undefined ? { is_active: params.isActive } : {}),
      ...(params.x !== undefined ? { x: params.x } : {}),
      ...(params.y !== undefined ? { y: params.y } : {}),
      ...(params.shape !== undefined ? { shape: params.shape } : {}),
      ...(params.width !== undefined ? { width: params.width } : {}),
      ...(params.height !== undefined ? { height: params.height } : {}),
      ...(params.rotation !== undefined ? { rotation: params.rotation } : {})
    },
    include: tableInclude
  });
  return mapAdminTable(row as TableWithEnvironment);
}

/** Baja lógica: `is_active = false` (preserva vínculos con reservas). */
export async function deleteAdminTable(params: {
  businessId: string;
  id: string;
}): Promise<{ id: string } | null> {
  const existing = await prisma.table.findFirst({
    where: {
      id: params.id,
      business_id: params.businessId
    },
    select: { id: true }
  });
  if (!existing) {
    return null;
  }

  await prisma.table.update({
    where: { id: params.id },
    data: { is_active: false }
  });
  return { id: params.id };
}

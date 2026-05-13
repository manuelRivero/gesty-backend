import { prisma } from "../lib/prisma";

type BusinessHourRow = {
  id: string;
  business_id: string;
  day_of_week: number;
  opens_at: string;
  closes_at: string;
  is_closed: boolean;
  created_at: Date;
};

function mapBusinessHour(row: BusinessHourRow) {
  return {
    id: row.id,
    businessId: row.business_id,
    dayOfWeek: row.day_of_week,
    opensAt: row.opens_at,
    closesAt: row.closes_at,
    isClosed: row.is_closed,
    createdAt: row.created_at
  };
}

export type AdminBusinessHourDto = ReturnType<typeof mapBusinessHour>;

export async function listAdminBusinessHours(params: { businessId: string }) {
  const rows = await prisma.business_hours.findMany({
    where: { business_id: params.businessId },
    orderBy: [{ day_of_week: "asc" }, { opens_at: "asc" }, { created_at: "asc" }]
  });

  return rows.map((row) => mapBusinessHour(row as BusinessHourRow));
}

export async function getAdminBusinessHourById(params: {
  businessId: string;
  id: string;
}): Promise<AdminBusinessHourDto | null> {
  const row = await prisma.business_hours.findFirst({
    where: {
      id: params.id,
      business_id: params.businessId
    }
  });

  return row ? mapBusinessHour(row as BusinessHourRow) : null;
}

export async function createAdminBusinessHour(params: {
  businessId: string;
  dayOfWeek: number;
  opensAt: string;
  closesAt: string;
  isClosed?: boolean;
}): Promise<AdminBusinessHourDto> {
  const row = await prisma.business_hours.create({
    data: {
      business_id: params.businessId,
      day_of_week: params.dayOfWeek,
      opens_at: params.opensAt,
      closes_at: params.closesAt,
      is_closed: params.isClosed ?? false
    }
  });

  return mapBusinessHour(row as BusinessHourRow);
}

export async function updateAdminBusinessHour(params: {
  businessId: string;
  id: string;
  dayOfWeek?: number;
  opensAt?: string;
  closesAt?: string;
  isClosed?: boolean;
}): Promise<AdminBusinessHourDto | null> {
  const existing = await prisma.business_hours.findFirst({
    where: {
      id: params.id,
      business_id: params.businessId
    },
    select: { id: true }
  });

  if (!existing) {
    return null;
  }

  const row = await prisma.business_hours.update({
    where: { id: params.id },
    data: {
      ...(params.dayOfWeek !== undefined ? { day_of_week: params.dayOfWeek } : {}),
      ...(params.opensAt !== undefined ? { opens_at: params.opensAt } : {}),
      ...(params.closesAt !== undefined ? { closes_at: params.closesAt } : {}),
      ...(params.isClosed !== undefined ? { is_closed: params.isClosed } : {})
    }
  });

  return mapBusinessHour(row as BusinessHourRow);
}

export async function deleteAdminBusinessHour(params: {
  businessId: string;
  id: string;
}): Promise<{ id: string } | null> {
  const existing = await prisma.business_hours.findFirst({
    where: {
      id: params.id,
      business_id: params.businessId
    },
    select: { id: true }
  });

  if (!existing) {
    return null;
  }

  await prisma.business_hours.delete({
    where: { id: params.id }
  });

  return { id: params.id };
}

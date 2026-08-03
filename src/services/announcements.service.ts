import { prisma } from "../lib/prisma";
import { sanitizeAnnouncementHtml } from "../utils/sanitizeAnnouncementHtml";
import type { BusinessUserRole } from "../types/auth";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CreateAnnouncementParams {
  title: string;
  bodyHtml: string;
  targetRoles: string[];
  publishedAt: Date;
  expiresAt?: Date | null;
  createdBy: string;
}

export interface UpdateAnnouncementParams {
  id: string;
  title?: string;
  bodyHtml?: string;
  targetRoles?: string[];
  publishedAt?: Date;
  expiresAt?: Date | null;
  isActive?: boolean;
}

export interface ListSuperAdminParams {
  page: number;
  pageSize: number;
  active?: boolean;
}

export interface InboxParams {
  role: BusinessUserRole;
  userId: string;
  businessId: string;
  page: number;
  pageSize: number;
}

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

function mapAnnouncement(row: {
  id: string;
  title: string;
  body_html: string;
  target_roles: string[];
  media_key: string | null;
  media_url: string | null;
  media_type: string | null;
  media_mime: string | null;
  published_at: Date;
  expires_at: Date | null;
  is_active: boolean;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}) {
  return {
    id: row.id,
    title: row.title,
    bodyHtml: row.body_html,
    targetRoles: row.target_roles,
    media: row.media_url
      ? {
          key: row.media_key,
          url: row.media_url,
          type: row.media_type,
          mime: row.media_mime,
        }
      : null,
    publishedAt: row.published_at,
    expiresAt: row.expires_at,
    isActive: row.is_active,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapRead(row: {
  id: string;
  announcement_id: string;
  user_id: string;
  business_id: string;
  read_at: Date;
}) {
  return {
    id: row.id,
    announcementId: row.announcement_id,
    userId: row.user_id,
    businessId: row.business_id,
    readAt: row.read_at,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function vigorFilter(now: Date) {
  return {
    is_active: true,
    published_at: { lte: now },
    OR: [{ expires_at: null }, { expires_at: { gt: now } }],
  };
}

// ---------------------------------------------------------------------------
// Super-admin CRUD
// ---------------------------------------------------------------------------

export async function createAnnouncement(params: CreateAnnouncementParams) {
  const row = await prisma.announcement.create({
    data: {
      title: params.title.trim(),
      body_html: sanitizeAnnouncementHtml(params.bodyHtml),
      target_roles: params.targetRoles,
      published_at: params.publishedAt,
      expires_at: params.expiresAt ?? null,
      created_by: params.createdBy,
    },
  });
  return mapAnnouncement(row);
}

export async function updateAnnouncement(params: UpdateAnnouncementParams) {
  const data: Record<string, unknown> = {};
  if (params.title !== undefined) data.title = params.title.trim();
  if (params.bodyHtml !== undefined) data.body_html = sanitizeAnnouncementHtml(params.bodyHtml);
  if (params.targetRoles !== undefined) data.target_roles = params.targetRoles;
  if (params.publishedAt !== undefined) data.published_at = params.publishedAt;
  if ("expiresAt" in params) data.expires_at = params.expiresAt ?? null;
  if (params.isActive !== undefined) data.is_active = params.isActive;

  const row = await prisma.announcement.update({
    where: { id: params.id },
    data,
  });
  return mapAnnouncement(row);
}

export async function softDeleteAnnouncement(id: string) {
  return prisma.announcement.update({
    where: { id },
    data: { is_active: false },
  });
}

export async function getAnnouncementById(id: string) {
  const row = await prisma.announcement.findUnique({ where: { id } });
  if (!row) return null;
  return mapAnnouncement(row);
}

export async function listAnnouncementsSuperAdmin(params: ListSuperAdminParams) {
  const where: Record<string, unknown> = {};
  if (params.active !== undefined) where.is_active = params.active;

  const [rows, total] = await Promise.all([
    prisma.announcement.findMany({
      where,
      orderBy: { published_at: "desc" },
      skip: (params.page - 1) * params.pageSize,
      take: params.pageSize,
    }),
    prisma.announcement.count({ where }),
  ]);

  return {
    items: rows.map(mapAnnouncement),
    total,
    page: params.page,
    pageSize: params.pageSize,
    totalPages: Math.ceil(total / params.pageSize),
  };
}

// ---------------------------------------------------------------------------
// Business inbox
// ---------------------------------------------------------------------------

export async function listAnnouncementsForBusiness(params: InboxParams) {
  const now = new Date();
  const roleFilter =
    params.role !== "OWNER"
      ? { target_roles: { has: params.role } }
      : {};

  const where = { ...vigorFilter(now), ...roleFilter };

  const [rows, total] = await Promise.all([
    prisma.announcement.findMany({
      where,
      orderBy: { published_at: "desc" },
      skip: (params.page - 1) * params.pageSize,
      take: params.pageSize,
      include: {
        reads: {
          where: {
            user_id: params.userId,
            business_id: params.businessId,
          },
          select: { read_at: true },
        },
      },
    }),
    prisma.announcement.count({ where }),
  ]);

  return {
    items: rows.map((row) => ({
      ...mapAnnouncement(row),
      isRead: row.reads.length > 0,
      readAt: row.reads[0]?.read_at ?? null,
    })),
    total,
    page: params.page,
    pageSize: params.pageSize,
    totalPages: Math.ceil(total / params.pageSize),
  };
}

export async function getAnnouncementForBusiness(params: {
  id: string;
  role: BusinessUserRole;
  userId: string;
  businessId: string;
}) {
  const now = new Date();
  const roleFilter =
    params.role !== "OWNER"
      ? { target_roles: { has: params.role } }
      : {};

  const row = await prisma.announcement.findFirst({
    where: {
      id: params.id,
      ...vigorFilter(now),
      ...roleFilter,
    },
    include: {
      reads: {
        where: {
          user_id: params.userId,
          business_id: params.businessId,
        },
        select: { read_at: true },
      },
    },
  });

  if (!row) return null;

  return {
    ...mapAnnouncement(row),
    isRead: row.reads.length > 0,
    readAt: row.reads[0]?.read_at ?? null,
  };
}

export async function getUnreadCount(params: {
  role: BusinessUserRole;
  userId: string;
  businessId: string;
}): Promise<number> {
  const now = new Date();
  const roleFilter =
    params.role !== "OWNER"
      ? { target_roles: { has: params.role } }
      : {};

  const all = await prisma.announcement.findMany({
    where: { ...vigorFilter(now), ...roleFilter },
    select: {
      id: true,
      reads: {
        where: { user_id: params.userId, business_id: params.businessId },
        select: { id: true },
      },
    },
  });

  return all.filter((a) => a.reads.length === 0).length;
}

/** Idempotente: si ya existe no lanza error. */
export async function markAnnouncementRead(params: {
  announcementId: string;
  userId: string;
  businessId: string;
}) {
  try {
    const row = await prisma.announcement_read.create({
      data: {
        announcement_id: params.announcementId,
        user_id: params.userId,
        business_id: params.businessId,
      },
    });
    return mapRead(row);
  } catch (err: unknown) {
    // unique constraint violation → ya leído
    if ((err as { code?: string }).code === "P2002") {
      const existing = await prisma.announcement_read.findFirst({
        where: {
          announcement_id: params.announcementId,
          user_id: params.userId,
          business_id: params.businessId,
        },
      });
      if (existing) return mapRead(existing);
    }
    throw err;
  }
}

/** Lectores de un anuncio filtrados por business (para OWNER/ADMIN). */
export async function getReadersByBusiness(params: {
  announcementId: string;
  businessId: string;
}) {
  const rows = await prisma.announcement_read.findMany({
    where: {
      announcement_id: params.announcementId,
      business_id: params.businessId,
    },
    orderBy: { read_at: "asc" },
  });
  return rows.map(mapRead);
}

/**
 * Respuestas rápidas (canned) a nivel business (Fase C).
 * El envío al cliente sigue siendo POST …/messages.
 */

import { prisma } from "../lib/prisma";

export type CannedReplyDto = {
  id: string;
  title: string;
  body: string;
  position: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

export type CannedReplyCode = "NOT_FOUND";

export class CannedReplyError extends Error {
  readonly code: CannedReplyCode;

  constructor(code: CannedReplyCode, message: string) {
    super(message);
    this.name = "CannedReplyError";
    this.code = code;
  }
}

function toDto(row: {
  id: string;
  title: string;
  body: string;
  position: number;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}): CannedReplyDto {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    position: row.position,
    isActive: row.is_active,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

export async function listCannedReplies(params: {
  businessId: string;
  includeInactive?: boolean;
}): Promise<CannedReplyDto[]> {
  const rows = await prisma.canned_reply.findMany({
    where: {
      business_id: params.businessId,
      ...(params.includeInactive ? {} : { is_active: true })
    },
    orderBy: [{ position: "asc" }, { created_at: "asc" }]
  });
  return rows.map(toDto);
}

export async function createCannedReply(params: {
  businessId: string;
  title: string;
  body: string;
  position?: number;
}): Promise<CannedReplyDto> {
  const created = await prisma.canned_reply.create({
    data: {
      business_id: params.businessId,
      title: params.title,
      body: params.body,
      position: params.position ?? 0
    }
  });
  return toDto(created);
}

export async function updateCannedReply(params: {
  businessId: string;
  id: string;
  title?: string;
  body?: string;
  position?: number;
  isActive?: boolean;
}): Promise<CannedReplyDto> {
  const existing = await prisma.canned_reply.findFirst({
    where: { id: params.id, business_id: params.businessId },
    select: { id: true }
  });
  if (!existing) {
    throw new CannedReplyError("NOT_FOUND", "Respuesta rápida no encontrada");
  }

  const updated = await prisma.canned_reply.update({
    where: { id: params.id },
    data: {
      ...(params.title !== undefined ? { title: params.title } : {}),
      ...(params.body !== undefined ? { body: params.body } : {}),
      ...(params.position !== undefined ? { position: params.position } : {}),
      ...(params.isActive !== undefined ? { is_active: params.isActive } : {}),
      updated_at: new Date()
    }
  });
  return toDto(updated);
}

export async function deleteCannedReply(params: {
  businessId: string;
  id: string;
}): Promise<void> {
  const result = await prisma.canned_reply.deleteMany({
    where: { id: params.id, business_id: params.businessId }
  });
  if (result.count === 0) {
    throw new CannedReplyError("NOT_FOUND", "Respuesta rápida no encontrada");
  }
}

import type { business } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { coerceIanaTimezone } from '../services/reservations/clock';

export const findBusinessByPhoneNumberId = async (
  phoneNumberId: string
): Promise<business | null> => {
  return prisma.business.findFirst({
    where: { whatsapp_phone_id: phoneNumberId }
  });
};

export const findBusinessById = async (businessId: string): Promise<business | null> => {
  return prisma.business.findUnique({
    where: { id: businessId }
  });
};

export const findBusinessTimezone = async (businessId: string): Promise<string> => {
  const row = await prisma.business.findUnique({
    where: { id: businessId },
    select: { timezone: true },
  });
  return coerceIanaTimezone(row?.timezone);
};

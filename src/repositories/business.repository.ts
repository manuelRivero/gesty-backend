import type { business } from '@prisma/client';
import { prisma } from '../lib/prisma';

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

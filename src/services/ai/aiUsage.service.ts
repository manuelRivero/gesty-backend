import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import type { business } from '@prisma/client';
import { prisma } from '../../lib/prisma';

dayjs.extend(utc);

export const resetIfNeeded = async (business: business): Promise<business> => {
  if (!business.ai_reset_at) {
    return business;
  }

  const resetAt = dayjs.utc(business.ai_reset_at);
  const endOfMonth = resetAt.endOf('month');
  const nowUtc = dayjs.utc();

  if (nowUtc.isAfter(endOfMonth)) {
    const newResetAt = nowUtc.startOf('month').toDate();

    const updatedBusiness = await prisma.business.update({
      where: { id: business.id },
      data: {
        ai_monthly_tokens_used: 0,
        ai_reset_at: newResetAt,
        ai_blocked: false
      }
    });

    return updatedBusiness;
  }

  return business;
};

export const incrementUsage = async (
  businessId: string,
  tokensUsed: number
): Promise<void> => {
  if (tokensUsed <= 0) {
    throw new Error('tokensUsed debe ser mayor a 0');
  }

  try {
    await prisma.business.update({
      where: { id: businessId },
      data: {
        ai_monthly_tokens_used: {
          increment: tokensUsed
        }
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Error desconocido';
    throw new Error(`No se pudo incrementar el uso de tokens: ${message}`);
  }
};

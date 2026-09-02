import { prisma } from "../lib/prisma";

/**
 * Resuelve el id de membresía (`business_user.id`) del actor en el tenant actual.
 * El JWT trae `userId` + `businessId`, no el id de membresía.
 */
export async function getBusinessUserIdForActor(params: {
  userId: string;
  businessId: string;
}): Promise<string | null> {
  const row = await prisma.business_user.findFirst({
    where: {
      user_id: params.userId,
      business_id: params.businessId
    },
    select: { id: true }
  });
  return row?.id ?? null;
}

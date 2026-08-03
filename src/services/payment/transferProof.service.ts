/**
 * Derivador de dominio: ¿hay un pedido de este cliente esperando un
 * comprobante de transferencia?
 *
 * D1 (ver PLAN-ACCION-COMPROBANTES-TRANSFERENCIA.md): el gate de admisión de
 * imágenes es un Fact del dominio ("hay una orden reciente con
 * payment_method='transfer' y payment_status='unpaid'"), no un flag de
 * sesión. Esta función es pura sobre Facts: no lee ni escribe estado de
 * conversación.
 */

import { OrderStatus, Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { env } from '../../config/env';

export type OrderAwaitingTransferProof = {
  id: string;
  total_amount: Prisma.Decimal | null;
  created_at: Date;
};

/**
 * Devuelve la orden más reciente del cliente que cumple:
 * - `payment_method = 'transfer'`
 * - `payment_status = 'unpaid'`
 * - `status` no cancelado
 * - `created_at` dentro de `TRANSFER_PROOF_WINDOW_HOURS` (default 24)
 *
 * Si hay varias órdenes candidatas, se queda con la más reciente. No hay
 * desambiguación con el cliente: es fricción justo después de que pagó, y el
 * admin puede reasignar el comprobante desde el panel si hace falta.
 */
export const findOrderAwaitingTransferProof = async (params: {
  businessId: string;
  customerId: string;
  now?: Date;
}): Promise<OrderAwaitingTransferProof | null> => {
  const now = params.now ?? new Date();
  const windowHours = env.TRANSFER_PROOF_WINDOW_HOURS;
  const windowStart = new Date(now.getTime() - windowHours * 60 * 60 * 1000);

  const order = await prisma.orders.findFirst({
    where: {
      business_id: params.businessId,
      customer_id: params.customerId,
      payment_method: 'transfer',
      payment_status: 'unpaid',
      status: { not: OrderStatus.cancelled },
      created_at: { gte: windowStart, lte: now },
    },
    orderBy: { created_at: 'desc' },
    select: { id: true, total_amount: true, created_at: true },
  });

  return order;
};

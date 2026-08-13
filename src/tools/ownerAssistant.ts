/**
 * Tools de lectura del owner_assistant. Cero writes.
 *
 * El Constraint de identidad (teléfono ∈ allowlist) va declarado con
 * `withOwnerGate` — no adentro de cada `func` (agent-factory §3.10).
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import type { RunnableConfig } from '@langchain/core/runnables';
import { getReactContext } from './_context';
import { withGate } from './_withGate';
import { isOwnerAssistantEnabled } from '../config/env';
import { getBusinessConfig } from '../services/businessConfig.service';
import { isOwnerPhone } from '../services/ownerAssistant/matchOwnerPhone';
import {
  resolveOwnerPeriod,
  type OwnerPeriodPreset,
} from '../services/ownerAssistant/resolveOwnerPeriod';
import { getOwnerBriefing } from '../services/ownerAssistant/ownerBriefing.service';
import { getLiveOrdersSnapshot } from '../services/ownerAssistant/ownerOrdersSnapshot.service';
import { getOwnerOrderDetail } from '../services/ownerAssistant/ownerOrderDetail.service';
import { prisma } from '../lib/prisma';

const toJson = (data: unknown): string => JSON.stringify(data);

const withOwnerGate = withGate({
  assert: async (ctx) => {
    if (!isOwnerAssistantEnabled()) {
      return { error: 'owner_assistant_disabled' };
    }
    const cfg = await getBusinessConfig(ctx.businessId);
    if (!isOwnerPhone(ctx.customerPhone, cfg.owner_whatsapp_phones)) {
      return { error: 'owner_required', missing: 'owner' };
    }
    return null;
  },
});

const loadBusinessTz = async (businessId: string): Promise<string> => {
  const row = await prisma.business.findUnique({
    where: { id: businessId },
    select: { timezone: true },
  });
  return row?.timezone ?? 'America/Argentina/Buenos_Aires';
};

const periodSchema = z.object({
  period: z
    .enum(['today', 'yesterday', 'this_week', 'custom'])
    .default('today')
    .describe(
      'Período. today = default si el dueño no especifica. this_week = lunes a hoy. custom exige from y to.'
    ),
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe('YYYY-MM-DD. Solo para period=custom.'),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe('YYYY-MM-DD. Solo para period=custom.'),
});
type PeriodInput = z.infer<typeof periodSchema>;

export const getOwnerBriefingTool = withOwnerGate(
  new DynamicStructuredTool<typeof periodSchema, PeriodInput>({
    name: 'get_owner_briefing',
    description:
      'Resumen operativo del período (default hoy): pedidos, δ% vs período equivalente, estados, pagos, reservas, revenue, quejas (sentimiento FRUSTRATED/NEEDS_HUMAN) y pedidos en vuelo ahora. ' +
      'Usala para saludos, "cómo va", "resumen", "números de hoy/ayer/esta semana". headlineHints son ingredientes para una línea; no los leas en voz alta como JSON.',
    schema: periodSchema,
    func: async (input, _runManager, config?: RunnableConfig) => {
      const { businessId, customerId } = getReactContext(config);
      const tz = await loadBusinessTz(businessId);
      const period = resolveOwnerPeriod({
        period: (input.period ?? 'today') as OwnerPeriodPreset,
        from: input.from,
        to: input.to,
        tz,
      });
      if ('error' in period) return toJson(period);
      const briefing = await getOwnerBriefing({
        businessId,
        from: period.from,
        to: period.to,
        tz,
        excludeCustomerId: customerId,
      });
      return toJson({ ...briefing, periodPreset: period.preset });
    },
  })
);

const liveOrdersSchema = z.object({});
type LiveOrdersInput = z.infer<typeof liveOrdersSchema>;

export const getLiveOrdersTool = withOwnerGate(
  new DynamicStructuredTool<typeof liveOrdersSchema, LiveOrdersInput>({
    name: 'get_live_orders',
    description:
      'Cola operativa AHORA: pedidos en cola, cocina, listos para retirar o en camino. No filtra por fecha de creación. ' +
      'Usala cuando el dueño pregunta por envíos, cocina, "qué hay pendiente", "cómo van los deliveries".',
    schema: liveOrdersSchema,
    func: async (_input, _runManager, config?: RunnableConfig) => {
      const { businessId } = getReactContext(config);
      const snapshot = await getLiveOrdersSnapshot(businessId);
      return toJson(snapshot);
    },
  })
);

const orderDetailSchema = z.object({
  orderRef: z
    .string()
    .describe(
      'UUID del pedido o id corto (primeros 8 caracteres hex). Si el dueño dice "el de María", primero get_live_orders y de ahí sacá el id.'
    ),
});
type OrderDetailInput = z.infer<typeof orderDetailSchema>;

export const getOrderDetailTool = withOwnerGate(
  new DynamicStructuredTool<typeof orderDetailSchema, OrderDetailInput>({
    name: 'get_order_detail',
    description:
      'Detalle de UN pedido: ítems, dirección, pago, estado, tiempos. Pedilo cuando el dueño nombra un pedido concreto.',
    schema: orderDetailSchema,
    func: async ({ orderRef }, _runManager, config?: RunnableConfig) => {
      const { businessId } = getReactContext(config);
      const detail = await getOwnerOrderDetail(businessId, orderRef);
      return toJson(detail);
    },
  })
);

export const allOwnerAssistantTools = [
  getOwnerBriefingTool,
  getLiveOrdersTool,
  getOrderDetailTool,
];

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
import type { OwnerPeriodPreset } from '../services/ownerAssistant/resolveOwnerPeriod';
import { buildOwnerMetricsSnapshot } from '../services/ownerAssistant/buildOwnerMetricsSnapshot';
import { getLiveOrdersSnapshot } from '../services/ownerAssistant/ownerOrdersSnapshot.service';
import { getOwnerOrderDetail } from '../services/ownerAssistant/ownerOrderDetail.service';

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

const periodSchema = z.object({
  period: z
    .enum(['today', 'yesterday', 'this_week', 'custom'])
    .default('today')
    .describe(
      'Período. today = default si el dueño no especifica. this_week = lunes a ahora. custom exige from y to.'
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
  topProductsLimit: z
    .union([z.literal(1), z.literal(3)])
    .optional()
    .describe(
      'Cantidad de productos top por unidades. Default 1. Usá 3 solo si el dueño pide el top 3.'
    ),
});
type PeriodInput = z.infer<typeof periodSchema>;

export const getOwnerBriefingTool = withOwnerGate(
  new DynamicStructuredTool<typeof periodSchema, PeriodInput>({
    name: 'get_owner_briefing',
    description:
      'Snapshot de métricas V1 del período (default hoy): ventas, pedidos, ticket promedio, cancelaciones, producto más vendido, atención y pedidos en vuelo AHORA. ' +
      'Los totales, δ% y tasas ya vienen calculados: no los recalcules. ' +
      'Usala para saludos, "cómo va", "resumen", "números de hoy/ayer/esta semana", "qué se vendió más". ' +
      'historical = período pedido; live = ahora. No mezcles pedidos del período con en vuelo.',
    schema: periodSchema,
    func: async (input, _runManager, config?: RunnableConfig) => {
      const { businessId, customerId } = getReactContext(config);
      const snapshot = await buildOwnerMetricsSnapshot({
        businessId,
        period: (input.period ?? 'today') as OwnerPeriodPreset,
        from: input.from,
        to: input.to,
        topProductsLimit: input.topProductsLimit === 3 ? 3 : 1,
        excludeCustomerId: customerId,
      });
      return toJson(snapshot);
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
      'Usala cuando el dueño pregunta por envíos, cocina, "qué hay pendiente", "cómo van los deliveries". ' +
      'El conteo agregado ya viene en get_owner_briefing.live.inFlightOrders; esta tool es para el detalle/lista.',
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

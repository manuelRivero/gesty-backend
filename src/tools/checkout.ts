/**
 * Tools exclusivas del agente de checkout.
 *
 * Las tools-señal (`present_fulfillment_options`, `present_payment_options`,
 * `handback_to_main`) no producen UI directamente: devuelven un marcador
 * estructurado que el nodo `checkoutAgentNode` interpreta para adjuntar los
 * mensajes interactivos (botones) o delegar el turno de vuelta al flujo normal.
 *
 * Reutilizadas del toolset principal: `get_cart`, `save_customer_name`,
 * `save_delivery_address` (importadas desde `./index` y reexportadas).
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { getReactContext } from './_context';
import { patchConversationMetadata, omitConversationMetadataKeys } from '../repositories/conversationState.repository';
import { prisma } from '../lib/prisma';
import type { RunnableConfig } from '@langchain/core/runnables';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const toJson = (data: unknown): string => JSON.stringify(data);

/** Persiste el método de pago en el draft activo del cliente. */
export const setDraftPaymentMethod = async (
  businessId: string,
  customerPhone: string,
  method: 'cash' | 'online'
): Promise<{ success: boolean; error?: string }> => {
  const draft = await prisma.draft_order.findFirst({
    where: { business_id: businessId, customer_phone: customerPhone, status: 'active' },
    select: { id: true },
  });
  if (!draft) {
    return { success: false, error: 'no_active_cart' };
  }
  await prisma.draft_order.update({
    where: { id: draft.id },
    data: { payment_method: method },
  });
  return { success: true };
};

/** Lee el estado de fulfillment/payment del draft activo, para validación previa a una transición. */
export const getDraftCheckoutState = async (
  businessId: string,
  customerPhone: string
): Promise<{
  fulfillmentType: 'DELIVERY' | 'TAKE_AWAY' | null;
  paymentMethod: 'cash' | 'online' | null;
}> => {
  const draft = await prisma.draft_order.findFirst({
    where: { business_id: businessId, customer_phone: customerPhone, status: 'active' },
    select: { fulfillment_type: true, payment_method: true },
  });
  return {
    fulfillmentType: (draft?.fulfillment_type as 'DELIVERY' | 'TAKE_AWAY' | null) ?? null,
    paymentMethod: (draft?.payment_method as 'cash' | 'online' | null) ?? null,
  };
};

/** Persiste el tipo de entrega en el draft activo del cliente. */
export const setDraftFulfillmentType = async (
  businessId: string,
  customerPhone: string,
  type: 'DELIVERY' | 'TAKE_AWAY'
): Promise<{ success: boolean; error?: string }> => {
  const draft = await prisma.draft_order.findFirst({
    where: { business_id: businessId, customer_phone: customerPhone, status: 'active' },
    select: { id: true },
  });
  if (!draft) {
    return { success: false, error: 'no_active_cart' };
  }
  await prisma.$executeRaw`
    UPDATE draft_order
    SET fulfillment_type = ${type}::"FulfillmentType"
    WHERE id = ${draft.id}::uuid
  `;
  return { success: true };
};

// ---------------------------------------------------------------------------
// save_fulfillment_type
// ---------------------------------------------------------------------------

const saveFulfillmentTypeSchema = z.object({
  type: z
    .enum(['DELIVERY', 'TAKE_AWAY'])
    .describe(
      'DELIVERY = envío a domicilio ("en casa", "a domicilio", "delivery"). ' +
        'TAKE_AWAY = retiro en local ("retiro", "paso a buscar", "take away").'
    ),
});
type SaveFulfillmentTypeInput = z.infer<typeof saveFulfillmentTypeSchema>;

export const saveFulfillmentTypeTool = new DynamicStructuredTool<
  typeof saveFulfillmentTypeSchema,
  SaveFulfillmentTypeInput
>({
  name: 'save_fulfillment_type',
  description:
    'Guarda el tipo de entrega elegido por el cliente en texto libre durante el checkout. ' +
    'Llamá esta tool cuando el cliente indique cómo quiere recibir el pedido: ' +
    '"en casa", "a domicilio", "delivery" → DELIVERY; ' +
    '"retiro", "paso a buscar", "take away", "retiro en local" → TAKE_AWAY. ' +
    'Solo usar en sesión de checkout cuando fulfillment_type aún no está definido o el cliente cambia de opinión.',
  schema: saveFulfillmentTypeSchema,
  func: async ({ type }: SaveFulfillmentTypeInput, _runManager, config?: RunnableConfig) => {
    const { businessId, customerPhone, conversationId } = getReactContext(config);
    const result = await setDraftFulfillmentType(businessId, customerPhone, type);
    if (!result.success) {
      return toJson({ success: false, error: result.error });
    }
    await omitConversationMetadataKeys(conversationId, [
      'checkout_pending_action',
      'checkout_pending_question',
    ]);
    return toJson({ success: true, fulfillmentType: type });
  },
});

// ---------------------------------------------------------------------------
// present_fulfillment_options
// ---------------------------------------------------------------------------

const presentFulfillmentOptionsSchema = z.object({});
type PresentFulfillmentOptionsInput = z.infer<typeof presentFulfillmentOptionsSchema>;

/**
 * Señal para que el nodo adjunte los botones de selección de tipo de entrega
 * (Delivery / Retiro en local). El agente NO escribe los botones: solo llama
 * esta tool y el nodo orquestador adjunta la UI determinística.
 */
export const presentFulfillmentOptionsTool = new DynamicStructuredTool<
  typeof presentFulfillmentOptionsSchema,
  PresentFulfillmentOptionsInput
>({
  name: 'present_fulfillment_options',
  description:
    'Muestra al cliente los botones para elegir el tipo de entrega (delivery o retiro en local). ' +
    'Llamá esta tool cuando el cliente aún no eligió cómo quiere recibir su pedido y ambas opciones están disponibles. ' +
    'No escribas los botones en el texto: esta tool los adjunta automáticamente.',
  schema: presentFulfillmentOptionsSchema,
  func: async (_input: PresentFulfillmentOptionsInput, _runManager, config?: RunnableConfig) => {
    getReactContext(config); // validar contexto
    return toJson({ signal: 'present_fulfillment_options' });
  },
});

// ---------------------------------------------------------------------------
// save_payment_method
// ---------------------------------------------------------------------------

const savePaymentMethodSchema = z.object({
  method: z
    .enum(['cash', 'online'])
    .describe(
      'cash = efectivo, en mano, pago al recibir. ' +
        'online = tarjeta, Mercado Pago, pago online, transferencia digital.'
    ),
});
type SavePaymentMethodInput = z.infer<typeof savePaymentMethodSchema>;

export const savePaymentMethodTool = new DynamicStructuredTool<
  typeof savePaymentMethodSchema,
  SavePaymentMethodInput
>({
  name: 'save_payment_method',
  description:
    'Guarda el método de pago elegido por el cliente en texto libre durante el checkout. ' +
    'Llamá esta tool cuando el cliente indique cómo quiere pagar: ' +
    '"efectivo", "en efectivo", "cash" → cash; ' +
    '"online", "tarjeta", "mercado pago", "con tarjeta" → online. ' +
    'Solo usar cuando ya están completos tipo de entrega, dirección (si aplica) y nombre.',
  schema: savePaymentMethodSchema,
  func: async ({ method }: SavePaymentMethodInput, _runManager, config?: RunnableConfig) => {
    const { businessId, customerPhone } = getReactContext(config);
    const result = await setDraftPaymentMethod(businessId, customerPhone, method);
    if (!result.success) {
      return toJson({ success: false, error: result.error });
    }
    return toJson({
      success: true,
      paymentMethod: method,
      signal: 'payment_method_saved',
    });
  },
});

// ---------------------------------------------------------------------------
// present_payment_options
// ---------------------------------------------------------------------------

const presentPaymentOptionsSchema = z.object({});
type PresentPaymentOptionsInput = z.infer<typeof presentPaymentOptionsSchema>;

/**
 * Señal para que el nodo adjunte los botones de método de pago
 * (Pago online / Efectivo). Solo llamar cuando todos los datos obligatorios
 * ya fueron completados (tipo de entrega, dirección si aplica, nombre si se puede).
 */
export const presentPaymentOptionsTool = new DynamicStructuredTool<
  typeof presentPaymentOptionsSchema,
  PresentPaymentOptionsInput
>({
  name: 'present_payment_options',
  description:
    'Muestra al cliente los botones de método de pago (online o efectivo) para finalizar el pedido. ' +
    'Solo llamá esta tool cuando ya tenés: tipo de entrega definido, dirección (si es delivery), y nombre (si disponible). ' +
    'No escribas los botones en el texto: esta tool los adjunta automáticamente.',
  schema: presentPaymentOptionsSchema,
  func: async (_input: PresentPaymentOptionsInput, _runManager, config?: RunnableConfig) => {
    getReactContext(config); // validar contexto
    return toJson({ signal: 'present_payment_options' });
  },
});

// ---------------------------------------------------------------------------
// mark_name_refused
// ---------------------------------------------------------------------------

const markNameRefusedSchema = z.object({});
type MarkNameRefusedInput = z.infer<typeof markNameRefusedSchema>;

/**
 * Incrementa el contador de rechazos de nombre en metadata.
 * Llamar cuando el cliente se niega explícitamente a dar su nombre.
 * El nodo de checkout limpia este contador al cerrar la sesión.
 */
export const markNameRefusedTool = new DynamicStructuredTool<
  typeof markNameRefusedSchema,
  MarkNameRefusedInput
>({
  name: 'mark_name_refused',
  description:
    'Registra que el cliente se negó a dar su nombre. ' +
    'Llamá esta tool ANTES de responder cuando el cliente rechace explícitamente dar el nombre. ' +
    'Devuelve el conteo actualizado para que adaptes el tono de la respuesta.',
  schema: markNameRefusedSchema,
  func: async (_input: MarkNameRefusedInput, _runManager, config?: RunnableConfig) => {
    const { conversationId } = getReactContext(config);
    const cs = await prisma.conversation_state.findFirst({
      where: { conversation_id: conversationId },
      select: { metadata: true },
    });
    const current =
      cs && typeof cs.metadata === 'object' && cs.metadata !== null
        ? ((cs.metadata as Record<string, unknown>).name_refusal_count as number | undefined) ?? 0
        : 0;
    const next = current + 1;
    await patchConversationMetadata(conversationId, { name_refusal_count: next });
    return toJson({ name_refusal_count: next });
  },
});

// ---------------------------------------------------------------------------
// mark_address_refused
// ---------------------------------------------------------------------------

const markAddressRefusedSchema = z.object({});
type MarkAddressRefusedInput = z.infer<typeof markAddressRefusedSchema>;

/**
 * Incrementa el contador de rechazos de dirección en metadata.
 * Llamar cuando el cliente se niega a dar la dirección O cuando `save_delivery_address`
 * devuelve `not_found` dos veces seguidas (no tiene sentido para `out_of_coverage`).
 * El nodo de checkout limpia este contador al cerrar la sesión.
 */
export const markAddressRefusedTool = new DynamicStructuredTool<
  typeof markAddressRefusedSchema,
  MarkAddressRefusedInput
>({
  name: 'mark_address_refused',
  description:
    'Registra que el cliente se negó a dar su dirección de entrega, o que la dirección no pudo encontrarse repetidamente. ' +
    'NO llamar para casos de "out_of_coverage" (eso no es un rechazo, es una limitación de cobertura). ' +
    'Llamá esta tool ANTES de responder cuando el cliente rechace explícitamente dar la dirección. ' +
    'Devuelve el conteo actualizado para que adaptes el tono de la respuesta.',
  schema: markAddressRefusedSchema,
  func: async (_input: MarkAddressRefusedInput, _runManager, config?: RunnableConfig) => {
    const { conversationId } = getReactContext(config);
    const cs = await prisma.conversation_state.findFirst({
      where: { conversation_id: conversationId },
      select: { metadata: true },
    });
    const current =
      cs && typeof cs.metadata === 'object' && cs.metadata !== null
        ? ((cs.metadata as Record<string, unknown>).address_refusal_count as number | undefined) ?? 0
        : 0;
    const next = current + 1;
    await patchConversationMetadata(conversationId, { address_refusal_count: next });
    return toJson({ address_refusal_count: next });
  },
});

// ---------------------------------------------------------------------------
// delegate_to_main (temporal — NO limpia checkout_active)
// ---------------------------------------------------------------------------

const delegateToMainSchema = z.object({
  reason: z
    .string()
    .describe(
      'Motivo de la delegación en una oración. ' +
        'Ej: "el cliente preguntó los horarios", "el cliente preguntó los ingredientes de un plato".'
    ),
});
type DelegateToMainInput = z.infer<typeof delegateToMainSchema>;

/**
 * Delegación temporal: el nodo llama `runHybridReactAgent` con el mismo mensaje
 * y devuelve esa respuesta. `checkout_active` y `checkout_pending_action` NO se
 * limpian. En el siguiente turno el cliente vuelve automáticamente al agente de
 * checkout. Mismo patrón que reservation/onboarding.
 */
export const delegateToMainTool = new DynamicStructuredTool<
  typeof delegateToMainSchema,
  DelegateToMainInput
>({
  name: 'delegate_to_main',
  description:
    'Delega el turno al asistente principal para responder una consulta temporal (horarios, ingredientes, menú, precios, información). ' +
    'La sesión de checkout sigue activa: el próximo mensaje del cliente vuelve al agente de checkout. ' +
    'NO la uses para abandono del checkout (editar carrito, agregar/quitar productos, cancelar el pedido): usá handback_to_main en ese caso.',
  schema: delegateToMainSchema,
  func: async ({ reason }: DelegateToMainInput, _runManager, config?: RunnableConfig) => {
    getReactContext(config); // validar contexto
    return toJson({ signal: 'delegate_to_main', reason });
  },
});

// ---------------------------------------------------------------------------
// handback_to_main
// ---------------------------------------------------------------------------

const handbackToMainSchema = z.object({
  reason: z
    .string()
    .describe(
      'Motivo del handback en una oración corta. ' +
      'Ejemplos: "el cliente quiere agregar ítems", "el cliente quiere ver el menú", "el cliente quiere cancelar el pedido".'
    ),
});
type HandbackToMainInput = z.infer<typeof handbackToMainSchema>;

/**
 * Señal para salir de la sesión de checkout y devolver el control al flujo
 * principal del agente. El nodo limpia `checkout_active` y el siguiente
 * mensaje del cliente vuelve al pipeline normal (NLP / interactive).
 */
export const handbackToMainTool = new DynamicStructuredTool<
  typeof handbackToMainSchema,
  HandbackToMainInput
>({
  name: 'handback_to_main',
  description:
    'Sale de la sesión de checkout y devuelve el control al asistente principal. ' +
    'Usá esta tool cuando el cliente quiera hacer algo fuera del checkout: editar el carrito, ver el menú, cancelar el pedido, etc. ' +
    'Indicá el motivo en "reason". Después de llamarla, el cliente podrá interactuar normalmente con el bot.',
  schema: handbackToMainSchema,
  func: async ({ reason }: HandbackToMainInput, _runManager, config?: RunnableConfig) => {
    getReactContext(config); // validar contexto
    return toJson({ signal: 'handback_to_main', reason });
  },
});

// ---------------------------------------------------------------------------
// ENTRADA: start_checkout_session (agente híbrido → checkout)
// ---------------------------------------------------------------------------

const startCheckoutSessionSchema = z.object({
  reason: z
    .string()
    .describe(
      'Motivo de la delegación en una oración. ' +
        'Ej: "el cliente quiere finalizar y pagar el pedido", "el cliente pidió cerrar la compra".'
    ),
});
type StartCheckoutSessionInput = z.infer<typeof startCheckoutSessionSchema>;

/**
 * Señal de salida del agente híbrido: el dispatch activa checkout_active e
 * invoca runCheckoutAgent en el mismo turno.
 */
export const startCheckoutSessionTool = new DynamicStructuredTool<
  typeof startCheckoutSessionSchema,
  StartCheckoutSessionInput
>({
  name: 'start_checkout_session',
  description:
    'Delega al agente de checkout cuando el cliente quiere CERRAR, PAGAR o FINALIZAR el pedido actual. ' +
    'Usá esta tool cuando el cliente exprese intención de terminar la compra (no cuando quiera agregar platos). ' +
    'Antes de llamarla, verificá con get_cart que haya ítems; si el carrito está vacío, NO la uses y explicá que primero debe elegir platos. ' +
    'NO gestiones vos tipo de entrega, dirección, nombre ni pago: solo delegá con esta tool.',
  schema: startCheckoutSessionSchema,
  func: async ({ reason }: StartCheckoutSessionInput, _runManager, config?: RunnableConfig) => {
    const { businessId, customerPhone } = getReactContext(config);
    const draft = await prisma.draft_order.findFirst({
      where: {
        business_id: businessId,
        customer_phone: customerPhone,
        status: 'active',
      },
      select: {
        draft_order_item: { select: { id: true }, take: 1 },
      },
    });

    if (!draft || draft.draft_order_item.length === 0) {
      return toJson({
        success: false,
        error: 'empty_cart',
        message: 'El carrito está vacío; no se puede iniciar checkout.',
      });
    }

    return toJson({ signal: 'start_checkout_session', reason });
  },
});

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const allCheckoutTools = [
  saveFulfillmentTypeTool,
  savePaymentMethodTool,
  presentFulfillmentOptionsTool,
  presentPaymentOptionsTool,
  markNameRefusedTool,
  markAddressRefusedTool,
  delegateToMainTool,
  handbackToMainTool,
];

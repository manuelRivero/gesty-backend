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
import type { RunnableConfig } from '@langchain/core/runnables';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const toJson = (data: unknown): string => JSON.stringify(data);

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
// Export
// ---------------------------------------------------------------------------

export const allCheckoutTools = [
  presentFulfillmentOptionsTool,
  presentPaymentOptionsTool,
  handbackToMainTool,
];

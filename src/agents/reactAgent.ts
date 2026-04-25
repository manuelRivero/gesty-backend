/**
 * Hybrid ReAct agent (fase 2).
 *
 * Sólo se invoca cuando `AGENT_MODE=hybrid` y el intent detectado por
 * `detectIntentWithConfidence` es uno de los abiertos:
 * `ORDER_FOOD`, `PRODUCT_QUERY`, `PRODUCT_ATTRIBUTE_QUESTION` o `UNKNOWN`.
 *
 * El agente recibe el `EnrichedContext` (business + customer + conversation +
 * mensaje) en su SystemMessage, y un set de tools de **lectura** (`tools/index.ts`)
 * para inspeccionar menú, carrito y horarios. La respuesta final del agente
 * (último `AIMessage`) se traduce a un `HandlerResult` plano (texto), igual a
 * lo que produciría `FallbackHandler` en modo determinístico.
 *
 * No se le permite (todavía) crear órdenes ni agregar items: para eso hay que
 * exponer tools de escritura con guardas adicionales (out of scope fase 2).
 */

import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { getReasonerLlm } from '../config/llm';
import { allReactTools } from '../tools';
import type { EnrichedContext, HandlerResult } from '../controllers/webhook/types';

let cachedAgent: ReturnType<typeof createReactAgent> | null = null;

const buildAgent = () => {
  if (!cachedAgent) {
    cachedAgent = createReactAgent({
      llm: getReasonerLlm(),
      tools: allReactTools,
      prompt: HYBRID_AGENT_SYSTEM_PROMPT,
    });
  }
  return cachedAgent;
};

const HYBRID_AGENT_SYSTEM_PROMPT = `Sos el asistente conversacional de un restaurante atendiendo por WhatsApp.

REGLAS DURAS:
- Respondé SIEMPRE en español rioplatense, breve y amable.
- Sólo respondé sobre el negocio actual (menú, horarios, carrito). No inventes platos.
- Si el cliente quiere agregar al carrito, pagar o reservar mesa, indicá que tiene que tocar los botones del bot oficial — vos no podés ejecutar esas acciones.
- Usá las tools provistas para consultar menú real, carrito y horarios. NO inventes nombres ni precios.
- Si no encontrás el producto que pregunta, decilo claramente.

TOOLS DISPONIBLES:
- search_products(businessId, keyword): busca productos en el menú.
- get_categories(businessId, customerId): lista categorías.
- get_menu_by_category(businessId, customerId, categoryId): items por categoría.
- get_cart(businessId, customerPhone): carrito activo (snapshot, no modifica nada).
- get_business_hours(businessId): si está abierto y horarios.
- get_recent_messages(conversationId, sinceStartedAt, take): últimos mensajes de la conversación.

CONTEXTO:
- El bloque [CONTEXT] del mensaje del usuario contiene el JSON con businessId, customerId, customerPhone, conversationId, conversationStartedAt y el texto que escribió el cliente.
- Usá esos identificadores en las tools que los necesiten.

FORMATO DE SALIDA:
- Texto plano (sin markdown pesado, sin JSON), listo para enviar por WhatsApp.
- Máximo ~600 caracteres salvo que el usuario pida un detalle largo.`;

const buildContextMessage = (ctx: EnrichedContext): string => {
  const businessId =
    typeof ctx.business === 'object' && ctx.business
      ? (ctx.business as { id: string }).id
      : '';
  const customerId =
    typeof ctx.customer === 'object' && ctx.customer
      ? (ctx.customer as { id: string }).id
      : '';
  const customerPhone =
    typeof ctx.customer === 'object' && ctx.customer
      ? (ctx.customer as { phone_number?: string }).phone_number ?? ctx.to
      : ctx.to;
  const conversationId = ctx.conversationId;
  const conversationStartedAt =
    typeof ctx.conversation === 'object' && ctx.conversation
      ? (ctx.conversation as { started_at?: Date }).started_at?.toISOString() ?? ''
      : '';
  const text = ctx.message?.text?.body ?? '';

  return [
    '[CONTEXT]',
    JSON.stringify(
      {
        businessId,
        customerId,
        customerPhone,
        conversationId,
        conversationStartedAt,
      },
      null,
      0
    ),
    '',
    '[USER_MESSAGE]',
    text,
  ].join('\n');
};

const extractFinalText = (result: unknown): string | null => {
  if (typeof result !== 'object' || result === null) return null;
  const messages = (result as { messages?: unknown }).messages;
  if (!Array.isArray(messages) || messages.length === 0) return null;
  const last = messages[messages.length - 1] as { content?: unknown };
  if (typeof last.content === 'string') return last.content;
  if (Array.isArray(last.content)) {
    return last.content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (typeof part === 'object' && part && 'text' in part) {
          return String((part as { text: unknown }).text ?? '');
        }
        return '';
      })
      .join('')
      .trim() || null;
  }
  return null;
};

/**
 * Ejecuta el ReAct agent. Si el agente no produce texto utilizable, devuelve
 * `null` para que el caller (nodo `nlpSubgraph` en modo hybrid) caiga al
 * handler determinístico.
 */
export const runHybridReactAgent = async (
  ctx: EnrichedContext
): Promise<HandlerResult | null> => {
  const agent = buildAgent();

  const inputs = {
    messages: [
      new SystemMessage(HYBRID_AGENT_SYSTEM_PROMPT),
      new HumanMessage(buildContextMessage(ctx)),
    ],
  };

  const out = await agent.invoke(inputs);
  const text = extractFinalText(out);
  if (!text) return null;

  return { content: text, isInteractive: false };
};

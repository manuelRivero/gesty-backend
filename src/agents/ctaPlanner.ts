/**
 * CTA Planner — segundo paso del pipeline híbrido.
 *
 * Recibe el texto final que el ReAct generó + contexto de la conversación
 * y decide si se debe mostrar un botón de acción (CTA) y de qué tipo.
 *
 * Usa gpt-4o-mini (json_object mode) para mantener latencia baja (<300ms p50).
 * La resolución del productId real la hace `ctaResolver` de forma determinística.
 */

import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { getIntentDetectorLlm } from '../config/llm';
import { CtaPlannerRawSchema, type CtaPlannerInput, type CtaPlannerRaw } from './types';

const PLANNER_SYSTEM_PROMPT = `Sos un analizador de respuestas de bot de WhatsApp para un restaurante.
Tu ÚNICA tarea: decidir si se debe mostrar un botón de acción (CTA) al final de la respuesta del bot.

CUÁNDO mostrar CTA (shouldShowCta: true):
- La respuesta del bot menciona uno o más productos específicos (nombre, precio, ingredientes, disponibilidad).
- El contexto indica que el usuario está interesado en producto/s concreto/s del menú.
- La respuesta es informativa sobre productos y podría llevar a una compra.
- El usuario preguntó explícitamente por algo del menú o manifestó intención de pedir.

CUÁNDO NO mostrar CTA (shouldShowCta: false):
- La respuesta del bot es una pregunta al usuario ("¿Querés que te muestre...?", "¿Necesitás algo más?").
- La respuesta habla solo de horarios, dirección o métodos de pago (sin producto concreto).
- La respuesta es un saludo, agradecimiento o charla genérica.
- La respuesta ya le indica al usuario "tocá los botones del bot" o similar.
- La respuesta no menciona ningún producto del menú.

TIPOS DE ACCIÓN PRIMARIA:
- ADD_ITEM: hay UN ÚNICO producto específico claramente identificado en la respuesta. Usar sólo cuando el bot habla de un solo plato.
- SELECT_FROM_LIST: la respuesta menciona 2 o más productos por nombre y el usuario debería poder elegir uno para ver el detalle. En este caso DEBÉS poblar "productHints" con los nombres exactos de esos productos (entre 2 y 5), preferentemente los que aparezcan en [PRODUCTOS_MENU_RELEVANTES] o que se vean claramente en [RESPUESTA_BOT].
- VIEW_FEATURED: hay intención de compra pero sin productos identificables por nombre; mostrar destacados.
- VIEW_MENU: el usuario quiere explorar opciones en general (sin producto/s específicos).

SEÑAL AUTORITATIVA — [PRODUCTOS_LISTADOS]:
Cuando aparece este bloque, contiene los productos que el bot YA resolvió y va a ofrecer para selección. Es la fuente de verdad y tiene PRIORIDAD sobre cualquier inferencia hecha desde [RESPUESTA_BOT] o [PRODUCTOS_MENU_RELEVANTES]:
- Con 2 o más nombres: shouldShowCta DEBE ser true, primaryKind DEBE ser SELECT_FROM_LIST y "productHints" DEBE ser EXACTAMENTE esos nombres, en el mismo orden, sin agregar, quitar ni reescribir ninguno. NO elijas VIEW_FEATURED ni VIEW_MENU como primario en este caso, aunque la [RESPUESTA_BOT] no los nombre uno por uno.
- Con exactamente 1 nombre: shouldShowCta DEBE ser true, primaryKind DEBE ser ADD_ITEM para ese producto (poné su nombre en "productHint").
- Vacío o ausente: ignorá esta regla y decidí con las reglas generales de abajo.

REGLA DURA MULTI-PRODUCTO (aplica cuando [PRODUCTOS_LISTADOS] está ausente):
- Si la [RESPUESTA_BOT] enumera 2 o más nombres de plato/producto del menú, primaryKind DEBE ser SELECT_FROM_LIST. Nunca elijas ADD_ITEM tomando uno arbitrariamente cuando hay varios.
- Si hay sólo un producto mencionado, primaryKind debe ser ADD_ITEM.

REGLA DE SECUNDARIO:
- Cuando primaryKind=ADD_ITEM → secondaryKind DEBE ser VIEW_FEATURED o VIEW_MENU (escape obligatorio).
- Cuando primaryKind=SELECT_FROM_LIST → secondaryKind puede ser VIEW_MENU o null (la lista ya tiene escape interno).
- Cuando primaryKind=VIEW_FEATURED → secondaryKind puede ser VIEW_MENU o null.
- Cuando primaryKind=VIEW_MENU → secondaryKind es null.

ETIQUETAS: Máximo 20 caracteres. Preferir español informal ("Agregar 🛒", "Ver destacados", "Ver menú", "Elegir uno 👇").

Devolvé ÚNICAMENTE el JSON con exactamente estos campos, sin texto extra:
{
  "shouldShowCta": boolean,
  "productHint": string | null,
  "productHints": string[] | null,
  "primaryKind": "ADD_ITEM" | "SELECT_FROM_LIST" | "VIEW_FEATURED" | "VIEW_MENU",
  "primaryLabel": string,
  "secondaryKind": "VIEW_MENU" | "VIEW_FEATURED" | null,
  "secondaryLabel": string | null
}`;

const buildPlannerUserMessage = (input: CtaPlannerInput): string => {
  const lines: string[] = [
    `[INTENT]: ${input.intent}`,
    `[PRODUCTO_DETECTADO]: ${input.detectedProductName ?? 'ninguno'}`,
    `[PRODUCTO_EN_CONTEXTO]: ${input.lastReferencedProductName ?? 'ninguno'}`,
    `[MENSAJE_USUARIO]: ${input.userMessage}`,
    '',
    '[RESPUESTA_BOT]:',
    input.botResponseText,
  ];

  if (input.listedProductNames.length > 0) {
    lines.push('', `[PRODUCTOS_LISTADOS]: ${input.listedProductNames.join(', ')}`);
  }

  if (input.topMenuProductNames.length > 0) {
    lines.push('', `[PRODUCTOS_MENU_RELEVANTES]: ${input.topMenuProductNames.join(', ')}`);
  }

  return lines.join('\n');
};

const parsePlannerOutput = (raw: string): CtaPlannerRaw | null => {
  let json: unknown;
  try {
    json = JSON.parse(raw.trim());
  } catch {
    console.error('[hybrid-cta] planner JSON parse failed:', raw.slice(0, 200));
    return null;
  }

  const parsed = CtaPlannerRawSchema.safeParse(json);
  if (!parsed.success) {
    console.error('[hybrid-cta] planner schema validation failed:', parsed.error.message);
    return null;
  }

  return parsed.data;
};

/**
 * Llama al LLM planner y devuelve el plan crudo o `null` si:
 * - shouldShowCta es false
 * - el LLM falló / devolvió JSON inválido
 * - el timeout de 1.5s se cumplió (AbortSignal cancela la llamada real)
 */
export const planCta = async (input: CtaPlannerInput): Promise<CtaPlannerRaw | null> => {
  const llm = getIntentDetectorLlm();

  const messages = [
    new SystemMessage(PLANNER_SYSTEM_PROMPT),
    new HumanMessage(buildPlannerUserMessage(input)),
  ];

  try {
    const response = await llm.invoke(messages, { signal: AbortSignal.timeout(1500) });
    const content =
      typeof response.content === 'string'
        ? response.content
        : Array.isArray(response.content)
          ? response.content
              .map((p) => (typeof p === 'string' ? p : (p as { text?: string }).text ?? ''))
              .join('')
          : '';

    if (!content.trim()) {
      console.error('[hybrid-cta] planner returned empty content');
      return null;
    }

    const result = parsePlannerOutput(content);
    if (!result || !result.shouldShowCta) {
      return null;
    }

    return result;
  } catch (err) {
    console.error('[hybrid-cta] planner_failed:', err);
    return null;
  }
};

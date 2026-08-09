/**
 * Tools exclusivas del agente de onboarding (captura de dirección de entrega).
 *
 * Categorías:
 *  - Escritura + consulta: `check_address_coverage` — geocodifica, valida cobertura y persiste temp_*.
 *  - Salida temporal: `delegate_to_main` — pausa, el nodo llama al main agent inline.
 *  - Salida permanente: `finish_onboarding` — limpia la sesión de onboarding.
 *
 * `present_address_confirmation` NO está acá: es un tool exclusivo del híbrido
 * (ver `tools/index.ts`) para el flujo `stage_delivery_address` — el agente de
 * onboarding adjunta los botones directamente en el nodo (`onboardingAgentNode`),
 * sin depender de que el LLM llame ninguna tool para eso.
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { getReactContext } from './_context';
import { omitConversationMetadataKeys } from '../repositories/conversationState.repository';
import { AddressService } from '../services/address.service';
import type { RunnableConfig } from '@langchain/core/runnables';
import { incrementRefusalCount } from '../services/intent/intentRefusal.service';

const toJson = (data: unknown): string => JSON.stringify(data);

// ---------------------------------------------------------------------------
// check_address_coverage
// ---------------------------------------------------------------------------

const checkAddressCoverageSchema = z.object({
  text: z
    .string()
    .describe('Dirección de entrega en texto libre, tal como la escribió el cliente.'),
});
type CheckAddressCoverageInput = z.infer<typeof checkAddressCoverageSchema>;

export const checkAddressCoverageTool = new DynamicStructuredTool<
  typeof checkAddressCoverageSchema,
  CheckAddressCoverageInput
>({
  name: 'check_address_coverage',
  description:
    'Geocodifica el texto de dirección del cliente, valida si está en la zona de cobertura del negocio ' +
    'y guarda el borrador (temp_address, temp_lat, temp_lng, temp_zone_id). ' +
    'Devuelve status: "in_coverage" | "out_of_coverage" | "not_found". ' +
    'Si es "in_coverage", preguntale al cliente si es correcta con tu propio texto natural ' +
    '— el sistema adjunta los botones de confirmar/editar automáticamente.',
  schema: checkAddressCoverageSchema,
  func: async ({ text }: CheckAddressCoverageInput, _runManager, config?: RunnableConfig) => {
    const { businessId, conversationId } = getReactContext(config);
    const result = await new AddressService().resolveAndStageAddress({
      businessId,
      conversationId,
      text,
    });
    return toJson(result);
  },
});

// ---------------------------------------------------------------------------
// resolve_address_confirmation
// ---------------------------------------------------------------------------

const resolveAddressConfirmationSchema = z.object({
  confirmed: z
    .boolean()
    .describe('true si el cliente confirmó que la dirección es correcta, false si pidió editarla.'),
});
type ResolveAddressConfirmationInput = z.infer<typeof resolveAddressConfirmationSchema>;

/**
 * Señal para que el nodo guarde (confirmed=true) o descarte y vuelva a pedir
 * (confirmed=false) la dirección staged. La tool nunca guarda por sí misma
 * (ADR-0004) — solo cuando el cliente responde en TEXTO LIBRE a la
 * confirmación; si tocó un botón, el sistema ya lo procesó.
 */
export const resolveAddressConfirmationTool = new DynamicStructuredTool<
  typeof resolveAddressConfirmationSchema,
  ResolveAddressConfirmationInput
>({
  name: 'resolve_address_confirmation',
  description:
    'Registrá la respuesta del cliente a la confirmación de dirección (el mensaje que muestra la ' +
    'dirección detectada y pregunta "¿es correcta?"). Llamala SOLO cuando el cliente responde en ' +
    'texto libre — si tocó un botón, el sistema ya lo procesó y no hace falta llamarla. ' +
    'confirmed=true si confirma ("sí", "es correcta", "dale"); confirmed=false si pide editarla ' +
    '("no", "esa no es", "cambiala").',
  schema: resolveAddressConfirmationSchema,
  func: async ({ confirmed }: ResolveAddressConfirmationInput, _runManager, config?: RunnableConfig) => {
    getReactContext(config); // validar contexto
    return toJson({ signal: 'address_confirmation_resolved', confirmed });
  },
});

// ---------------------------------------------------------------------------
// delegate_to_main (salida temporal)
// ---------------------------------------------------------------------------

const delegateToMainSchema = z.object({
  reason: z
    .string()
    .describe(
      'Motivo de la delegación en una oración. ' +
        'Ej: "el cliente preguntó por el menú", "el cliente quiere saber el horario del local".'
    ),
});
type DelegateToMainInput = z.infer<typeof delegateToMainSchema>;

export const onboardingDelegateToMainTool = new DynamicStructuredTool<
  typeof delegateToMainSchema,
  DelegateToMainInput
>({
  name: 'delegate_to_main',
  description:
    'Delega el turno al asistente principal para responder una pregunta off-topic. ' +
    'La sesión de onboarding sigue activa: el próximo mensaje del cliente vuelve a este agente. ' +
    'Usá esta tool cuando el cliente pregunta algo fuera de la dirección (menú, precios, horarios). ' +
    'NO la uses para cerrar la sesión permanentemente: usá finish_onboarding en ese caso.',
  schema: delegateToMainSchema,
  func: async ({ reason }: DelegateToMainInput, _runManager, config?: RunnableConfig) => {
    getReactContext(config); // validar contexto
    return toJson({ signal: 'delegate_to_main', reason });
  },
});

// ---------------------------------------------------------------------------
// finish_onboarding (salida permanente)
// ---------------------------------------------------------------------------

const finishOnboardingSchema = z.object({
  reason: z
    .string()
    .describe(
      'Motivo del cierre de sesión. Ej: "el cliente prefiere solo take-away", ' +
        '"el cliente decidió no dar su dirección de entrega".'
    ),
  outcome: z
    .enum(['address_refused', 'not_needed'])
    .describe(
      '"address_refused": el cliente se negó explícitamente a dar su dirección o quiere ' +
        'volver al menú/cambiar de tema sin completarla (incrementa el contador de rechazos, ' +
        'igual que mark_address_refused en checkout, para no volver a insistir en sesiones futuras). ' +
        '"not_needed": la dirección dejó de ser necesaria por otro motivo (ej. el cliente eligió take-away).'
    ),
});
type FinishOnboardingInput = z.infer<typeof finishOnboardingSchema>;

export const finishOnboardingTool = new DynamicStructuredTool<
  typeof finishOnboardingSchema,
  FinishOnboardingInput
>({
  name: 'finish_onboarding',
  description:
    'Cierra la sesión de onboarding de forma permanente (H-06/H-08: es la ÚNICA salida ' +
    'permanente del agente, aparte del éxito al confirmar la dirección). ' +
    'Usá esta tool cuando el cliente se niega a dar su dirección, quiere ver el menú, ' +
    'cambia de tema de forma definitiva, o prefiere exclusivamente take-away. ' +
    'Para preguntas off-topic temporales (el cliente sigue interesado en dar su dirección ' +
    'después) usá delegate_to_main en cambio.',
  schema: finishOnboardingSchema,
  func: async (
    { reason, outcome }: FinishOnboardingInput,
    _runManager,
    config?: RunnableConfig
  ) => {
    const { conversationId } = getReactContext(config);

    if (outcome === 'address_refused') {
      await incrementRefusalCount(conversationId, 'OBTENER_DIRECCION');
    }

    await omitConversationMetadataKeys(conversationId, [
      'onboarding_agent_active',
      'onboarding_step',
      'temp_address',
      'temp_lat',
      'temp_lng',
      'temp_zone_id',
      'awaiting_address',
      'pending_address_action',
    ]);
    return toJson({ signal: 'finish_onboarding', reason, outcome });
  },
});

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const allOnboardingTools = [
  checkAddressCoverageTool,
  resolveAddressConfirmationTool,
  onboardingDelegateToMainTool,
  finishOnboardingTool,
];

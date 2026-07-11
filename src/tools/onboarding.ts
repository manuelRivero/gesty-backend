/**
 * Tools exclusivas del agente de onboarding (captura de dirección de entrega).
 *
 * Categorías:
 *  - Escritura + consulta: `check_address_coverage` — geocodifica, valida cobertura y persiste temp_*.
 *  - Señal-UI: `present_address_confirmation` — el nodo construye los botones WhatsApp.
 *  - Salida temporal: `delegate_to_main` — pausa, el nodo llama al main agent inline.
 *  - Salida permanente: `finish_onboarding` — limpia la sesión de onboarding.
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { getReactContext } from './_context';
import {
  omitConversationMetadataKeys,
  patchConversationMetadata,
} from '../repositories/conversationState.repository';
import { AddressService } from '../services/address.service';
import { prisma } from '../lib/prisma';
import type { RunnableConfig } from '@langchain/core/runnables';

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
    'Si es "in_coverage", llamá present_address_confirmation() de inmediato.',
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
// present_address_confirmation (señal-UI)
// ---------------------------------------------------------------------------

const presentAddressConfirmationSchema = z.object({});
type PresentAddressConfirmationInput = z.infer<typeof presentAddressConfirmationSchema>;

export const presentAddressConfirmationTool = new DynamicStructuredTool<
  typeof presentAddressConfirmationSchema,
  PresentAddressConfirmationInput
>({
  name: 'present_address_confirmation',
  description:
    'Muestra al cliente los botones para confirmar o editar la dirección staged. ' +
    'Solo llamar después de que check_address_coverage devolvió status "in_coverage". ' +
    'El nodo construye los botones; no describas la dirección en texto ni pidas confirmación verbal.',
  schema: presentAddressConfirmationSchema,
  func: async (_input: PresentAddressConfirmationInput, _runManager, config?: RunnableConfig) => {
    getReactContext(config); // validar contexto
    return toJson({ signal: 'present_address_confirmation' });
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
      const cs = await prisma.conversation_state.findFirst({
        where: { conversation_id: conversationId },
        select: { metadata: true },
      });
      const current =
        cs && typeof cs.metadata === 'object' && cs.metadata !== null
          ? ((cs.metadata as Record<string, unknown>).address_refusal_count as number | undefined) ?? 0
          : 0;
      await patchConversationMetadata(conversationId, { address_refusal_count: current + 1 });
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
  presentAddressConfirmationTool,
  onboardingDelegateToMainTool,
  finishOnboardingTool,
];

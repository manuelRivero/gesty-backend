/**
 * Tools del agente de onboarding (perfil mínimo: dirección + nombre).
 *
 * Contrato agent-factory (§1 / §3.10):
 *   customer_address → check_address_coverage (staging) + resolve_address_confirmation (señal→nodo)
 *   customer.name    → save_customer_name
 * Gates: withGate contra nextOnboardingStep(loadLiveOnboardingFacts).
 *
 * Señales (delegate / finish / resolve) no llevan withGate de paso de recolección.
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import type { RunnableConfig } from '@langchain/core/runnables';
import { getReactContext } from './_context';
import { withGate } from './_withGate';
import { omitConversationMetadataKeys } from '../repositories/conversationState.repository';
import { updateCustomerName } from '../repositories/customer.repository';
import { AddressService } from '../services/address.service';
import { incrementRefusalCount } from '../services/intent/intentRefusal.service';
import { loadLiveOnboardingFacts } from '../services/onboarding/loadLiveOnboardingFacts';
import { nextOnboardingStep } from '../services/onboarding/nextOnboardingStep';

const toJson = (data: unknown): string => JSON.stringify(data);

const assertOnboardingStep = (required: ReturnType<typeof nextOnboardingStep>) =>
  withGate({
    assert: async (ctx) => {
      const facts = await loadLiveOnboardingFacts({
        conversationId: ctx.conversationId,
        customerId: ctx.customerId,
      });
      const step = nextOnboardingStep(facts);
      if (step !== required) {
        return { error: `${step}_required`, missing: step };
      }
      return null;
    },
  });

// ---------------------------------------------------------------------------
// check_address_coverage (write de staging — requiere paso capture)
// ---------------------------------------------------------------------------

const checkAddressCoverageSchema = z.object({
  text: z
    .string()
    .describe('Dirección de entrega en texto libre, tal como la escribió el cliente.'),
});
type CheckAddressCoverageInput = z.infer<typeof checkAddressCoverageSchema>;

const checkAddressCoverageInner = new DynamicStructuredTool<
  typeof checkAddressCoverageSchema,
  CheckAddressCoverageInput
>({
  name: 'check_address_coverage',
  description:
    'Geocodifica el texto de dirección del cliente, valida si está en la zona de cobertura del negocio ' +
    'y guarda el borrador (temp_address, temp_lat, temp_lng, temp_zone_id). ' +
    'Devuelve status: "in_coverage" | "out_of_coverage" | "not_found". ' +
    'Si es "in_coverage", preguntale al cliente si es correcta con tu propio texto natural ' +
    '— el sistema adjunta los botones de confirmar/editar automáticamente. ' +
    'Solo en el paso capture.',
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

export const checkAddressCoverageTool = assertOnboardingStep('capture')(checkAddressCoverageInner);

// ---------------------------------------------------------------------------
// resolve_address_confirmation (señal — gate de paso confirm)
// ---------------------------------------------------------------------------

const resolveAddressConfirmationSchema = z.object({
  confirmed: z
    .boolean()
    .describe('true si el cliente confirmó que la dirección es correcta, false si pidió editarla.'),
});
type ResolveAddressConfirmationInput = z.infer<typeof resolveAddressConfirmationSchema>;

const resolveAddressConfirmationInner = new DynamicStructuredTool<
  typeof resolveAddressConfirmationSchema,
  ResolveAddressConfirmationInput
>({
  name: 'resolve_address_confirmation',
  description:
    'Registrá la respuesta del cliente a la confirmación de dirección (el mensaje que muestra la ' +
    'dirección detectada y pregunta "¿es correcta?"). Llamala SOLO cuando el cliente responde en ' +
    'texto libre — si tocó un botón, el sistema ya lo procesó y no hace falta llamarla. ' +
    'confirmed=true si confirma ("sí", "es correcta", "dale"); confirmed=false si pide editarla ' +
    '("no", "esa no es", "cambiala"). Solo en el paso confirm.',
  schema: resolveAddressConfirmationSchema,
  func: async (
    { confirmed }: ResolveAddressConfirmationInput,
    _runManager,
    config?: RunnableConfig
  ) => {
    getReactContext(config);
    return toJson({ signal: 'address_confirmation_resolved', confirmed });
  },
});

export const resolveAddressConfirmationTool = assertOnboardingStep('confirm')(
  resolveAddressConfirmationInner
);

// ---------------------------------------------------------------------------
// save_customer_name (write — requiere paso name; misma persistencia que checkout)
// ---------------------------------------------------------------------------

const saveCustomerNameSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(100)
    .describe('Nombre o alias del cliente tal como lo dijo.'),
});
type SaveCustomerNameInput = z.infer<typeof saveCustomerNameSchema>;

const saveCustomerNameInner = new DynamicStructuredTool<
  typeof saveCustomerNameSchema,
  SaveCustomerNameInput
>({
  name: 'save_customer_name',
  description:
    'Guarda el nombre del cliente cuando lo menciona. Solo en el paso name (primero del flujo). ' +
    'Si aún falta la dirección, el sistema sigue en onboarding; si el perfil ya está completo, cierra la sesión.',
  schema: saveCustomerNameSchema,
  func: async ({ name }: SaveCustomerNameInput, _runManager, config?: RunnableConfig) => {
    const { customerId } = getReactContext(config);
    const trimmed = name.trim();
    await updateCustomerName(customerId, trimmed);
    return toJson({
      success: true,
      name: trimmed,
      signal: 'customer_name_saved',
    });
  },
});

export const saveCustomerNameOnboardingTool = assertOnboardingStep('name')(saveCustomerNameInner);

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
    'Usá esta tool cuando el cliente pregunta algo fuera del perfil (menú, precios, horarios). ' +
    'NO la uses para cerrar la sesión permanentemente: usá finish_onboarding en ese caso.',
  schema: delegateToMainSchema,
  func: async ({ reason }: DelegateToMainInput, _runManager, config?: RunnableConfig) => {
    getReactContext(config);
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
        '"el cliente decidió no dar su dirección", "el cliente no quiere dar su nombre".'
    ),
  outcome: z
    .enum(['address_refused', 'name_refused', 'not_needed'])
    .describe(
      '"address_refused": se niega a dar dirección / menú / cambio de tema en captura (refusal OBTENER_DIRECCION). ' +
        '"name_refused": se niega a dar el nombre (refusal OBTENER_NOMBRE). ' +
        '"not_needed": perfil ya no hace falta (take-away/menú); refusal de dirección y nombre para no reabrir por Facts.'
    ),
});
type FinishOnboardingInput = z.infer<typeof finishOnboardingSchema>;

export const finishOnboardingTool = new DynamicStructuredTool<
  typeof finishOnboardingSchema,
  FinishOnboardingInput
>({
  name: 'finish_onboarding',
  description:
    'Cierra la sesión de onboarding de forma permanente (única salida permanente aparte del éxito). ' +
    'Usá cuando el cliente se niega a dar dirección o nombre, quiere ver el menú, cambia de tema, o prefiere take-away. ' +
    'Para preguntas off-topic temporales usá delegate_to_main.',
  schema: finishOnboardingSchema,
  func: async (
    { reason, outcome }: FinishOnboardingInput,
    _runManager,
    config?: RunnableConfig
  ) => {
    const { conversationId } = getReactContext(config);

    if (outcome === 'address_refused' || outcome === 'not_needed') {
      await incrementRefusalCount(conversationId, 'OBTENER_DIRECCION');
    }
    if (outcome === 'name_refused' || outcome === 'not_needed') {
      await incrementRefusalCount(conversationId, 'OBTENER_NOMBRE');
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
  saveCustomerNameOnboardingTool,
  onboardingDelegateToMainTool,
  finishOnboardingTool,
];

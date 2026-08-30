import { EnrichedContext } from '../controllers/webhook/types';
import { prisma } from '../lib/prisma';
import {
  updateConversationState,
  patchConversationMetadata,
  omitConversationMetadataKeys,
} from '../repositories/conversationState.repository';
import { findCoverageZoneForPoint } from '../repositories/coverageZone.repository';
import { WhatsAppInteractiveMessage, WhatsAppListMessage } from '../domain/intent/whatsappTemplates';
import { buildSmallTalkMenu } from './smallTalk.service';
import {
  ADDRESS_SAVED_PAYMENT_PROMPT_BOT_MESSAGE,
  RETRY_ADDRESS_BOT_MESSAGE,
} from './productQuery/botMessages';
import { formatBotUserMessage } from './productQuery/utils';
import { getBusinessConfig } from './businessConfig.service';
import { listOfferedPaymentMethods } from './paymentMethods.service';
import { buildPaymentButtonsMessage } from './payment/paymentButtons';


/** Claves usadas por `stageAddressForDelegatedConfirmation`/`resolveDelegatedAddressConfirmation`. */
export const DELEGATED_ADDRESS_CONFIRMATION_KEYS = [
  'pending_address_confirmation',
  'pending_address_text',
  'pending_address_lat',
  'pending_address_lng',
  'pending_address_zone_id',
];

export class AddressService {


  /** Vuelve a pedir la dirección (CTA «Editar dirección»). */
  async startEdit(ctx: EnrichedContext): Promise<string> {
    return this.edit(ctx);
  }

  /**
   * Versión headless para el agente de onboarding: geocodifica, valida cobertura y
   * persiste temp_* + onboarding_step en metadata, sin construir UI de confirmación.
   * El agente decide si llamar a `present_address_confirmation` después.
   */
  async resolveAndStageAddress(params: {
    businessId: string;
    conversationId: string;
    text: string;
  }): Promise<
    | { status: 'in_coverage'; formattedAddress: string }
    | { status: 'out_of_coverage' }
    | { status: 'not_found' }
  > {
    const cleaned = params.text.trim();
    if (!cleaned) return { status: 'not_found' };

    const geo = await this.geocode(cleaned);
    if (!geo) return { status: 'not_found' };

    const zone = await this.getCoverage(geo.lat, geo.lng, params.businessId);
    if (!zone) return { status: 'out_of_coverage' };

    const formattedAddress = typeof geo.formatted === 'string' ? geo.formatted : String(geo.formatted);

    await patchConversationMetadata(params.conversationId, {
      onboarding_step: 'CONFIRM',
      temp_address: formattedAddress,
      temp_lat: geo.lat,
      temp_lng: geo.lng,
      temp_zone_id: zone.id,
    });

    return { status: 'in_coverage', formattedAddress };
  }

  /**
   * Equivalente a `resolveAndStageAddress` pero para el pin de ubicación de
   * WhatsApp (`message.type === 'location'`) — mismo staging (`temp_*` +
   * `onboarding_step`), mismo criterio que el camino de texto (P0.4/H-C).
   * Reemplaza a `.process()`/`.handleLocation()` (LEGACY, wizard por pasos)
   * para el agente de onboarding ReAct: la UI de confirmación la construye
   * el nodo (`onboardingAgentNode`) con `buildConfirmAddressMessage`, igual
   * que en el camino de texto — un solo copy para ambos canales.
   */
  async resolveAndStageAddressFromLocation(params: {
    businessId: string;
    conversationId: string;
    lat: number;
    lng: number;
  }): Promise<
    | { status: 'in_coverage'; formattedAddress: string }
    | { status: 'out_of_coverage' }
  > {
    const formattedAddress = await this.reverseGeocode(params.lat, params.lng);

    const zone = await this.getCoverage(params.lat, params.lng, params.businessId);
    if (!zone) return { status: 'out_of_coverage' };

    await patchConversationMetadata(params.conversationId, {
      onboarding_step: 'CONFIRM',
      temp_address: formattedAddress,
      temp_lat: params.lat,
      temp_lng: params.lng,
      temp_zone_id: zone.id,
    });

    return { status: 'in_coverage', formattedAddress };
  }

  /**
   * Versión directa para el ReAct agent: geocodifica, valida cobertura y persiste
   * la dirección en una sola llamada, sin el flujo de confirmación por botones.
   * El agente describe la dirección encontrada en su respuesta de texto.
   */
  async resolveAndSave(params: {
    businessId: string;
    customerId: string;
    addressText: string;
  }): Promise<
    | { status: 'saved'; formattedAddress: string; zoneId: string }
    | { status: 'out_of_coverage' }
    | { status: 'not_found' }
  > {
    const cleaned = params.addressText.trim();
    if (!cleaned) return { status: 'not_found' };

    const geo = await this.geocode(cleaned);
    if (!geo) return { status: 'not_found' };

    const zone = await this.getCoverage(geo.lat, geo.lng, params.businessId);
    if (!zone) return { status: 'out_of_coverage' };

    const formattedAddress =
      typeof geo.formatted === 'string' ? geo.formatted : String(geo.formatted);

    await prisma.customer_address.updateMany({
      where: { customer_id: params.customerId },
      data: { is_default: false },
    });

    await prisma.customer_address.create({
      data: {
        customer_id: params.customerId,
        street_address: formattedAddress,
        is_default: true,
        delivery_zone_id: zone.id,
      },
    });

    return { status: 'saved', formattedAddress, zoneId: zone.id };
  }

  /**
   * Versión directa para el checkout (H-08): geocodifica en reversa una
   * ubicación de WhatsApp (`message.type === 'location'`) y persiste la
   * dirección en una sola llamada, igual que `resolveAndSave` para texto.
   * A propósito NO usa `onboarding_step`/`temp_*` (el staging del agente de
   * onboarding): setearlos le daría Ownership del turno siguiente al
   * `onboardingAgent`, sacando al cliente de su sesión de checkout activa
   * (ver predicados de ruteo en `context/index.ts`).
   */
  async resolveAndSaveFromLocation(params: {
    businessId: string;
    customerId: string;
    lat: number;
    lng: number;
  }): Promise<
    | { status: 'saved'; formattedAddress: string; zoneId: string }
    | { status: 'out_of_coverage' }
  > {
    const formattedAddress = await this.reverseGeocode(params.lat, params.lng);

    const zone = await this.getCoverage(params.lat, params.lng, params.businessId);
    if (!zone) return { status: 'out_of_coverage' };

    await prisma.customer_address.updateMany({
      where: { customer_id: params.customerId },
      data: { is_default: false },
    });

    await prisma.customer_address.create({
      data: {
        customer_id: params.customerId,
        street_address: formattedAddress,
        is_default: true,
        delivery_zone_id: zone.id,
      },
    });

    return { status: 'saved', formattedAddress, zoneId: zone.id };
  }

  /**
   * Versión para el híbrido cuando responde una pregunta de envío delegada
   * desde otra sesión (checkout, o sin sesión alguna): geocodifica, valida
   * cobertura y deja la dirección "staged" en claves DEDICADAS
   * (`pending_address_*`), nunca `onboarding_step`/`temp_*` — pisar
   * `onboarding_step` le daría Ownership del turno siguiente al
   * `onboardingAgent`, sacando al cliente de la sesión que esté activa
   * (mismo motivo que documenta `resolveAndSaveFromLocation`).
   * `context/index.ts` prioriza `pending_address_confirmation` sobre
   * cualquier otra sesión para capturar la confirmación del próximo turno.
   */
  async stageAddressForDelegatedConfirmation(params: {
    businessId: string;
    conversationId: string;
    text: string;
  }): Promise<
    | { status: 'in_coverage'; formattedAddress: string }
    | { status: 'out_of_coverage' }
    | { status: 'not_found' }
  > {
    const cleaned = params.text.trim();
    if (!cleaned) return { status: 'not_found' };

    const geo = await this.geocode(cleaned);
    if (!geo) return { status: 'not_found' };

    const zone = await this.getCoverage(geo.lat, geo.lng, params.businessId);
    if (!zone) return { status: 'out_of_coverage' };

    const formattedAddress = typeof geo.formatted === 'string' ? geo.formatted : String(geo.formatted);

    await patchConversationMetadata(params.conversationId, {
      pending_address_confirmation: true,
      pending_address_text: formattedAddress,
      pending_address_lat: geo.lat,
      pending_address_lng: geo.lng,
      pending_address_zone_id: zone.id,
    });

    return { status: 'in_coverage', formattedAddress };
  }

  /**
   * Resuelve la confirmación de una dirección staged por
   * `stageAddressForDelegatedConfirmation` (botón o texto libre, ver
   * `delegatedAddressConfirmationNode`). Guarda como default si `confirmed`,
   * limpia las claves `pending_address_*` en cualquier caso.
   */
  async resolveDelegatedAddressConfirmation(
    ctx: EnrichedContext,
    confirmed: boolean
  ): Promise<string> {
    const meta = ctx.conversationState?.metadata ?? {};
    const addressText = typeof meta.pending_address_text === 'string' ? meta.pending_address_text : null;

    if (!confirmed) {
      await omitConversationMetadataKeys(ctx.conversationId, DELEGATED_ADDRESS_CONFIRMATION_KEYS);
      return 'Dale, decime la dirección correcta y la reviso de nuevo 📍';
    }

    if (!addressText) {
      await omitConversationMetadataKeys(ctx.conversationId, DELEGATED_ADDRESS_CONFIRMATION_KEYS);
      return 'No pude recuperar la dirección. ¿Me la volvés a compartir?';
    }

    await prisma.customer_address.updateMany({
      where: { customer_id: ctx.customer.id },
      data: { is_default: false },
    });

    const created = await prisma.customer_address.create({
      data: {
        customer_id: ctx.customer.id,
        street_address: addressText,
        is_default: true,
        delivery_zone_id: (meta.pending_address_zone_id as string | undefined) ?? null,
      },
    });

    const lat = meta.pending_address_lat as number | undefined;
    const lng = meta.pending_address_lng as number | undefined;
    if (lat != null && lng != null) {
      await prisma.$executeRaw`
        UPDATE customer_address
        SET location = ST_SetSRID(ST_MakePoint(${lng}::float8, ${lat}::float8), 4326)::geography
        WHERE id = ${created.id}::uuid
      `;
    }

    await omitConversationMetadataKeys(ctx.conversationId, DELEGATED_ADDRESS_CONFIRMATION_KEYS);
    return `Listo, guardé tu dirección: ${addressText} ✅`;
  }

  buildDelegatedConfirmAddressMessage(body: string): WhatsAppInteractiveMessage {
    return {
      type: 'interactive',
      interactive: {
        type: 'button',
        header: { type: 'text', text: 'Confirmá tu dirección' },
        body: { text: body },
        footer: { text: 'Seleccioná una opción para continuar.' },
        action: {
          buttons: [
            { type: 'reply', reply: { id: 'DELEGATED_CONFIRM_ADDRESS', title: 'Confirmar' } },
            { type: 'reply', reply: { id: 'DELEGATED_EDIT_ADDRESS', title: 'Editar' } },
          ],
        },
      },
    };
  }

  /**
   * Resuelve la confirmación de la dirección staged sin depender de
   * `ctx.payloadId` (a diferencia de `.process()`/`.confirm()`, pensados
   * para el flujo de botones). La usa `resolve_address_confirmation`
   * (`tools/onboarding.ts`) cuando el cliente confirma/edita en texto libre
   * — mismo guardado/limpieza que los payloads determinísticos
   * `ONBOARDING_CONFIRM_ADDRESS`/`ONBOARDING_EDIT_ADDRESS`, una sola fuente
   * de verdad para "qué pasa al confirmar", sin importar el canal.
   *
   * Ningún agente de dominio compone su propia respuesta "qué sigue": eso es
   * responsabilidad exclusiva del híbrido (get_cart, Goal COMPLETAR_PEDIDO).
   * Por eso, fuera del caso CHECKOUT (continuación determinística legítima),
   * devuelve solo un ack corto — el caller (`onboardingAgentNode`) es quien
   * decide invocar al híbrido inline después.
   */
  async resolveStagedAddressConfirmation(
    ctx: EnrichedContext,
    confirmed: boolean
  ): Promise<string | WhatsAppListMessage | WhatsAppInteractiveMessage> {
    return confirmed ? this.saveAddress(ctx) : this.edit(ctx);
  }

  private async saveAddress(
    ctx: EnrichedContext
  ): Promise<string | WhatsAppListMessage | WhatsAppInteractiveMessage> {
    const meta = ctx.conversationState.metadata;
    const pendingAction = meta?.pending_address_action;

    await prisma.customer_address.updateMany({
      where: { customer_id: ctx.customer.id },
      data: { is_default: false },
    });

    const created = await prisma.customer_address.create({
      data: {
        customer_id: ctx.customer.id,
        street_address: meta.temp_address,
        is_default: true,
        delivery_zone_id: meta.temp_zone_id ?? null,
      },
    });

    if (meta.temp_lat != null && meta.temp_lng != null) {
      await prisma.$executeRaw`
        UPDATE customer_address
        SET location = ST_SetSRID(ST_MakePoint(${meta.temp_lng}::float8, ${meta.temp_lat}::float8), 4326)::geography
        WHERE id = ${created.id}::uuid
      `;
    }

    await this.clearState(ctx);

    if (pendingAction === 'CHECKOUT') {
      const businessConfig = await getBusinessConfig(ctx.business.id);
      const methods = await listOfferedPaymentMethods(ctx.business.id, {
        externalDeliveryEnabled: businessConfig.external_delivery_enabled,
      });
      return buildPaymentButtonsMessage(
        ADDRESS_SAVED_PAYMENT_PROMPT_BOT_MESSAGE,
        methods
      );
    }

    // "Qué sigue" tras guardar la dirección es del híbrido, no de acá (V-23):
    // el caller (`onboardingAgentNode`) decide invocarlo inline.
    return formatBotUserMessage(
      'Dirección guardada',
      '✅',
      'Listo, ya la anoté.'
    );
  }

  private async edit(ctx: EnrichedContext): Promise<string> {
    await this.updateState(ctx, {
      onboarding_step: 'CAPTURE',
      temp_address: null,
      temp_lat: null,
      temp_lng: null,
      temp_zone_id: null,
    });

    return RETRY_ADDRESS_BOT_MESSAGE;
  }

  // =========================
  // HELPERS
  // =========================
  private async getCoverage(
    lat: number,
    lng: number,
    businessId?: string | null
  ) {
    if (!businessId) return null;
    return findCoverageZoneForPoint(lat, lng, businessId);
  }

  private async updateState(ctx: EnrichedContext, data: any) {
    await updateConversationState(ctx.conversationId, {
      metadata: {
        ...ctx.conversationState.metadata,
        ...data,
      },
    });
  }

  private async clearState(ctx: EnrichedContext) {
    const {
      onboarding_step,
      onboarding_started_at,
      temp_address,
      temp_lat,
      temp_lng,
      temp_zone_id,
      pending_address_action,
      ...rest
    } = ctx.conversationState.metadata ?? {};
    await updateConversationState(ctx.conversationId, { metadata: rest });
  }

  buildConfirmAddressMessage(body: string): WhatsAppInteractiveMessage {
    return {
      type: 'interactive',
      interactive: {
        type: 'button',
        header: { type: 'text', text: 'Confirmá tu dirección' },
        body: { text: body },
        footer: { text: 'Seleccioná una opción para continuar.' },
        action: {
          buttons: [
            { type: 'reply', reply: { id: 'ONBOARDING_CONFIRM_ADDRESS', title: 'Confirmar' } },
            { type: 'reply', reply: { id: 'ONBOARDING_EDIT_ADDRESS', title: 'Editar' } }
          ]
        }
      }
    };
  }

  // =========================
  // EXTERNAL SERVICES (MOCKS)
  // =========================

  private async geocode(
    address: string
  ): Promise<{ lat: number; lng: number; formatted: string } | null> {
    // TODO: integrar Google Maps / OSM + cache
    return {
      lat: -32.9442,
      lng: -60.6505,
      formatted: address,
    };
  }

  private async reverseGeocode(
    lat: number,
    lng: number
  ): Promise<string> {
    // TODO: integrar reverse geocoding real
    return `Ubicación (${lat}, ${lng})`;
  }
}

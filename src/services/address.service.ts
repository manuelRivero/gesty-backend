import { EnrichedContext } from '../controllers/webhook/types';
import { prisma } from '../lib/prisma';
import { updateConversationState } from '../repositories/conversationState.repository';
import { findCoverageZoneForPoint } from '../repositories/coverageZone.repository';
import { WhatsAppInteractiveMessage, WhatsAppListMessage } from '../domain/intent/whatsappTemplates';
import { buildSmallTalkMenu } from './smallTalk.service';
import {
  ADDRESS_SAVED_PAYMENT_PROMPT_BOT_MESSAGE,
  RETRY_ADDRESS_BOT_MESSAGE,
} from './productQuery/botMessages';
import { formatBotUserMessage } from './productQuery/utils';


export class AddressService {


  async process(ctx: EnrichedContext): Promise<WhatsAppInteractiveMessage | WhatsAppListMessage | string | null> {
    const step = ctx.conversationState?.metadata?.onboarding_step;
    console.log('[AddressService] process', {
      step,
      hasTempAddress: Boolean(ctx.conversationState?.metadata?.temp_address),
      messageType: ctx.message?.type,
      payloadId: ctx.payloadId
    });

    if (!step) {
      if (this.isLocation(ctx.message)) {
        console.log('[AddressService] no step -> capture (location)');
        return this.capture(ctx);
      }
      if (this.isText(ctx.message) && this.isLikelyAddress(ctx.message.text?.body)) {
        console.log('[AddressService] no step -> capture (text)');
        return this.capture(ctx);
      }
      console.log('[AddressService] no step -> start');
      return this.start(ctx);
    }

    switch (step) {
      case 'CAPTURE':
        console.log('[AddressService] step CAPTURE');
        return this.capture(ctx);

      case 'CONFIRM':
        console.log('[AddressService] step CONFIRM', {
          tempAddress: ctx.conversationState?.metadata?.temp_address
        });
        if (ctx.payloadId === 'ONBOARDING_EDIT_ADDRESS') {
          return this.edit(ctx);
        }

        const tempAddress = ctx.conversationState?.metadata?.temp_address;
        const normalizedTemp =
          typeof tempAddress === 'string' ? tempAddress.trim() : '';
        const isInvalidTemp =
          normalizedTemp.length === 0 ||
          normalizedTemp === '[object Object]' ||
          normalizedTemp === 'undefined' ||
          normalizedTemp === 'null';
        if (isInvalidTemp) {
          await this.clearState(ctx);
          return 'No pude recuperar tu dirección anterior. Empecemos de nuevo.\n\n📍 Decime tu dirección o compartí tu ubicación.';
        }
        return this.confirm(ctx);

      default:
        console.log('[AddressService] step default -> start');
        return this.start(ctx);
    }
  }

  async startEdit(ctx: EnrichedContext): Promise<string> {
    return this.edit(ctx);
  }

  async processWithAddressText(
    ctx: EnrichedContext,
    addressText: string
  ): Promise<WhatsAppInteractiveMessage | WhatsAppListMessage | string | null> {
    const cleaned = addressText.trim();
    if (!cleaned) {
      return this.retry('Necesito una dirección con calle y número.');
    }
    return this.handleTextAddress(ctx, cleaned);
  }

  // =========================
  // STEP: START
  // =========================
  private async start(ctx: EnrichedContext): Promise<string> {
    await this.updateState(ctx, {
      onboarding_step: 'CAPTURE',
      onboarding_started_at: new Date().toISOString(),
    });

    return '📍 Para continuar, decime tu dirección o compartí tu ubicación.';
  }

  // =========================
  // STEP: CAPTURE
  // =========================
  private async capture(ctx: EnrichedContext): Promise<WhatsAppInteractiveMessage | WhatsAppListMessage | string> {
    const message = ctx.message;

    if (this.isLocation(message)) {
      return this.handleLocation(ctx);
    }

    if (this.isText(message)) {
      const textBody = message.text?.body || '';
      if (!this.isLikelyAddress(textBody)) {
        return this.retry('Necesito una dirección con calle y número.');
      }
      return this.handleTextAddress(ctx, textBody);
    }

    return this.retry('No entendí el formato 😕');
  }

  private async handleTextAddress(
    ctx: EnrichedContext,
    text: string
  ): Promise<WhatsAppInteractiveMessage | WhatsAppListMessage | string> {

    const geo = await this.geocode(text);

    if (!geo) {
      return this.retry('No pude encontrar esa dirección 😕');
    }

    const zone = await this.getCoverage(geo.lat, geo.lng, ctx.business.id);

    if (!zone) {
      return this.outOfCoverage();
    }

    const formattedAddress =
      typeof geo.formatted === 'string' ? geo.formatted : String(geo.formatted);

    await this.updateState(ctx, {
      onboarding_step: 'CONFIRM',
      temp_address: formattedAddress,
      temp_lat: geo.lat,
      temp_lng: geo.lng,
      temp_zone_id: zone.id,
    });

    return this.buildConfirmAddressMessage(
      `📍 Encontré esta dirección:\n${formattedAddress}\n\n¿Es correcta?`
    );
  }

  private async handleLocation(
    ctx: EnrichedContext
  ): Promise<WhatsAppInteractiveMessage | WhatsAppListMessage | string> {
    const { lat, lng } = ctx.message.location;

    const address = await this.reverseGeocode(lat, lng);
    const formattedAddress = typeof address === 'string' ? address : String(address);

    const zone = await this.getCoverage(lat, lng, ctx.business?.id);

    if (!zone) {
      return this.outOfCoverage();
    }

    await this.updateState(ctx, {
      onboarding_step: 'CONFIRM',
      temp_address: formattedAddress,
      temp_lat: lat,
      temp_lng: lng,
      temp_zone_id: zone.id,
    });

    return this.buildConfirmAddressMessage(
      `📍 Detecté tu ubicación:\n${formattedAddress}\n\n¿Es correcta?`
    );
  }

  // =========================
  // STEP: CONFIRM
  // =========================
  private async confirm(ctx: EnrichedContext): Promise<WhatsAppInteractiveMessage | WhatsAppListMessage | string> {
    const payloadId = ctx.payloadId;
    console.log('[AddressService] confirm', {
      payloadId,
      messageType: ctx.message?.type,
      textBody: ctx.message?.text?.body
    });
    if (payloadId === 'ONBOARDING_CONFIRM_ADDRESS') {
      return this.saveAddress(ctx) as Promise<WhatsAppInteractiveMessage | WhatsAppListMessage | string>;
    }
    if (payloadId === 'ONBOARDING_EDIT_ADDRESS') {
      return this.edit(ctx);
    }

    const textBody = ctx.message?.text?.body;
    const text = typeof textBody === 'string' ? textBody.toLowerCase() : '';

    if (text.includes('confirmar')) {
      return this.saveAddress(ctx) as Promise<WhatsAppInteractiveMessage | WhatsAppListMessage | string>;
    }

    if (text.includes('editar')) {
      return this.edit(ctx);
    }

    const tempAddress = ctx.conversationState?.metadata?.temp_address;
    if (typeof tempAddress === 'string' && tempAddress.trim().length > 0) {
      return this.buildConfirmAddressMessage(
        `📍 Encontré esta dirección:\n${tempAddress}\n\n¿Es correcta?`
      );
    }

    await this.clearState(ctx);
    return 'No pude recuperar tu dirección anterior. Empecemos de nuevo.\n\n📍 Decime tu dirección o compartí tu ubicación.';
  }

  private async saveAddress(ctx: EnrichedContext): Promise<string | WhatsAppListMessage | WhatsAppInteractiveMessage> {
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
      return {
        type: 'interactive',
        interactive: {
          type: 'button',
          body: {
            text: ADDRESS_SAVED_PAYMENT_PROMPT_BOT_MESSAGE,
          },
          action: {
            buttons: [
              { type: 'reply', reply: { id: 'PAY_ONLINE', title: '💳 Pago online' } },
              { type: 'reply', reply: { id: 'PAY_CASH', title: '💵 Efectivo' } },
            ],
          },
        },
      } as WhatsAppInteractiveMessage;
    }

    const menu = await buildSmallTalkMenu(ctx);
    if (menu && typeof menu !== 'string') {
      return menu;
    }

    return formatBotUserMessage(
      'Dirección guardada',
      '✅',
      '¿En qué te ayudo ahora?'
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
  private isLocation(message: any): boolean {
    return !!message?.location;
  }

  private isText(message: any): boolean {
    return !!message?.text;
  }

  private isLikelyAddress(text?: string): boolean {
    if (!text) return false;
    const normalized = text.trim();
    if (normalized.length < 6) return false;
    return /\d/.test(normalized);
  }

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
      awaiting_address,
      pending_address_action,
      ...rest
    } = ctx.conversationState.metadata ?? {};
    await updateConversationState(ctx.conversationId, { metadata: rest });
  }

  private retry(message: string): string {
    return `${message}\n\nProbá con otra dirección 🙏`;
  }

  private outOfCoverage(): string {
    return '🚫 Lo siento, no tenemos cobertura en esa zona.\n\nProbá con otra dirección.';
  }

  private buildConfirmAddressMessage(body: string): WhatsAppInteractiveMessage {
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

import { Prisma } from '@prisma/client';
import type { WhatsAppListMessage } from '../../domain/intent/whatsappTemplates';
import { prisma } from '../../lib/prisma';
import type { ConversationMetadata } from './types';
import {
  normalizeWhatsAppBoldMarkers,
  stripWhatsAppBoldMarkers,
} from '../../utils/whatsappBold';

/** Formato estándar: 🤖, título en negrita + emoji, cuerpo. */
export function formatBotUserMessage(
  boldTitle: string,
  emoji: string,
  body: string
): string {
  const title = stripWhatsAppBoldMarkers(boldTitle);
  const safeBody = normalizeWhatsAppBoldMarkers(body.trim());
  return `🤖\n\n*${title}* ${emoji}\n\n${safeBody}`;
}

export type ParsedBotUserMessage = {
  title: string;
  emoji: string;
  body: string;
};

const BOT_USER_MESSAGE_RE = /^🤖\n\n\*([^*]+)\* ([^\n]+)\n\n([\s\S]*)$/;

/** Extrae título, emoji y body de un mensaje con formato estándar del bot. */
export function parseBotUserMessage(text: string): ParsedBotUserMessage | null {
  const match = BOT_USER_MESSAGE_RE.exec(text.trim());
  if (!match) return null;
  return {
    title: match[1],
    emoji: match[2],
    body: match[3],
  };
}

/** Reensambla el mensaje estándar del bot sin alterar título ni emoji. */
export function rebuildBotUserMessage(
  title: string,
  emoji: string,
  body: string
): string {
  return formatBotUserMessage(title, emoji, body);
}

export const normalizeMetadata = (value: unknown): ConversationMetadata => {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as ConversationMetadata;
  }
  return {};
};

export const buildMetadataValue = (
  metadata: ConversationMetadata
): Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput => {
  return Object.keys(metadata).length === 0
    ? Prisma.JsonNull
    : (metadata as Prisma.InputJsonValue);
};

export const clearProductFilterMetadata = (
  metadata: ConversationMetadata
): ConversationMetadata => {
  if (
    !metadata.pendingProductSelection &&
    !metadata.pendingQuestion &&
    !metadata.candidateProductIds
  ) {
    return metadata;
  }
  const { pendingProductSelection, pendingQuestion, candidateProductIds, ...rest } =
    metadata;
  void pendingProductSelection;
  void pendingQuestion;
  void candidateProductIds;
  return rest;
};

/** Personas en contexto: peopleCount, requestedPartySize o legacy. */
export function getRequestedPartySize(
  meta: ConversationMetadata
): number | undefined {
  const v =
    meta.peopleCount ??
    meta.requestedPartySize ??
    meta.pendingProductQueryQuantity;
  return v != null && v > 0 ? v : undefined;
}

/**
 * Prioridad: cantidad en el mensaje actual; si no, contexto de sesión previo.
 */
export function resolveRequestedPartySize(
  classificationQuantity: number | null | undefined,
  prev: ConversationMetadata
): number | undefined {
  if (classificationQuantity != null && classificationQuantity > 0) {
    return classificationQuantity;
  }
  return getRequestedPartySize(prev);
}

/** Quita la clave legacy al persistir cantidad de personas. */
export function withoutLegacyPartyQuantity(
  meta: ConversationMetadata
): ConversationMetadata {
  const { pendingProductQueryQuantity, ...rest } = meta;
  void pendingProductQueryQuantity;
  return rest;
}

/** Pares de campos a persistir cuando hay N personas detectadas. */
export function partySizeMetadataFields(
  n: number
): Pick<ConversationMetadata, 'requestedPartySize' | 'peopleCount'> {
  return { requestedPartySize: n, peopleCount: n };
}

export const buildListMessage = (params: {
  headerText: string;
  bodyText: string;
  footerText: string;
  actionButtonLabel: string;
  sections: Array<{
    title: string;
    rows: Array<{ id: string; title: string; description: string }>;
  }>;
}): WhatsAppListMessage => ({
  type: 'list',
  header: { type: 'text', text: params.headerText },
  body: { text: params.bodyText },
  footer: { text: params.footerText },
  action: {
    button: params.actionButtonLabel,
    sections: params.sections,
  },
});

/**
 * Lista WhatsApp: `SELECT_PRODUCT:<uuid>` o `SELECT_PRODUCT:<uuid>:<n>` (n = 1–99, p. ej. personas o sugerido).
 */
export function parseSelectProductListRowId(raw: string): {
  productId: string;
  listSuggestedQuantity?: number;
} {
  let s = raw.trim();
  const prefix = 'SELECT_PRODUCT:';
  if (s.startsWith(prefix)) {
    s = s.slice(prefix.length);
  }
  const lastColon = s.lastIndexOf(':');
  if (lastColon > 0) {
    const tail = s.slice(lastColon + 1);
    if (/^\d{1,2}$/.test(tail)) {
      const n = parseInt(tail, 10);
      if (n >= 1 && n <= 99) {
        return {
          productId: s.slice(0, lastColon),
          listSuggestedQuantity: n,
        };
      }
    }
  }
  return { productId: s };
}

export const getActivePrice = async (params: {
  productId: string;
  currency: string | null;
}) => {
  const now = new Date();
  const priceWhere = {
    is_active: true,
    valid_from: { lte: now },
    OR: [{ valid_to: null }, { valid_to: { gte: now } }],
    ...(params.currency ? { currency_code: params.currency } : {}),
  };

  return prisma.menu_item_price.findFirst({
    where: {
      menu_item_id: params.productId,
      ...priceWhere,
    },
    orderBy: { valid_from: 'desc' },
  });
};

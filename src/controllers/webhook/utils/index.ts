import { MenuCategoryTag } from '@prisma/client';
import { HandlerFollowUp, HandlerResult } from '../types';

export const parseProductId = (payloadId: string): string => {
    return payloadId.split(':')[1] ?? '';
};

/**
 * `ADD_ITEM:<productId>` (legacy, sin cantidad explícita) o `ADD_ITEM:<productId>:<qty>` (qty 1–99).
 * Con UUID estándar: parts[1]=id, parts[2]=qty. La cantidad es el último segmento numérico.
 */
export function parseAddItemButtonPayload(payloadId: string): {
  productId: string;
  quantityFromPayload: number | null;
} {
  if (!payloadId.startsWith('ADD_ITEM:')) {
    return { productId: '', quantityFromPayload: null };
  }
  const rest = payloadId.slice('ADD_ITEM:'.length);
  const lastColon = rest.lastIndexOf(':');
  if (lastColon <= 0) {
    return { productId: rest.trim(), quantityFromPayload: null };
  }
  const tail = rest.slice(lastColon + 1).trim();
  if (/^\d{1,2}$/.test(tail)) {
    const n = parseInt(tail, 10);
    if (n >= 1 && n <= 99) {
      return {
        productId: rest.slice(0, lastColon).trim(),
        quantityFromPayload: n,
      };
    }
  }
  return { productId: rest.trim(), quantityFromPayload: null };
}

export const parseQuantity = (payload: string): number | null => {
    const parts = payload.split(":");
    const last = parts[2];
  
    if (!last) return null;
  
    const amount = Number(last);
    return isNaN(amount) ? null : amount;
  };
export const parseCategoryPage = (payloadId: string): { categoryId: string; page: number } => {
    const [, categoryId, pageValue] = payloadId.split(':');
    const page = Number.isFinite(Number(pageValue)) ? Number(pageValue) : 1;
    return { categoryId: categoryId ?? '', page };
};

const MENU_CATEGORY_TAG_VALUES = new Set<string>(
  Object.values(MenuCategoryTag) as string[]
);

/** `MENU_BY_TAG:<TAG>[:<page>]` — page por defecto 1. */
export function parseMenuByTagPayload(
  payloadId: string
): { tag: MenuCategoryTag; page: number } | null {
  const parts = payloadId.split(':');
  if (parts[0] !== 'MENU_BY_TAG' || parts.length < 2) return null;
  const tagStr = parts[1];
  if (!tagStr || !MENU_CATEGORY_TAG_VALUES.has(tagStr)) return null;
  const pageRaw = parts[2];
  const page =
    pageRaw != null && /^\d+$/.test(pageRaw) ? Math.max(1, parseInt(pageRaw, 10)) : 1;
  return { tag: tagStr as MenuCategoryTag, page };
}

export const parsePageOnly = (payloadId: string): number => {
    const [, pageValue] = payloadId.split(':');
    return Number.isFinite(Number(pageValue)) ? Number(pageValue) : 1;
};

export const extractPayloadId = (message: any): string | undefined => {
    if (message.type === 'interactive') {
        console.log('[Extractor] Extracted payloadId:', message.interactive);
        switch (message.interactive.type){
            case 'button_reply':
                console.log('[Extractor] Extracted payloadId:', message.interactive.button_reply.id);
                return message.interactive.button_reply.id;
            case 'list_reply':
                console.log('[Extractor] Extracted payloadId:', message.interactive.list_reply.id);
                return message.interactive.list_reply.id;
            default:
                return undefined;
        }
    }
    return undefined;
};

// src/controllers/webhook/handlerHelpers.ts


export const textResponse = (
  content: string,
  followUps?: HandlerFollowUp[]
): HandlerResult => ({
  content,
  isInteractive: false,
  ...(followUps?.length ? { followUps } : {})
});

export const listResponse = (listMessage: any): HandlerResult => ({
  content: listMessage,
  isInteractive: true
});

export const interactiveResponse = (
  interactiveMessage: any,
  followUps?: HandlerFollowUp[]
): HandlerResult => ({
  content: interactiveMessage,
  isInteractive: true,
  ...(followUps?.length ? { followUps } : {})
});

export const noResponse = (): null => null;

/**
 * Unifica respuestas heterogéneas de handlers/servicios (`string`, plantilla interactiva,
 * o ya un {@link HandlerResult}) al formato que usan `sendResponse` y el persist de mensajes.
 */
export const normalizeToHandlerResult = (result: unknown): HandlerResult => {
  if (
    result &&
    typeof result === 'object' &&
    'content' in result &&
    typeof (result as HandlerResult).isInteractive === 'boolean'
  ) {
    return result as HandlerResult;
  }
  if (typeof result === 'string') {
    return { content: result, isInteractive: false };
  }
  return { content: result as HandlerResult['content'], isInteractive: true };
};
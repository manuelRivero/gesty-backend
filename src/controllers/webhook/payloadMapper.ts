// payloadIntentMapper.ts

import { IntentDetectionResult } from '../../services/ai/detection.service';
import { normalizeIntent } from '../../domain/intent/intentNormalizer';
import { ConversationIntent } from '../../types/conversationIntent';
import { parseAddItemButtonPayload } from './utils';

export const detectIntentFromPayload = (
  payloadId: string
): IntentDetectionResult | null => {

  if (payloadId.startsWith('CONFIRM_INTENT:')) {
    const rawIntent = payloadId.slice('CONFIRM_INTENT:'.length);
    const intent = normalizeIntent(rawIntent);
    if (intent === ConversationIntent.UNKNOWN) {
      return null;
    }
    return buildInteractiveResult(intent, payloadId);
  }

  // Prefijos con ID dinámico
  if (payloadId.startsWith('SELECT_PRODUCT:')) {
    return buildInteractiveResult(
      ConversationIntent.SELECT_PRODUCT,
      payloadId
    );
  }

  if (payloadId.startsWith('SELECT_ORDER_PRODUCT:')) {
    return buildInteractiveResult(
      ConversationIntent.SELECT_ORDER_PRODUCT,
      payloadId
    );
  }

  if (payloadId.startsWith('ADD_ITEM:')) {
    const q = parseAddItemButtonPayload(payloadId).quantityFromPayload;
    return buildInteractiveResult(
      ConversationIntent.ADD_ITEM,
      payloadId,
      q
    );
  }
  if (payloadId.startsWith('CONFIRM_REMOVE:')) {
    return buildInteractiveResult(
      ConversationIntent.CONFIRM_REMOVE,
      payloadId
    );
  }
  if (payloadId.startsWith('CONFIRM_ADD:')) {
    return buildInteractiveResult(
      ConversationIntent.CONFIRM_ADD,
      payloadId
    );
  }

  if (payloadId.startsWith('SELECT_CART_ITEM:')) {
    return buildInteractiveResult(
      ConversationIntent.SELECT_CART_ITEM,
      payloadId
    );
  }
  if (payloadId.startsWith('INCREASE_ITEM_QUANTITY:')) {
    return buildInteractiveResult(
      ConversationIntent.INCREASE_ITEM_QUANTITY,
      payloadId
    );
  }
  if (payloadId.startsWith('DECREASE_ITEM_QUANTITY:')) {
    return buildInteractiveResult(
      ConversationIntent.DECREASE_ITEM_QUANTITY,
      payloadId
    );
  }

  if (
    payloadId === 'CANCEL_REMOVE' ||
    payloadId.startsWith('CANCEL_REMOVE:')
  ) {
    return buildInteractiveResult(
      ConversationIntent.CANCEL_REMOVE,
      payloadId
    );
  }

  if (payloadId.startsWith('CATEGORY_LIST_PAGE:')) {
    return buildInteractiveResult(
      ConversationIntent.CATEGORY_LIST_PAGE,
      payloadId
    );
  }

  if (payloadId.startsWith('MENU_BY_TAG:')) {
    return buildInteractiveResult(
      ConversationIntent.MENU_BY_TAG,
      payloadId
    );
  }

  if (payloadId.startsWith('CATEGORY:')) {
    return buildInteractiveResult(
      ConversationIntent.CATEGORY,
      payloadId
    );
  }

  if (payloadId.startsWith('ORDER_SEARCH_PAGE:')) {
    return buildInteractiveResult(
      ConversationIntent.ORDER_SEARCH_PAGE,
      payloadId
    );
  }
  if (payloadId.startsWith('FEATURED_PAGE:')) {
    return buildInteractiveResult(
      ConversationIntent.FEATURED_PAGE,
      payloadId
    );
  }
  if (payloadId.startsWith('DECREASE_ITEM:')) {
    return buildInteractiveResult(
      ConversationIntent.DECREASE_ITEM,
      payloadId
    );
  }
  if (payloadId.startsWith('INCREASE_ITEM:')) {
    return buildInteractiveResult(
      ConversationIntent.INCREASE_ITEM,
      payloadId
    );
  }

  if (payloadId.startsWith('ONBOARDING_SUBMIT_ADDRESS_TEXT:')) {
    return buildInteractiveResult(ConversationIntent.ONBOARDING_SUBMIT_ADDRESS_TEXT, payloadId);
  }
  if (payloadId.startsWith('ONBOARDING_EDIT_ADDRESS:')) {
    return buildInteractiveResult(ConversationIntent.ONBOARDING_EDIT_ADDRESS, payloadId);
  }
  if (payloadId.startsWith('ONBOARDING_RETRY_ADDRESS:')) {
    return buildInteractiveResult(ConversationIntent.ONBOARDING_RETRY_ADDRESS, payloadId);
  }
  if (payloadId.startsWith('ONBOARDING_COMPLETE:')) {
    return buildInteractiveResult(ConversationIntent.ONBOARDING_COMPLETE, payloadId);
  }
  if (payloadId.startsWith('ONBOARDING_START:')) {
    return buildInteractiveResult(ConversationIntent.ONBOARDING_START, payloadId);
  }
  if (payloadId.startsWith('ONBOARDING_CONFIRM_ADDRESS:')) {
    return buildInteractiveResult(ConversationIntent.ONBOARDING_CONFIRM_ADDRESS, payloadId);
  }
    if (payloadId.startsWith('RESERVATION_ENV:')) {
      return buildInteractiveResult(ConversationIntent.RESERVATION, payloadId);
    }
    if (payloadId.startsWith('RESERVATION_SLOT:')) {
      return buildInteractiveResult(ConversationIntent.RESERVATION, payloadId);
    }


  if (payloadId === 'FULFILLMENT_DELIVERY') {
    return buildInteractiveResult(ConversationIntent.SELECT_DELIVERY, payloadId);
  }
  if (payloadId === 'FULFILLMENT_TAKE_AWAY') {
    return buildInteractiveResult(ConversationIntent.SELECT_TAKE_AWAY, payloadId);
  }

  // IDs estáticos
  const staticMap: Record<string, ConversationIntent> = {
    ORDER_SEARCH_PAGE: ConversationIntent.ORDER_SEARCH_PAGE,
    CHECKOUT: ConversationIntent.CHECKOUT,
    CANCEL_ORDER: ConversationIntent.CANCEL_ORDER,
    END_CONVERSATION: ConversationIntent.END_CONVERSATION,
    VIEW_MENU_RETURN: ConversationIntent.VIEW_MENU_RETURN,
    VIEW_MENU: ConversationIntent.VIEW_MENU,
    VIEW_CART_FOR_EDITION: ConversationIntent.VIEW_CART_FOR_EDITION,
    VIEW_ORDER: ConversationIntent.VIEW_ORDER,
    VIEW_CART: ConversationIntent.VIEW_CART,
    EDIT_ADDRESS: ConversationIntent.EDIT_ADDRESS,
    BUSINESS_HOURS: ConversationIntent.BUSINESS_HOURS,
    VIEW_RESERVATION: ConversationIntent.VIEW_RESERVATION,
    VIEW_QR: ConversationIntent.VIEW_QR,
    COMPLEMENT_SHOW_SUGGESTIONS: ConversationIntent.COMPLEMENT_SHOW_SUGGESTIONS,
    RESERVATION_CONFIRM: ConversationIntent.RESERVATION,
    RESERVATION_CANCEL: ConversationIntent.RESERVATION,
    RESERVATION_RESET: ConversationIntent.RESERVATION,
    RESERVATION_ENV_NONE: ConversationIntent.RESERVATION,
    SUPPORT: ConversationIntent.SUPPORT,
    ASK_QUESTION: ConversationIntent.ASK_QUESTION,
  };

  if (staticMap[payloadId]) {
    return buildInteractiveResult(staticMap[payloadId], payloadId);
  }

  return null;
};

const buildInteractiveResult = (
  intent: ConversationIntent,
  raw: string,
  quantity: number | null = null,
  productId: string | null = null
): IntentDetectionResult & { productId: string | null } => ({
  intent,
  confidence: 1,
  detectedProductName: null,
  quantity,
  addressText: null,
  addressConfidence: null,
  candidates: [],
  alternatives: [],
  resolutionSource: 'direct',
  topCandidate: { intent, confidence: 1 },
  rescueMargin: null,
  raw,
  productId
});
import { Prisma } from '@prisma/client';
import {
  EnrichedContext,
  HandlerResult,
  IntentClassification,
  IntentHandler
} from '../types';
import { interactiveResponse, listResponse, textResponse } from '../utils';
import { ConversationIntent } from '../../../types/conversationIntent';
import { prisma } from '../../../lib/prisma';
import {
  createConversationMessage,
  updateConversationLastMessageAt
} from '../../../repositories';
import {
  findOrCreateConversationState,
  updateConversationState
} from '../../../repositories/conversationState.repository';
import {
  generateFilteredSetResponse,
  generateProductAwareResponse
} from '../../../services/ai/openai.service';
import type { WhatsAppListMessage } from '../../../domain/intent/whatsappTemplates';
import { truncateDescription } from '../../../whatsappBuilders';
import { formatBotUserMessage } from '../../../services/productQuery/utils';
import { persistLastOffer } from '../../../services/lastOffer.service';
import { sendResponse } from '../sender';
import { getRequestedPartySize } from '../../../services/productQuery/utils';

type ConversationMetadata = {
  pendingProductSelection?: boolean;
  pendingQuestion?: string;
  candidateProductIds?: string[];
  pendingProductQueryQuantity?: number;
  requestedPartySize?: number;
};

type ConversationMode = 'GLOBAL' | 'FILTER_SET' | 'PRODUCT_FOCUS';

const normalizeMetadata = (value: unknown): ConversationMetadata => {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as ConversationMetadata;
  }
  return {};
};

const buildMetadataValue = (
  metadata: ConversationMetadata
): Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput => {
  return Object.keys(metadata).length === 0
    ? Prisma.JsonNull
    : (metadata as Prisma.InputJsonValue);
};

const clearProductFilterMetadata = (
  metadata: ConversationMetadata
): ConversationMetadata => {
  if (
    !metadata.pendingProductSelection &&
    !metadata.pendingQuestion &&
    !metadata.candidateProductIds
  ) {
    return metadata;
  }
  const { pendingProductSelection, pendingQuestion, candidateProductIds, ...rest } = metadata;
  void pendingProductSelection;
  void pendingQuestion;
  void candidateProductIds;
  return rest;
};

const buildListMessage = (params: {
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
    sections: params.sections
  }
});

const getActivePrice = async (params: {
  productId: string;
  currency: string | null;
}) => {
  const now = new Date();
  const priceWhere = {
    is_active: true,
    valid_from: { lte: now },
    OR: [{ valid_to: null }, { valid_to: { gte: now } }],
    ...(params.currency ? { currency_code: params.currency } : {})
  };

  return prisma.menu_item_price.findFirst({
    where: {
      menu_item_id: params.productId,
      ...priceWhere
    },
    orderBy: { valid_from: 'desc' }
  });
};

const buildImplicitProductResponse = async (params: {
  business: any;
  customer: any;
  conversationId: string;
  lastReferencedProductId: string;
  userMessage: string;
  requestedPartySize?: number;
}): Promise<string | null> => {
  const product = await prisma.menu_item.findUnique({
    where: { id: params.lastReferencedProductId },
    select: {
      id: true,
      name: true,
      description: true,
      ingredients: true,
      serves_people: true,
      is_available: true
    }
  });

  if (!product) {
    return null;
  }

  const currency =
    params.customer?.preferred_currency ?? params.business?.currency_code ?? null;
  const activePrice = await getActivePrice({
    productId: product.id,
    currency
  });

  const aiResponse = await generateProductAwareResponse({
    businessId: params.business?.id,
    product: {
      name: product.name,
      description: product.description,
      ingredients: product.ingredients,
      serves_people: product.serves_people,
      is_available: product.is_available,
      price: activePrice
        ? {
          amount: activePrice.amount,
          currency_code: activePrice.currency_code
        }
        : null
    },
    userQuestion: params.userMessage,
    requestedPartySize: params.requestedPartySize
  });

  await createConversationMessage(params.conversationId, 'ai', aiResponse, true);
  await updateConversationLastMessageAt(params.conversationId);

  return aiResponse;
};

export class ProductAttributeQuestionHandler implements IntentHandler {
  readonly command = ConversationIntent.PRODUCT_ATTRIBUTE_QUESTION;
  
  canHandle(intent: string): boolean {
    return intent === ConversationIntent.PRODUCT_ATTRIBUTE_QUESTION;
  }

  async execute(
    ctx: EnrichedContext,
  ): Promise<HandlerResult | null> {
    const userMessage = ctx.message?.text?.body || '';
    const mode =
      ((ctx.conversationState as unknown as { mode?: string }).mode ?? 'GLOBAL') as ConversationMode;
    const metadata = normalizeMetadata(ctx.conversationState.metadata);
    const candidateIds = metadata.candidateProductIds ?? null;

    if (mode === 'PRODUCT_FOCUS' && ctx.conversation.lastReferencedProductId) {
      const implicit = await buildImplicitProductResponse({
        business: ctx.business,
        customer: ctx.customer,
        conversationId: ctx.conversation.id,
        lastReferencedProductId: ctx.conversation.lastReferencedProductId,
        userMessage,
        requestedPartySize: getRequestedPartySize(metadata)
      });

      if (implicit) {
        const productId = ctx.conversation.lastReferencedProductId;
        const focused = await prisma.menu_item.findUnique({
          where: { id: productId },
          select: { name: true },
        });
        if (focused?.name) {
          await persistLastOffer({
            conversationId: ctx.conversation.id,
            productId,
            productName: focused.name,
            suggestedQuantity: 1,
            source: 'product_focus',
          });
        }

        return interactiveResponse({
          type: 'interactive',
          interactive: {
            type: 'button',
            body: { text: implicit },
            footer: { text: 'Agregalo al pedido' },
            action: {
              buttons: [
                {
                  type: 'reply',
                  reply: {
                    id: `ADD_ITEM:${ctx.conversation.lastReferencedProductId}:1`,
                    title: 'Agregar'
                  }
                }
              ]
            }
          }
        });
      }
    }

    if (mode === 'FILTER_SET' && candidateIds && candidateIds.length > 0) {
      if (ctx.conversation.lastReferencedProductId) {
        await prisma.conversation.update({
          where: { id: ctx.conversation.id },
          data: { lastReferencedProductId: null }
        });
      }

      const products = await prisma.menu_item.findMany({
        where: { id: { in: candidateIds } },
        select: {
          id: true,
          name: true,
          description: true,
          ingredients: true,
          serves_people: true,
          is_available: true
        }
      });

      if (products.length === 0) {
        return textResponse(
          formatBotUserMessage(
            'Sin coincidencias',
            '🔎',
            'No encontré productos relacionados. ¿Querés intentar otra búsqueda?'
          )
        );
      }

      const result = await generateFilteredSetResponse({
        businessId: ctx.business.id,
        products,
        userQuestion: userMessage
      });

      const recommendedIds = result.recommended_product_ids ?? [];
      const reason = result.reason ?? '';
      const formatReason = (body: string) =>
        formatBotUserMessage('Recomendación', '🍽️', body.trim());

      if (recommendedIds.length === 0) {
        const responseText = reason.trim()
          ? formatReason(reason)
          : formatBotUserMessage(
              'Sin coincidencias',
              '🔎',
              'No encontré una recomendación clara. ¿Querés intentar otra búsqueda?'
            );
        await createConversationMessage(ctx.conversation.id, 'ai', responseText, false);
        await updateConversationLastMessageAt(ctx.conversation.id);
        return textResponse(responseText);
      }

      if (recommendedIds.length === 1) {
        const product = products.find((p) => p.id === recommendedIds[0]);
        if (!product) {
          return textResponse(
            formatBotUserMessage(
              'Producto no encontrado',
              '🔍',
              'No encontré el producto recomendado. ¿Querés intentar de nuevo?'
            )
          );
        }

        await prisma.conversation.update({
          where: { id: ctx.conversation.id },
          data: { lastReferencedProductId: product.id }
        });

        const cleanedMetadata = clearProductFilterMetadata(metadata);
        await updateConversationState(ctx.conversation.id, {
          mode: 'PRODUCT_FOCUS',
          metadata: buildMetadataValue(cleanedMetadata)
        } as Prisma.conversation_stateUpdateInput & { mode?: ConversationMode });

        const messageText = formatReason(
          `${reason}\n\n¿Querés agregar ${product.name}?`
        );
        await createConversationMessage(ctx.conversation.id, 'ai', messageText, false);
        await updateConversationLastMessageAt(ctx.conversation.id);

        await persistLastOffer({
          conversationId: ctx.conversation.id,
          productId: product.id,
          productName: product.name,
          suggestedQuantity: 1,
          source: 'product_attribute',
        });

        return interactiveResponse({
          type: 'interactive',
          interactive: {
            type: 'button',
            header: { type: 'text', text: 'Recomendación' },
            body: { text: messageText },
            footer: { text: 'Elige una opción' },
            action: {
              buttons: [
                {
                  type: 'reply',
                  reply: {
                    id: `ADD_ITEM:${product.id}:1`,
                    title: 'Agregar'
                  }
                }
              ]
            }
          }
        });
      }

      const listMessage = buildListMessage({
        headerText: 'Opciones recomendadas',
        bodyText: formatReason(reason),
        footerText: 'Selecciona uno',
        actionButtonLabel: 'Ver opciones',
        sections: [
          {
            title: 'Recomendaciones',
            rows: products
              .filter((p) => recommendedIds.includes(p.id))
              .map((p) => ({
                id: `SELECT_PRODUCT:${p.id}`,
                title: p.name,
                description: truncateDescription(p.description ?? p.ingredients ?? 'Sin descripción')
              }))
          }
        ]
      });

      await updateConversationState(ctx.conversation.id, {
        mode: 'FILTER_SET',
        metadata: buildMetadataValue({
          pendingProductSelection: true,
          pendingQuestion: userMessage,
          candidateProductIds: recommendedIds
        })
      } as Prisma.conversation_stateUpdateInput & { mode?: ConversationMode });

      await createConversationMessage(ctx.conversation.id, 'ai', formatReason(reason), false);
      await updateConversationLastMessageAt(ctx.conversation.id);

      return listResponse(listMessage);
    }

    const clarification = formatBotUserMessage(
      '¿Sobre qué plato?',
      '🍽️',
      '¿Sobre qué platillo querés saber eso? Podés decirme el nombre o pedirme ver opciones.'
    );
    await createConversationMessage(ctx.conversation.id, 'ai', clarification, false);
    await updateConversationLastMessageAt(ctx.conversation.id);
    return textResponse(clarification);
  }
}

import { Prisma } from '@prisma/client';
import type { WhatsAppInteractiveMessage } from '../../domain/intent/whatsappTemplates';
import type {
  EnrichedContext,
  IntentClassification,
} from '../../controllers/webhook/types';
import {
  createConversationMessage,
  updateConversationLastMessageAt,
  clearLastReferencedProductId,
  setLastReferencedProductId,
} from '../../repositories';
import {
  findOrCreateConversationState,
  updateConversationState,
} from '../../repositories/conversationState.repository';
import { MenuService } from '../menu.service';
import { generateProductAwareResponse } from '../ai/openai.service';
import { truncateDescription, truncateTitle } from '../../whatsappBuilders';
import type { ConversationMode, ProductQueryServiceResult } from './types';
import {
  buildListMessage,
  buildMetadataValue,
  clearProductFilterMetadata,
  formatBotUserMessage,
  getActivePrice,
  normalizeMetadata,
  partySizeMetadataFields,
  resolveRequestedPartySize,
  withoutLegacyPartyQuantity,
} from './utils';
import { buildRecommendationCartSummary } from './recommendationCartSummary';
import {
  dedupeMenuItemSearchResultsById,
  formatSmartRecommendationsBlock,
  formatSingleProductPortionHint,
  getSmartRecommendations,
  suggestedUnitsForListRow,
} from './smartFoodRecommendations';

/**
 * Flujo PRODUCT_QUERY: búsqueda, estado y payloads para WhatsApp (sin envolver en HandlerResult).
 */
export async function executeProductQuery(
  ctx: EnrichedContext,
  classification?: IntentClassification
): Promise<ProductQueryServiceResult> {
  const keyword = classification?.detectedProductName?.trim() ?? '';
  const userMessage = ctx.message?.text?.body || '';

  if (!keyword) {
    return formatBotUserMessage(
      'Tu búsqueda',
      '🔍',
      '¿Qué producto estás buscando? Escribí el nombre o una palabra clave.'
    );
  }

  const rawSearch = await MenuService.searchMenuItemsByKeyword({
    businessId: ctx.business.id,
    keyword,
  });
  const items = dedupeMenuItemSearchResultsById(rawSearch);

  if (items.length === 0) {
    const bodyCopy = `No encontramos productos relacionados con "${keyword}" en nuestro menú.`;
    const fullText = formatBotUserMessage('Sin coincidencias', '🔎', bodyCopy);
    await createConversationMessage(ctx.conversation.id, 'ai', fullText, false);
    await updateConversationLastMessageAt(ctx.conversation.id);
    const interactive: WhatsAppInteractiveMessage = {
      type: 'interactive',
      interactive: {
        type: 'button',
        header: { type: 'text', text: '' },
        body: { text: fullText },
        footer: { text: 'Elegí una opción' },
        action: {
          buttons: [
            {
              type: 'reply',
              reply: {
                id: 'VIEW_MENU',
                title: 'Ver menú',
              },
            },
          ],
        },
      },
    };
    return interactive;
  }

  if (items.length > 1) {
    const stateMulti = await findOrCreateConversationState(ctx.conversation.id);
    const rawPrevMulti = normalizeMetadata(stateMulti.metadata);
    const partySize = resolveRequestedPartySize(
      classification?.quantity,
      rawPrevMulti
    );
    const prevMulti = withoutLegacyPartyQuantity(rawPrevMulti);

    const cartSummary = await buildRecommendationCartSummary({
      businessId: ctx.business.id,
      customerPhone: ctx.customer.phone_number,
    });

    const smart = await getSmartRecommendations({
      userQuery: userMessage.trim() || keyword,
      businessId: ctx.business.id,
      business: ctx.business,
      vectorResults: items,
      requestedPartySize: partySize,
      cartSummary,
      customerPhone: ctx.customer.phone_number,
      nextActionHintsShown: prevMulti.nextActionHintsShown ?? null,
    });

    const listSource = smart.forList.length > 0 ? smart.forList : items;

    await updateConversationState(ctx.conversation.id, {
      mode: 'FILTER_SET',
      metadata: buildMetadataValue({
        ...prevMulti,
        pendingProductSelection: true,
        pendingQuestion: userMessage,
        candidateProductIds: [...new Set(listSource.map((item) => item.id))],
        ...(partySize != null ? partySizeMetadataFields(partySize) : {}),
        ...(smart.nextActionHintKey
          ? {
              nextActionHintsShown: {
                ...(prevMulti.nextActionHintsShown ?? {}),
                [smart.nextActionHintKey]: true,
              },
            }
          : {}),
      }),
    } as Prisma.conversation_stateUpdateInput & { mode?: ConversationMode });

    if (ctx.conversation.lastReferencedProductId) {
      await clearLastReferencedProductId(ctx.conversation.id);
    }

    const recBlock =
      smart.forDisplay.length > 0
        ? formatSmartRecommendationsBlock(
            smart.forDisplay,
            smart.llmNote,
            smart.llmProgress,
            partySize
          )
        : '';

    const mainGuide = smart.mainCoverageGuidance?.trim()
      ? `${smart.mainCoverageGuidance.trim()}\n\n`
      : '';

    const nextActionGuide = smart.nextActionMessage?.trim()
      ? `${smart.nextActionMessage.trim()}\n\n`
      : '';

    const fallbackNoLlmPortion =
      smart.forDisplay.length === 0 &&
      partySize != null &&
      partySize > 0 &&
      listSource.length > 0
        ? `Para ${partySize} persona${partySize === 1 ? '' : 's'} podés elegir en la lista y ajustar unidades en el siguiente paso 👇`
        : '';

    const intro =
      smart.forDisplay.length > 0
        ? `${mainGuide}${nextActionGuide}${recBlock}\n\nSeleccioná en la lista 👇`
        : `${mainGuide}${nextActionGuide}${fallbackNoLlmPortion ? `${fallbackNoLlmPortion}\n\n` : ''}Seleccioná un plato en la lista 👇`;

    const listBody = formatBotUserMessage('Resultados a tu consulta', '📋', intro);

    const listMessage = buildListMessage({
      headerText: '',
      bodyText: listBody,
      footerText: 'Elegí una opción',
      actionButtonLabel: 'Ver opciones',
      sections: [
        {
          title: 'Resultados',
          rows: listSource.map((item) => {
            const rec = smart.forList.find((r) => r.id === item.id);
            const fromLlm = rec?.suggestedQuantity;
            const fromPortion = suggestedUnitsForListRow(
              item.serves_people,
              partySize
            );
            const effectiveListQty =
              fromLlm != null && fromLlm >= 2
                ? fromLlm
                : fromPortion != null
                  ? fromPortion
                  : undefined;
            const rowId =
              effectiveListQty != null && effectiveListQty >= 2
                ? `SELECT_PRODUCT:${item.id}:${effectiveListQty}`
                : `SELECT_PRODUCT:${item.id}`;
            const descRaw = (
              item.description ??
              ('ingredients' in item ? item.ingredients : null) ??
              ''
            ).trim();
            return {
              id: rowId,
              title: truncateTitle((item.name ?? '').trim() || 'Producto'),
              description: truncateDescription(
                descRaw.length > 0 ? descRaw : 'Sin descripción'
              ),
            };
          }),
        },
      ],
    });

    await createConversationMessage(
      ctx.conversation.id,
      'ai',
      listMessage.body.text,
      false
    );
    await updateConversationLastMessageAt(ctx.conversation.id);

    return listMessage;
  }

  const matchedItem = items[0];
  const stateSingle = await findOrCreateConversationState(ctx.conversation.id);
  const rawPrevSingle = normalizeMetadata(stateSingle.metadata);
  const partySizeSingle = resolveRequestedPartySize(
    classification?.quantity,
    rawPrevSingle
  );
  const prevSingle = withoutLegacyPartyQuantity(rawPrevSingle);

  const currency =
    ctx.customer.preferred_currency ?? ctx.business.currency_code ?? null;
  const activePrice = await getActivePrice({
    productId: matchedItem.id,
    currency,
  });

  const aiResponse = await generateProductAwareResponse({
    product: {
      name: matchedItem.name,
      description: matchedItem.description,
      ingredients: matchedItem.ingredients,
      serves_people: matchedItem.serves_people,
      is_available: matchedItem.is_available,
      price: activePrice
        ? {
            amount: activePrice.amount,
            currency_code: activePrice.currency_code,
          }
        : null,
    },
    userQuestion: userMessage,
    requestedPartySize: partySizeSingle,
  });

  const portionSingle =
    partySizeSingle != null && partySizeSingle > 0
      ? `\n\n${formatSingleProductPortionHint(
          matchedItem.serves_people,
          partySizeSingle
        )}`
      : '';
  const fullText = formatBotUserMessage(
    'Info del plato',
    '🍽️',
    `${aiResponse}${portionSingle}`
  );

  await createConversationMessage(ctx.conversation.id, 'ai', fullText, true);
  await updateConversationLastMessageAt(ctx.conversation.id);

  await setLastReferencedProductId(ctx.conversation.id, matchedItem.id);

  const cleanedSingle = clearProductFilterMetadata(prevSingle);
  const nextSingleMeta = {
    ...cleanedSingle,
    ...(partySizeSingle != null
      ? partySizeMetadataFields(partySizeSingle)
      : {}),
  };
  await updateConversationState(ctx.conversation.id, {
    mode: 'PRODUCT_FOCUS',
    metadata: buildMetadataValue(nextSingleMeta),
  } as Prisma.conversation_stateUpdateInput & { mode?: ConversationMode });

  return fullText;
}

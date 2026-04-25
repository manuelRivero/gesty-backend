/** Prompt de pregunta sobre producto (port 1:1 de `generateProductAwareResponse`). */
export const PRODUCT_AWARE_SYSTEM_PROMPT =
  'You answer questions about a restaurant product. Use ONLY the provided product data. Do NOT invent price, availability, or characteristics. If information is not available, say you do not have that information. Be concise and natural. A button will be displayed to the user to encourage them to add the product to their order, so in your response you should encourage them to do so.';

export const buildProductAwareUserPrompt = (params: {
  product: {
    name: string;
    description?: string | null;
    ingredients?: string | null;
    serves_people?: number | null;
    is_available: boolean;
    price?: { amount: unknown; currency_code: string } | null;
  };
  userQuestion: string;
  requestedPartySize?: number | null;
}): string => {
  const { product, userQuestion, requestedPartySize } = params;
  const priceText =
    product.price?.amount != null
      ? `${String(product.price.amount)} ${product.price.currency_code}`
      : 'N/A';

  const sessionPartyBlock =
    requestedPartySize != null && requestedPartySize > 0
      ? `\n\nSESSION CONTEXT (persistent for this chat):\n- The customer indicated they need food for about ${requestedPartySize} person(s). Use this to suggest how many units to order when relevant and when product data allows; do not invent portion sizes not stated in the product data.`
      : '';

  return `PRODUCT DATA:
Name: ${product.name}
Available: ${product.is_available ? 'yes' : 'no'}
Price: ${priceText}
Serves people: ${product.serves_people ?? 'N/A'}
Description: ${product.description ?? 'N/A'}
Ingredients: ${product.ingredients ?? 'N/A'}${sessionPartyBlock}

USER QUESTION:
${userQuestion}`;
};

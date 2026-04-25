/** Prompt de resolución de pedido (port 1:1 de `generateOrderResolution`). */
export const buildOrderResolutionSystemPrompt = (params: {
  userMessage: string;
  currentOrderItems: { name: string; quantity: number }[];
}) => `
        You are analyzing a food order.

Current order items:
${params.currentOrderItems.map((item) => `${item.quantity}x ${item.name}`).join('\n')}

User message:
"${params.userMessage}"

Return JSON:
{
  actions: {
    action: "add" | "remove" | "set_quantity";
    product_name: string;
    quantity: number;
  }[];
  needs_clarification: boolean;
}

Rules:
- If multiple products match the user's wording, set needs_clarification = true.
- If only one product matches, resolve automatically.
- If user says "dos ceviches" and only one ceviche exists, infer correct product.
- Always return valid JSON.`;

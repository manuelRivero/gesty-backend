import OpenAI from 'openai';
import type { business as Business } from '@prisma/client';
import type { OpenAI as OpenAITypes } from 'openai';
import { prisma } from '../../lib/prisma';
import { evaluateBusinessBillingAccess } from '../billing/evaluateBusinessBillingAccess.service';
import { getEffectiveAiTokenLimit } from './aiLimits';
import { incrementUsage } from './aiUsage.service';
import {
  buildFilteredSetSystemPrompt,
  buildProductAwareSystemPrompt,
} from '../../prompts/botPersonality';
import { resolvePersonalityPromptText } from '../botPersonality.service';
import { getBusinessConfig } from '../businessConfig.service';
import { buildProductAwareUserPrompt } from '../../prompts/productAware';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const zeroUsage = () => ({
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  estimatedCostUsd: 0
});

export const generateAIResponse = async (
  business: Business,
  messages: OpenAITypes.Chat.ChatCompletionMessageParam[]
): Promise<{
  content: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    estimatedCostUsd: number;
  };
}> => {
  if (business.ai_blocked) {
    return {
      content:
        '🚫 Tu cuenta está bloqueada por superar el límite mensual de IA. Actualiza tu plan para continuar.',
      usage: zeroUsage()
    };
  }

  const trialAccess = await evaluateBusinessBillingAccess(business);
  if (!trialAccess.ok) {
    return {
      content: trialAccess.message,
      usage: zeroUsage()
    };
  }

  const updatedBusiness = trialAccess.business;

  const effectiveLimit = getEffectiveAiTokenLimit(updatedBusiness);

  if (updatedBusiness.ai_monthly_tokens_used >= effectiveLimit) {
    await prisma.business.update({
      where: { id: updatedBusiness.id },
      data: { ai_blocked: true }
    });

    return {
      content:
        '⚡ Tu plan mensual de IA se agotó. Actualiza tu plan para seguir respondiendo automáticamente.',
      usage: zeroUsage()
    };
  }

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages
    });

    const promptTokens = response.usage?.prompt_tokens ?? 0;
    const completionTokens = response.usage?.completion_tokens ?? 0;
    const totalTokens = response.usage?.total_tokens ?? 0;

    const promptCost = (promptTokens / 1000) * 0.00015;
    const completionCost = (completionTokens / 1000) * 0.0006;
    const estimatedCostUsd = promptCost + completionCost;

    await incrementUsage(updatedBusiness.id, totalTokens);

    return {
      content: response.choices[0]?.message?.content ?? '',
      usage: {
        promptTokens,
        completionTokens,
        totalTokens,
        estimatedCostUsd
      }
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Error desconocido';
    throw new Error(`Error al generar respuesta de OpenAI: ${message}`);
  }
};

export const generateProductAwareResponse = async (params: {
  businessId?: string;
  product: {
    name: string;
    description?: string | null;
    ingredients?: string | null;
    serves_people?: number | null;
    is_available: boolean;
    price?: {
      amount: unknown;
      currency_code: string;
    } | null;
    variations?: string[] | null;
  };
  userQuestion: string;
  /** Contexto de sesión: personas/comensales mencionados antes en el flujo (ej. "para 3"). */
  requestedPartySize?: number | null;
}): Promise<string> => {
  const { product, userQuestion, requestedPartySize, businessId } = params;

  console.log('---- LLM PRODUCT CALL ----');
  console.log('Product name:', product.name);
  console.log('User question sent to LLM:', userQuestion);
  console.log('---------------------------');

  const personalityPrompt = businessId
    ? await resolvePersonalityPromptText(
        (await getBusinessConfig(businessId)).bot_personality_id
      )
    : undefined;
  const systemPrompt = buildProductAwareSystemPrompt(personalityPrompt);

  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0.2,
    messages: [
      {
        role: 'system',
        content: systemPrompt,
      },
      {
        role: 'user',
        content: buildProductAwareUserPrompt({
          product,
          userQuestion,
          requestedPartySize,
        }),
      },
    ],
  });

  const content = response.choices[0]?.message?.content ?? '';
  console.log('LLM response:', content);
  return content;
};

export const extractOrderData = async (
  message: string
): Promise<{ quantity: number | null; confidence: number }> => {
  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: `You are a data extraction engine.
Extract structured order data from the user's message.

Return STRICT JSON:

{
  "quantity": number | null,
  "confidence": number
}

Rules:
- If user expresses ordering intent but no explicit quantity, assume quantity = 1
- Recognize numbers written as digits or words in Spanish.
- Recognize informal expressions.
- If no quantity can be inferred, return quantity = null.
- Confidence between 0 and 1.
- If the user mentions an ingredient (e.g. papa, arroz, tomate),
interpret it as a question about whether the selected product contains that ingredient.
Do NOT treat it as a new topic.
Always answer in relation to the provided product.
Return ONLY JSON.

Examples:

Input: "Te pido 3"
Output: {"quantity":3,"confidence":0.95}

Input: "Dame uno"
Output: {"quantity":1,"confidence":0.9}

Input: "Agregame dos mas"
Output: {"quantity":2,"confidence":0.95}

Input: "Lo quiero"
Output: {"quantity":1,"confidence":0.8}

Input: "Tal vez luego"
Output: {"quantity":null,"confidence":0.2}`
      },
      {
        role: 'user',
        content: message
      }
    ]
  });

  const content = response.choices[0]?.message?.content ?? '';
  try {
    const parsed = JSON.parse(content) as {
      quantity?: number | null;
      confidence?: number;
    };
    const quantity =
      typeof parsed.quantity === 'number' || parsed.quantity === null
        ? parsed.quantity
        : null;
    const confidence =
      typeof parsed.confidence === 'number' ? parsed.confidence : 0;
    return { quantity, confidence };
  } catch (error) {
    return { quantity: null, confidence: 0 };
  }
};

export const generateOrderExtraction = async (params: {
  userMessage: string;
}): Promise<{ quantity: number }> => {
  const response = await openai.chat.completions.create({
    model: 'gpt-4o',
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: `Extrae la cantidad de productos que el usuario desea pedir.
Si no se menciona cantidad explícita, devolver 1.
Si está en palabras ("dos", "tres", "un", "una"), convertir a número.
Si es ambiguo, devolver 1.

Responde SOLO en JSON:
{
"quantity": number
}`
      },
      {
        role: 'user',
        content: params.userMessage
      }
    ]
  });

  const content = response.choices[0]?.message?.content ?? '';
  try {
    const parsed = JSON.parse(content) as { quantity?: number };
    const quantity = typeof parsed.quantity === 'number' ? parsed.quantity : 1;
    return { quantity };
  } catch (error) {
    return { quantity: 1 };
  }
};

export const generateOrderActionAnalysis = async (params: {
  userMessage: string;
  currentProductName: string | null;
}): Promise<{ action: 'add' | 'add_same' | 'add_other' | 'remove' | 'unclear' }> => {
  const response = await openai.chat.completions.create({
    model: 'gpt-4o',
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: `
Eres un poderoso asistente que analiza los mensajes del usuario para determinar su intención cuando ordena comida.
el usuario está interactuando con su pedido.
Producto actualmente en contexto:
"${params.currentProductName ?? 'NINGUNO'}"

Mensaje del usuario:
"${params.userMessage}"

Determina qué está intentando hacer el usuario.

Responde SOLO en JSON:

{
"action": "add" | "add_same" | "add_other" | "remove" | "unclear"
}

Reglas:

"add" → quiere agregar el producto actual.

"add_same" → quiere agregar más del producto actual.

"add_other" → quiere agregar otro producto distinto.

"remove" → quiere quitar un producto del pedido.

"unclear" → no es claro.

No expliques nada. Solo JSON válido.`
      }
    ]
  });

  const content = response.choices[0]?.message?.content ?? '';
  try {
    const parsed = JSON.parse(content) as { action?: string };
    const action =
      parsed.action === 'add_same' ||
        parsed.action === 'add_other' ||
        parsed.action === 'remove' ||
        parsed.action === 'unclear'
        ? parsed.action
        : 'unclear';
    return { action };
  } catch (error) {
    return { action: 'unclear' };
  }
};

export const generateOrderResolution = async ({
  userMessage,
  currentOrderItems
}: {
  userMessage: string;
  currentOrderItems: {
    name: string;
    quantity: number;
  }[];
}): Promise<{
  actions: {
    action: "add" | "remove" | "set_quantity";
    product_name: string;
    quantity: number;
  }[];
  needs_clarification: boolean;
}> => {
  const response = await openai.chat.completions.create({
    model: 'gpt-4o',
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: `
        You are analyzing a food order.

Current order items:
${currentOrderItems.map((item) => `${item.quantity}x ${item.name}`).join('\n')}

User message:
"${userMessage}"

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
- Always return valid JSON.`}
    ]
  });

  const content = response.choices[0]?.message?.content ?? '';
  try {
    const parsed = JSON.parse(content);
    return { actions: parsed.actions, needs_clarification: parsed.needs_clarification ?? false };
  } catch (error) {
    return { actions: [], needs_clarification: false };
  }
};

export const generateFilteredSetResponse = async ({
  businessId,
  products,
  userQuestion
}: {
  businessId?: string;
  products: {
    id: string;
    name: string;
    description?: string | null;
    ingredients?: string | null;
  }[];
  userQuestion: string;
}) => {
  const personalityPrompt = businessId
    ? await resolvePersonalityPromptText(
        (await getBusinessConfig(businessId)).bot_personality_id
      )
    : undefined;
  const systemPrompt = buildFilteredSetSystemPrompt(personalityPrompt);

  const productList = products.map(p => `
ID: ${p.id}
Nombre: ${p.name}
Descripción: ${p.description ?? ''}
Ingredientes: ${p.ingredients ?? ''}
`).join('\n');

  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: `
Productos disponibles:
${productList}

Condición:
${userQuestion}
`
      }
    ]
  });

  const text = response.choices[0]?.message?.content ?? '{}';

  try {
    return JSON.parse(text);
  } catch {
    return {
      recommended_product_ids: [],
      reason: 'No pude procesar la recomendación.'
    };
  }
};

export const getProductEmbedding = async (
  keyword: string
): Promise<number[]> => {
  // 1️⃣ Generar embedding del query
  const embeddingResponse = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: keyword
  });

  const queryEmbedding = embeddingResponse.data[0].embedding;
  return queryEmbedding;
}
/**
 * Enriquecimiento automático de productos via LLM.
 *
 * Genera metadatos optimizados para WhatsApp Business y recuperación semántica
 * (RAG) a partir de los campos primarios del producto. Los datos originales del
 * negocio en `menu_item` nunca son modificados por este servicio.
 *
 * El flujo esperado es:
 *   1. Admin crea/edita un producto (datos originales, sin cambios).
 *   2. Admin solicita `generateMenuItemEnrichment()` — se obtiene un borrador.
 *   3. Admin revisa/edita el borrador en el cliente.
 *   4. Admin guarda el borrador aprobado en `menu_item_ai_metadata`.
 */

import OpenAI from 'openai';
import { prisma } from '../../lib/prisma';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/** Campos derivados generados por IA. Ninguno existe en `menu_item`. */
export type MenuItemAiMetadataDraft = {
  display_name: string;
  short_description: string;
  search_keywords: string[];
  synonyms: string[];
  category_suggestion: string;
  product_tags: string[];
};

const ENRICHMENT_SYSTEM_PROMPT = `Eres un especialista en marketing de restaurantes con experiencia en WhatsApp Business y sistemas de búsqueda semántica (RAG).

Tu tarea es analizar los datos de un producto de menú y generar metadatos de marketing optimizados.

Criterios de calidad:
- display_name: nombre atractivo y apetitoso (máximo 24 caracteres, sin emojis). Este campo se usa directamente como título de fila en listas interactivas de WhatsApp.
- short_description: gancho de venta que destaque el diferencial del producto (máximo 72 caracteres). Este campo se usa como descripción de fila en listas interactivas de WhatsApp.
- search_keywords: 5 a 10 términos que un cliente usaría al buscar este producto. Incluye variaciones, ingredientes principales y contextos de consumo.
- synonyms: nombres alternativos o regionales del producto (2 a 5 términos).
- category_suggestion: una única etiqueta de categoría clara (ej: "Plato fuerte", "Entrada", "Postre", "Bebida fría").
- product_tags: etiquetas descriptivas sobre características dietarias, preparación o perfil de sabor (ej: vegetariano, sin gluten, picante, artesanal).

Responde ÚNICAMENTE con un objeto JSON válido, sin texto adicional, sin markdown, sin comentarios.`;

function buildEnrichmentUserPrompt(params: {
  name: string;
  description: string | null;
  ingredients: string | null;
  preparation: string | null;
  categoryName: string;
  categoryTag: string;
  price: string;
}): string {
  return `Producto de menú:
- Nombre: ${params.name}
- Descripción: ${params.description ?? '(no especificada)'}
- Ingredientes: ${params.ingredients ?? '(no especificados)'}
- Preparación: ${params.preparation ?? '(no especificada)'}
- Categoría: ${params.categoryName} (${params.categoryTag})
- Precio: ${params.price}

Genera los metadatos de marketing en el siguiente formato JSON exacto:
{
  "display_name": "...",
  "short_description": "...",
  "search_keywords": ["...", "..."],
  "synonyms": ["...", "..."],
  "category_suggestion": "...",
  "product_tags": ["...", "..."]
}`;
}

function parseDraft(raw: string): MenuItemAiMetadataDraft {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('ENRICHMENT_INVALID_JSON');
    }
    parsed = JSON.parse(jsonMatch[0]);
  }

  const obj = parsed as Record<string, unknown>;

  const ensureStringArray = (val: unknown): string[] => {
    if (!Array.isArray(val)) return [];
    return val.filter((v): v is string => typeof v === 'string');
  };

  return {
    display_name: typeof obj.display_name === 'string' ? obj.display_name : '',
    short_description: typeof obj.short_description === 'string' ? obj.short_description : '',
    search_keywords: ensureStringArray(obj.search_keywords),
    synonyms: ensureStringArray(obj.synonyms),
    category_suggestion: typeof obj.category_suggestion === 'string' ? obj.category_suggestion : '',
    product_tags: ensureStringArray(obj.product_tags)
  };
}

/**
 * Genera un borrador de metadatos AI para un `menu_item`.
 *
 * Lee los campos primarios del producto desde la base de datos, invoca el LLM
 * y retorna el borrador estructurado. **No persiste nada.**
 *
 * @throws 'MENU_ITEM_NOT_FOUND' si el id no corresponde a ningún producto.
 * @throws 'ENRICHMENT_INVALID_JSON' si el LLM no devuelve JSON parseable.
 */
export async function generateMenuItemEnrichment(
  menuItemId: string
): Promise<MenuItemAiMetadataDraft> {
  const now = new Date();

  const item = await prisma.menu_item.findUnique({
    where: { id: menuItemId },
    include: {
      menu_category: {
        select: { name: true, category_tag: true }
      },
      menu_item_price: {
        where: {
          is_active: true,
          valid_from: { lte: now },
          OR: [{ valid_to: null }, { valid_to: { gte: now } }]
        },
        orderBy: { valid_from: 'desc' },
        take: 1
      }
    }
  });

  if (!item) {
    throw new Error('MENU_ITEM_NOT_FOUND');
  }

  const activePrice = item.menu_item_price[0];
  const priceText = activePrice
    ? `${activePrice.amount.toString()} ${activePrice.currency_code}`
    : 'no especificado';

  const userPrompt = buildEnrichmentUserPrompt({
    name: item.name,
    description: item.description,
    ingredients: item.ingredients,
    preparation: item.preparation,
    categoryName: item.menu_category?.name ?? '',
    categoryTag: item.menu_category?.category_tag ?? '',
    price: priceText
  });

  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0.4,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: ENRICHMENT_SYSTEM_PROMPT },
      { role: 'user', content: userPrompt }
    ]
  });

  const rawContent = response.choices[0]?.message?.content ?? '';
  return parseDraft(rawContent);
}

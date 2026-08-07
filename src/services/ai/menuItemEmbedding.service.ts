/**
 * Mantenimiento del vector `menu_item.embedding` (pgvector).
 *
 * Centraliza la plantilla de texto que se embeda y el `UPDATE` final, para que
 * el script de seed masivo (`scripts/embedding/create-menu_item-vector.ts`) y
 * los hooks de admin (create/update de productos y precio) compartan la misma
 * lógica y la columna `embedding` quede siempre consistente con el resto del
 * registro.
 *
 * Cuando existen metadatos AI en `menu_item_ai_metadata`, se incorporan al
 * texto embebido para enriquecer la recuperación semántica. Los datos
 * originales del negocio siempre preceden a los campos derivados por IA.
 */

import { prisma } from '../../lib/prisma';
import { getProductEmbedding } from './openai.service';

type AiMetadataForEmbedding = {
  display_name: string | null;
  search_keywords: string[] | null;
  synonyms: string[] | null;
  product_tags: string[] | null;
};

/**
 * Construye el texto que alimenta al modelo de embeddings.
 *
 * Incluye los campos que el agente usa para discriminar productos por
 * similitud: nombre, descripción, ingredientes, porciones, disponibilidad,
 * categoría y precio activo. Si el item no existe devuelve `null`.
 */
export async function buildMenuItemEmbeddingText(
  menuItemId: string
): Promise<string | null> {
  const now = new Date();
  const item = await prisma.menu_item.findUnique({
    where: { id: menuItemId },
    include: {
      menu_category: {
        select: {
          name: true,
          description: true
        }
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

  if (!item) return null;

  const activePrice = item.menu_item_price[0];
  const priceText = activePrice
    ? `${activePrice.amount.toString()} ${activePrice.currency_code}`
    : '';

  // Campos primarios — fuente de verdad del negocio.
  const primaryLines = [
    `Nombre: ${item.name}`,
    `Descripción: ${item.description ?? ''}`,
    `Ingredientes: ${item.ingredients ?? ''}`,
    `Sirve personas: ${item.serves_people ?? ''}`,
    `Disponible: ${item.is_available ? 'sí' : 'no'}`,
    `Categoría: ${item.menu_category?.name ?? ''}`,
    `Categoría descripción: ${item.menu_category?.description ?? ''}`,
    `Precio: ${priceText}`,
    `Variaciones: ${item.variations.join(', ')}`
  ];

  // Metadatos AI enriquecidos — opcionales, nunca sobreescriben los primarios.
  const aiRows = await prisma.$queryRaw<AiMetadataForEmbedding[]>`
    SELECT display_name, search_keywords, synonyms, product_tags
    FROM menu_item_ai_metadata
    WHERE menu_item_id = ${menuItemId}::uuid
    LIMIT 1
  `;

  const ai = aiRows[0];
  const aiLines: string[] = [];

  if (ai) {
    if (ai.display_name) {
      aiLines.push(`Nombre alternativo: ${ai.display_name}`);
    }
    if (ai.search_keywords?.length) {
      aiLines.push(`Palabras clave: ${ai.search_keywords.join(', ')}`);
    }
    if (ai.synonyms?.length) {
      aiLines.push(`Sinónimos: ${ai.synonyms.join(', ')}`);
    }
    if (ai.product_tags?.length) {
      aiLines.push(`Tags: ${ai.product_tags.join(', ')}`);
    }
  }

  const allLines = aiLines.length
    ? [...primaryLines, '-- AI Enhanced --', ...aiLines]
    : primaryLines;

  return allLines.join('\n');
}

/**
 * Genera el embedding del item y lo persiste en la columna `embedding`.
 *
 * Versión `await` — propaga errores. Usar desde scripts batch o cuando el
 * caller realmente quiera saber si falló. Desde el flujo admin preferimos
 * `scheduleMenuItemEmbeddingRefresh` para no bloquear el response.
 */
export async function refreshMenuItemEmbedding(
  menuItemId: string
): Promise<{ updated: boolean; reason?: string }> {
  const text = await buildMenuItemEmbeddingText(menuItemId);
  if (text == null) {
    return { updated: false, reason: 'item_not_found' };
  }

  const vector = await getProductEmbedding(text);
  const vectorLiteral = `[${vector.join(',')}]`;

  await prisma.$executeRaw`
    UPDATE menu_item
    SET embedding = ${vectorLiteral}::vector
    WHERE id = ${menuItemId}::uuid
  `;

  return { updated: true };
}


/**
 * CRUD para `menu_item_ai_metadata`.
 *
 * Usa raw SQL exclusivamente (prisma.$queryRaw / prisma.$executeRaw) para no
 * depender del modelo Prisma, ya que el schema se sincroniza desde
 * food-service-backend y agregar el modelo aquí sería sobrescrito en cada sync.
 *
 * La tabla fue creada por:
 *   scripts/migrations/add-menu-item-ai-metadata.sql
 */

import { prisma } from '../lib/prisma';
import { refreshMenuItemEmbedding } from './ai/menuItemEmbedding.service';
import type { MenuItemAiMetadataDraft } from './ai/menuItemEnrichment.service';

export type MenuItemAiMetadataRow = MenuItemAiMetadataDraft & {
  id: string;
  menu_item_id: string;
  model_version: string;
  generated_at: Date;
  extra: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
};

/**
 * Devuelve los metadatos AI almacenados para un `menu_item`, o `null` si aún
 * no fue enriquecido.
 */
export async function getMenuItemAiMetadata(
  menuItemId: string
): Promise<MenuItemAiMetadataRow | null> {
  const rows = await prisma.$queryRaw<MenuItemAiMetadataRow[]>`
    SELECT
      id,
      menu_item_id,
      display_name,
      short_description,
      search_keywords,
      synonyms,
      category_suggestion,
      product_tags,
      model_version,
      generated_at,
      extra,
      created_at,
      updated_at
    FROM menu_item_ai_metadata
    WHERE menu_item_id = ${menuItemId}::uuid
    LIMIT 1
  `;

  return rows[0] ?? null;
}

/**
 * Persiste (UPSERT) los metadatos AI aprobados por el usuario para un
 * `menu_item` y regenera el embedding RAG para incorporar los nuevos campos.
 *
 * La columna `generated_at` se actualiza en cada guardado para reflejar cuándo
 * el usuario aprobó los metadatos (no solo cuándo se generaron).
 *
 * @returns Los metadatos guardados tras el UPSERT.
 */
export async function saveMenuItemAiMetadata(
  menuItemId: string,
  draft: MenuItemAiMetadataDraft & { modelVersion?: string }
): Promise<MenuItemAiMetadataRow> {
  const modelVersion = draft.modelVersion ?? 'gpt-4o-mini';

  await prisma.$executeRaw`
    INSERT INTO menu_item_ai_metadata (
      menu_item_id,
      display_name,
      short_description,
      search_keywords,
      synonyms,
      category_suggestion,
      product_tags,
      model_version,
      generated_at,
      updated_at
    ) VALUES (
      ${menuItemId}::uuid,
      ${draft.display_name ?? null},
      ${draft.short_description ?? null},
      ${draft.search_keywords ?? null}::text[],
      ${draft.synonyms ?? null}::text[],
      ${draft.category_suggestion ?? null},
      ${draft.product_tags ?? null}::text[],
      ${modelVersion},
      now(),
      now()
    )
    ON CONFLICT (menu_item_id) DO UPDATE SET
      display_name        = EXCLUDED.display_name,
      short_description   = EXCLUDED.short_description,
      search_keywords     = EXCLUDED.search_keywords,
      synonyms            = EXCLUDED.synonyms,
      category_suggestion = EXCLUDED.category_suggestion,
      product_tags        = EXCLUDED.product_tags,
      model_version       = EXCLUDED.model_version,
      generated_at        = now(),
      updated_at          = now()
  `;

  // Regenerar el embedding RAG para que incorpore los nuevos metadatos AI.
  await refreshMenuItemEmbedding(menuItemId);

  const saved = await getMenuItemAiMetadata(menuItemId);
  if (!saved) {
    throw new Error('AI_METADATA_SAVE_FAILED');
  }

  return saved;
}

/**
 * Elimina los metadatos AI de un producto (sin afectar el producto original).
 * Útil para forzar una regeneración limpia.
 *
 * @returns `true` si existía y fue eliminado, `false` si no existía.
 */
export async function deleteMenuItemAiMetadata(
  menuItemId: string
): Promise<boolean> {
  const result = await prisma.$executeRaw`
    DELETE FROM menu_item_ai_metadata
    WHERE menu_item_id = ${menuItemId}::uuid
  `;

  return result > 0;
}

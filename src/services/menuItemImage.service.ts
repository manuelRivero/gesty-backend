import { prisma } from "../lib/prisma";
import { getStorageProvider } from "../storage";
import {
  ImageValidationError,
  assertAllowedImage,
  buildDishImageKey,
  optimizeImageToWebp
} from "./imageOptimization.service";

export { ImageValidationError };

export type MenuItemImageResult = {
  imageKey: string;
  imageUrl: string;
};

async function deleteStorageKeyBestEffort(key: string | null | undefined): Promise<void> {
  if (!key) return;
  try {
    await getStorageProvider().delete(key);
  } catch (error) {
    console.error("[storage] Error al eliminar objeto (se ignora):", {
      key,
      error
    });
  }
}

/**
 * Sube o reemplaza la imagen de un platillo.
 * Orden: validar → optimizar → subir → actualizar BD → borrar anterior (best-effort).
 */
export async function uploadMenuItemImage(params: {
  businessId: string;
  menuItemId: string;
  buffer: Buffer;
  declaredMime?: string;
}): Promise<MenuItemImageResult> {
  const existing = await prisma.menu_item.findFirst({
    where: {
      id: params.menuItemId,
      business_id: params.businessId
    },
    select: { id: true, image_key: true }
  });

  if (!existing) {
    throw new Error("MENU_ITEM_NOT_FOUND");
  }

  assertAllowedImage(params.buffer, params.declaredMime);

  const optimized = await optimizeImageToWebp(params.buffer);
  const key = buildDishImageKey(params.businessId, optimized.extension);
  const storage = getStorageProvider();

  await storage.upload({
    key,
    body: optimized.body,
    contentType: optimized.contentType,
    contentLength: optimized.contentLength
  });

  const imageUrl = storage.getPublicUrl(key);
  const previousKey = existing.image_key;

  await prisma.menu_item.update({
    where: { id: params.menuItemId },
    data: {
      image: imageUrl,
      image_key: key
    }
  });

  if (previousKey && previousKey !== key) {
    await deleteStorageKeyBestEffort(previousKey);
  }

  return { imageKey: key, imageUrl };
}

/** Quita la imagen del platillo en BD y elimina el objeto en storage (best-effort). */
export async function removeMenuItemImage(params: {
  businessId: string;
  menuItemId: string;
}): Promise<void> {
  const existing = await prisma.menu_item.findFirst({
    where: {
      id: params.menuItemId,
      business_id: params.businessId
    },
    select: { id: true, image_key: true }
  });

  if (!existing) {
    throw new Error("MENU_ITEM_NOT_FOUND");
  }

  const previousKey = existing.image_key;

  await prisma.menu_item.update({
    where: { id: params.menuItemId },
    data: {
      image: null,
      image_key: null
    }
  });

  await deleteStorageKeyBestEffort(previousKey);
}

/** Tras soft-delete u otras limpiezas: elimina el objeto si hay key. */
export async function deleteStoredMenuItemImageBestEffort(
  imageKey: string | null | undefined
): Promise<void> {
  await deleteStorageKeyBestEffort(imageKey);
}

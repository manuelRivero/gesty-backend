import { prisma } from "../lib/prisma";
import { getStorageProvider } from "../storage";
import {
  ImageValidationError,
  assertAllowedImage,
  buildBusinessImageKey,
  optimizeImageToWebp
} from "./imageOptimization.service";

export { ImageValidationError };

export type BusinessImageResult = {
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
 * Sube o reemplaza la imagen/logo del negocio.
 * Orden: validar → optimizar → subir → actualizar BD → borrar anterior (best-effort).
 */
export async function uploadBusinessImage(params: {
  businessId: string;
  buffer: Buffer;
  declaredMime?: string;
}): Promise<BusinessImageResult> {
  const existing = await prisma.business.findUnique({
    where: { id: params.businessId },
    select: { id: true, image_key: true }
  });

  if (!existing) {
    throw new Error("BUSINESS_NOT_FOUND");
  }

  assertAllowedImage(params.buffer, params.declaredMime);

  const optimized = await optimizeImageToWebp(params.buffer);
  const key = buildBusinessImageKey(params.businessId, optimized.extension);
  const storage = getStorageProvider();

  await storage.upload({
    key,
    body: optimized.body,
    contentType: optimized.contentType,
    contentLength: optimized.contentLength
  });

  const imageUrl = storage.getPublicUrl(key);
  const previousKey = existing.image_key;

  await prisma.business.update({
    where: { id: params.businessId },
    data: {
      image_url: imageUrl,
      image_key: key
    }
  });

  if (previousKey && previousKey !== key) {
    await deleteStorageKeyBestEffort(previousKey);
  }

  return { imageKey: key, imageUrl };
}

/** Quita la imagen del negocio en BD y elimina el objeto en storage (best-effort). */
export async function removeBusinessImage(params: { businessId: string }): Promise<void> {
  const existing = await prisma.business.findUnique({
    where: { id: params.businessId },
    select: { id: true, image_key: true }
  });

  if (!existing) {
    throw new Error("BUSINESS_NOT_FOUND");
  }

  const previousKey = existing.image_key;

  await prisma.business.update({
    where: { id: params.businessId },
    data: {
      image_url: null,
      image_key: null
    }
  });

  await deleteStorageKeyBestEffort(previousKey);
}

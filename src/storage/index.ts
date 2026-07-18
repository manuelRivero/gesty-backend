import type { StorageProvider } from "./StorageProvider";
import { R2StorageProvider } from "./R2StorageProvider";

/**
 * Único punto de acoplamiento al proveedor concreto.
 * Para migrar a S3 / MinIO / otro compatible, cambiar solo esta fábrica.
 */
let provider: StorageProvider | null = null;

export function getStorageProvider(): StorageProvider {
  if (!provider) {
    provider = new R2StorageProvider();
  }
  return provider;
}

/** Útil en tests para inyectar un mock. */
export function setStorageProvider(next: StorageProvider | null): void {
  provider = next;
}

export type { StorageProvider, StorageUploadInput, StorageUploadResult } from "./StorageProvider";

import type { Readable } from "node:stream";

export type StorageUploadInput = {
  /** Object key in the bucket (path). */
  key: string;
  /** Stream or buffer body. Prefer streams to avoid loading large files in memory. */
  body: Readable | Buffer;
  contentType: string;
  contentLength?: number;
};

export type StorageUploadResult = {
  key: string;
};

/**
 * Abstracción de object storage. La app depende solo de esta interfaz;
 * el proveedor concreto (R2, S3, MinIO, …) se elige en `storage/index.ts`.
 */
export interface StorageProvider {
  upload(file: StorageUploadInput): Promise<StorageUploadResult>;
  delete(key: string): Promise<void>;
  getPublicUrl(key: string): string;
  exists(key: string): Promise<boolean>;
}

import {
  DeleteObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client
} from "@aws-sdk/client-s3";
import { env } from "../config/env";
import type {
  StorageProvider,
  StorageUploadInput,
  StorageUploadResult
} from "./StorageProvider";

function requireR2Config(): {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  publicUrl: string;
} {
  const accountId = env.R2_ACCOUNT_ID?.trim();
  const bucket = env.R2_BUCKET?.trim();
  const accessKeyId = env.R2_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY?.trim();
  const publicUrl = env.R2_PUBLIC_URL?.trim();
  const endpointOverride = env.R2_ENDPOINT?.trim();

  if (!bucket || !accessKeyId || !secretAccessKey || !publicUrl) {
    throw new Error(
      "STORAGE_NOT_CONFIGURED: faltan variables R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY o R2_PUBLIC_URL"
    );
  }

  const endpoint =
    endpointOverride ||
    (accountId
      ? `https://${accountId}.r2.cloudflarestorage.com`
      : undefined);

  if (!endpoint) {
    throw new Error(
      "STORAGE_NOT_CONFIGURED: definí R2_ACCOUNT_ID o R2_ENDPOINT"
    );
  }

  return { endpoint, bucket, accessKeyId, secretAccessKey, publicUrl };
}

/**
 * Proveedor Cloudflare R2 vía API compatible con S3 (AWS SDK v3).
 * No debe importarse fuera de `storage/`; el resto de la app usa `getStorageProvider()`.
 */
export class R2StorageProvider implements StorageProvider {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly publicUrlBase: string;

  constructor() {
    const cfg = requireR2Config();
    this.bucket = cfg.bucket;
    this.publicUrlBase = cfg.publicUrl.replace(/\/+$/, "");
    this.client = new S3Client({
      region: "auto",
      endpoint: cfg.endpoint,
      credentials: {
        accessKeyId: cfg.accessKeyId,
        secretAccessKey: cfg.secretAccessKey
      },
      forcePathStyle: false,
      // R2 no usa checksums flexibles de AWS; evita headers problemáticos en PutObject.
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED"
    });
  }

  async upload(file: StorageUploadInput): Promise<StorageUploadResult> {
    const contentLength =
      file.contentLength ??
      (Buffer.isBuffer(file.body) ? file.body.length : undefined);

    if (contentLength === undefined) {
      throw new Error(
        "STORAGE_UPLOAD_REQUIRES_CONTENT_LENGTH: R2/S3 necesita ContentLength al subir"
      );
    }

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: file.key,
        Body: file.body,
        ContentType: file.contentType,
        ContentLength: contentLength
      })
    );
    return { key: file.key };
  }

  async delete(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: key
      })
    );
  }

  getPublicUrl(key: string): string {
    const normalizedKey = key.replace(/^\/+/, "");
    return `${this.publicUrlBase}/${normalizedKey}`;
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(
        new HeadObjectCommand({
          Bucket: this.bucket,
          Key: key
        })
      );
      return true;
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } })
        .$metadata?.httpStatusCode;
      if (status === 404) {
        return false;
      }
      throw error;
    }
  }
}

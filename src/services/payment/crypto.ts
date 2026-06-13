import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

const getMasterKey = (): Buffer => {
  const keyB64 = process.env.PAYMENT_PROVIDER_ENCRYPTION_KEY;
  if (!keyB64) {
    throw new Error('PAYMENT_PROVIDER_ENCRYPTION_KEY is not set');
  }
  const key = Buffer.from(keyB64, 'base64');
  if (key.length !== 32) {
    throw new Error('PAYMENT_PROVIDER_ENCRYPTION_KEY must be 32 bytes (base64-encoded)');
  }
  return key;
};

/** Encripta con AES-256-GCM. Formato: iv:tag:ciphertext (base64). */
export const encryptToken = (plain: string): string => {
  const key = getMasterKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('base64'), tag.toString('base64'), encrypted.toString('base64')].join(':');
};

/** Desencripta formato iv:tag:ciphertext. */
export const decryptToken = (stored: string): string => {
  const key = getMasterKey();
  const parts = stored.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted token format');
  }
  const iv = Buffer.from(parts[0], 'base64');
  const tag = Buffer.from(parts[1], 'base64');
  const encrypted = Buffer.from(parts[2], 'base64');
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag.slice(0, TAG_LENGTH));
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString('utf8');
};

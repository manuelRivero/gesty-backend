import { prisma } from '../../lib/prisma';
import { decryptToken } from './crypto';

export interface DecryptedProvider {
  id: string;
  provider: string;
  accessToken: string;
  publicKey: string | null;
  webhookSecret: string | null;
  isSandbox: boolean;
}

export const getActiveProvider = async (
  businessId: string,
  provider: string
): Promise<DecryptedProvider | null> => {
  const row = await prisma.business_payment_provider.findFirst({
    where: { business_id: businessId, provider, is_active: true },
  });
  if (!row) return null;
  return {
    id: row.id,
    provider: row.provider,
    accessToken: decryptToken(row.access_token_encrypted),
    publicKey: row.public_key ?? null,
    webhookSecret: row.webhook_secret ?? null,
    isSandbox: row.is_sandbox,
  };
};

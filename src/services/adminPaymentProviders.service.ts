import { prisma } from '../lib/prisma';
import { encryptToken } from './payment/crypto';
import {
  getPaymentProviderDefinition,
  isPaymentProviderId,
  PAYMENT_PROVIDER_LIST,
  PaymentProviderValidationError,
  type PaymentProviderId,
  validateAccessToken,
  validateProviderCredentials,
  validatePublicKey,
} from './payment/paymentProviders';

type PaymentProviderRow = {
  id: string;
  business_id: string;
  provider: string;
  access_token_encrypted: string;
  public_key: string | null;
  webhook_secret: string | null;
  is_sandbox: boolean;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
};

export type AdminPaymentProviderDto = {
  id: string;
  businessId: string;
  provider: PaymentProviderId;
  name: string;
  image: string;
  publicKey: string | null;
  accessTokenConfigured: boolean;
  webhookSecretConfigured: boolean;
  isSandbox: boolean;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
};

function mapPaymentProviderRow(row: PaymentProviderRow): AdminPaymentProviderDto {
  if (!isPaymentProviderId(row.provider)) {
    throw new Error(`Proveedor de pago desconocido en BD: ${row.provider}`);
  }

  const meta = getPaymentProviderDefinition(row.provider);
  const hasAccessToken = row.is_active && row.access_token_encrypted.length > 0;

  return {
    id: row.id,
    businessId: row.business_id,
    provider: row.provider,
    name: meta.name,
    image: meta.image,
    publicKey: row.public_key,
    accessTokenConfigured: hasAccessToken,
    webhookSecretConfigured: Boolean(row.webhook_secret),
    isSandbox: row.is_sandbox,
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listAdminPaymentProviders(params: { businessId: string }) {
  const rows = await prisma.business_payment_provider.findMany({
    where: { business_id: params.businessId },
    orderBy: [{ provider: 'asc' }, { created_at: 'asc' }],
  });

  return {
    items: rows.map((row) => mapPaymentProviderRow(row as PaymentProviderRow)),
    availableProviders: PAYMENT_PROVIDER_LIST,
  };
}

export async function getAdminPaymentProviderById(params: {
  businessId: string;
  id: string;
}): Promise<AdminPaymentProviderDto | null> {
  const row = await prisma.business_payment_provider.findFirst({
    where: {
      id: params.id,
      business_id: params.businessId,
    },
  });

  return row ? mapPaymentProviderRow(row as PaymentProviderRow) : null;
}

export async function getAdminPaymentProviderByProvider(params: {
  businessId: string;
  provider: PaymentProviderId;
}): Promise<AdminPaymentProviderDto | null> {
  const row = await prisma.business_payment_provider.findFirst({
    where: {
      business_id: params.businessId,
      provider: params.provider,
    },
  });

  return row ? mapPaymentProviderRow(row as PaymentProviderRow) : null;
}

export class PaymentProviderAlreadyExistsError extends Error {
  constructor(provider: PaymentProviderId) {
    super(`Ya existe un proveedor "${provider}" para este negocio`);
    this.name = 'PaymentProviderAlreadyExistsError';
  }
}

export async function createAdminPaymentProvider(params: {
  businessId: string;
  provider: PaymentProviderId;
  accessToken: string;
  publicKey?: string | null;
  webhookSecret?: string | null;
  isSandbox?: boolean;
  isActive?: boolean;
}): Promise<AdminPaymentProviderDto> {
  const existing = await prisma.business_payment_provider.findFirst({
    where: {
      business_id: params.businessId,
      provider: params.provider,
    },
    select: { id: true },
  });

  if (existing) {
    throw new PaymentProviderAlreadyExistsError(params.provider);
  }

  const isSandbox = params.isSandbox ?? false;

  validateProviderCredentials({
    provider: params.provider,
    accessToken: params.accessToken,
    publicKey: params.publicKey,
    isSandbox,
  });

  const row = await prisma.business_payment_provider.create({
    data: {
      business_id: params.businessId,
      provider: params.provider,
      access_token_encrypted: encryptToken(params.accessToken),
      public_key: params.publicKey ?? null,
      webhook_secret: params.webhookSecret ?? null,
      is_sandbox: isSandbox,
      is_active: params.isActive ?? true,
    },
  });

  return mapPaymentProviderRow(row as PaymentProviderRow);
}

export async function updateAdminPaymentProvider(params: {
  businessId: string;
  id: string;
  accessToken?: string;
  publicKey?: string | null;
  webhookSecret?: string | null;
  isSandbox?: boolean;
  isActive?: boolean;
}): Promise<AdminPaymentProviderDto | null> {
  const existing = await prisma.business_payment_provider.findFirst({
    where: {
      id: params.id,
      business_id: params.businessId,
    },
  });

  if (!existing) {
    return null;
  }

  if (!isPaymentProviderId(existing.provider)) {
    throw new Error(`Proveedor de pago desconocido en BD: ${existing.provider}`);
  }

  const nextIsSandbox = params.isSandbox ?? existing.is_sandbox;

  if (params.accessToken !== undefined) {
    validateAccessToken({
      provider: existing.provider,
      accessToken: params.accessToken,
      isSandbox: nextIsSandbox,
    });
  }

  if (params.publicKey) {
    validatePublicKey({
      provider: existing.provider,
      publicKey: params.publicKey,
      isSandbox: nextIsSandbox,
    });
  }

  const row = await prisma.business_payment_provider.update({
    where: { id: params.id },
    data: {
      ...(params.accessToken !== undefined
        ? { access_token_encrypted: encryptToken(params.accessToken) }
        : {}),
      ...(params.publicKey !== undefined ? { public_key: params.publicKey } : {}),
      ...(params.webhookSecret !== undefined
        ? { webhook_secret: params.webhookSecret }
        : {}),
      ...(params.isSandbox !== undefined ? { is_sandbox: params.isSandbox } : {}),
      ...(params.isActive !== undefined ? { is_active: params.isActive } : {}),
      updated_at: new Date(),
    },
  });

  return mapPaymentProviderRow(row as PaymentProviderRow);
}

export async function deleteAdminPaymentProvider(params: {
  businessId: string;
  id: string;
}): Promise<{ id: string } | null> {
  const existing = await prisma.business_payment_provider.findFirst({
    where: {
      id: params.id,
      business_id: params.businessId,
    },
    select: { id: true },
  });

  if (!existing) {
    return null;
  }

  await prisma.business_payment_provider.delete({
    where: { id: params.id },
  });

  return { id: params.id };
}

export {
  PaymentProviderValidationError,
  isPaymentProviderId,
  PAYMENT_PROVIDER_LIST,
};

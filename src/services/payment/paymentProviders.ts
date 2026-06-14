import { env } from '../../config/env';

export const PAYMENT_PROVIDER_IDS = ['mercado_pago'] as const;

export type PaymentProviderId = (typeof PAYMENT_PROVIDER_IDS)[number];

export interface PaymentProviderDefinition {
  id: PaymentProviderId;
  name: string;
  /** Ruta relativa al API o URL absoluta del logo del proveedor. */
  image: string;
  supportsSandbox: boolean;
}

export const PAYMENT_PROVIDER_DEFINITIONS: Record<
  PaymentProviderId,
  PaymentProviderDefinition
> = {
  mercado_pago: {
    id: 'mercado_pago',
    name: 'Mercado Pago',
    image: 'https://woocommerce.com/wp-content/uploads/2021/05/tw-mercado-pago-v2@2x.png',
    supportsSandbox: true,
  },
};

export const PAYMENT_PROVIDER_LIST = PAYMENT_PROVIDER_IDS.map(
  (id) => ({
    ...PAYMENT_PROVIDER_DEFINITIONS[id],
    image: resolveProviderImageUrl(PAYMENT_PROVIDER_DEFINITIONS[id].image),
  })
);

export function resolveProviderImageUrl(image: string): string {
  if (image.startsWith('http://') || image.startsWith('https://')) {
    return image;
  }

  const base = (env.PUBLIC_URL ?? '').replace(/\/$/, '');
  return base ? `${base}${image}` : image;
}

export function getPaymentProviderDefinition(
  provider: PaymentProviderId
): PaymentProviderDefinition & { image: string } {
  const definition = PAYMENT_PROVIDER_DEFINITIONS[provider];
  return {
    ...definition,
    image: resolveProviderImageUrl(definition.image),
  };
}

export function isPaymentProviderId(value: string): value is PaymentProviderId {
  return (PAYMENT_PROVIDER_IDS as readonly string[]).includes(value);
}

export function maskSecretPreview(value: string): string {
  if (value.length <= 12) {
    return '****';
  }
  return `${value.slice(0, 8)}...${value.slice(-4)}`;
}

export class PaymentProviderValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaymentProviderValidationError';
  }
}

function assertMercadoPagoPrefix(
  value: string,
  fieldLabel: string,
  expectedPrefix: string
): void {
  if (!value.startsWith(expectedPrefix)) {
    throw new PaymentProviderValidationError(
      `${fieldLabel} debe comenzar con "${expectedPrefix}"`
    );
  }
}

export function validateAccessToken(params: {
  provider: PaymentProviderId;
  accessToken: string;
  isSandbox: boolean;
}): void {
  if (params.provider === 'mercado_pago') {
    const prefix = params.isSandbox ? 'TEST-' : 'APP_USR-';
    assertMercadoPagoPrefix(params.accessToken, 'accessToken', prefix);
  }
}

export function validatePublicKey(params: {
  provider: PaymentProviderId;
  publicKey: string;
  isSandbox: boolean;
}): void {
  if (params.provider === 'mercado_pago') {
    const prefix = params.isSandbox ? 'TEST-' : 'APP_USR-';
    assertMercadoPagoPrefix(params.publicKey, 'publicKey', prefix);
  }
}

/** Valida credenciales según el proveedor antes de persistir. */
export function validateProviderCredentials(params: {
  provider: PaymentProviderId;
  accessToken: string;
  publicKey?: string | null;
  isSandbox: boolean;
}): void {
  validateAccessToken(params);
  if (params.publicKey) {
    validatePublicKey({
      provider: params.provider,
      publicKey: params.publicKey,
      isSandbox: params.isSandbox,
    });
  }
}

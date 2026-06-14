import { describe, expect, it } from 'vitest';
import {
  getPaymentProviderDefinition,
  isPaymentProviderId,
  maskSecretPreview,
  PaymentProviderValidationError,
  validateAccessToken,
  validateProviderCredentials,
  validatePublicKey,
} from '../paymentProviders';

describe('paymentProviders', () => {
  it('reconoce mercado_pago como proveedor válido', () => {
    expect(isPaymentProviderId('mercado_pago')).toBe(true);
    expect(isPaymentProviderId('stripe')).toBe(false);
  });

  it('enmascara secretos largos', () => {
    expect(maskSecretPreview('APP_USR-1234567890-ABCDEF')).toBe(
      'APP_USR-...CDEF'
    );
    expect(maskSecretPreview('short')).toBe('****');
  });

  it('valida access token de producción de Mercado Pago', () => {
    expect(() =>
      validateAccessToken({
        provider: 'mercado_pago',
        accessToken: 'APP_USR-1234567890-ABCDEF',
        isSandbox: false,
      })
    ).not.toThrow();
  });

  it('rechaza access token sandbox en modo producción', () => {
    expect(() =>
      validateAccessToken({
        provider: 'mercado_pago',
        accessToken: 'TEST-1234567890-ABCDEF',
        isSandbox: false,
      })
    ).toThrow(PaymentProviderValidationError);
  });

  it('valida credenciales completas de sandbox', () => {
    expect(() =>
      validateProviderCredentials({
        provider: 'mercado_pago',
        accessToken: 'TEST-1234567890-ABCDEF',
        publicKey: 'TEST-ABCDEFGH-12345678',
        isSandbox: true,
      })
    ).not.toThrow();
  });

  it('valida public key de forma independiente', () => {
    expect(() =>
      validatePublicKey({
        provider: 'mercado_pago',
        publicKey: 'APP_USR-ABCDEFGH-12345678',
        isSandbox: false,
      })
    ).not.toThrow();
  });

  it('expone metadata de display para mercado_pago', () => {
    const meta = getPaymentProviderDefinition('mercado_pago');
    expect(meta.name).toBe('Mercado Pago');
    expect(meta.image).toBe(
      'https://woocommerce.com/wp-content/uploads/2021/05/tw-mercado-pago-v2@2x.png'
    );
  });
});

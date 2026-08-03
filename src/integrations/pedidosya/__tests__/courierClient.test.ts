import { beforeEach, describe, expect, it, vi } from 'vitest';

const envState: Record<string, string | number | boolean | undefined> = {
  PEDIDOSYA_ACCESS_TOKEN: undefined,
  PEDIDOSYA_CLIENT_ID: undefined,
  PEDIDOSYA_CLIENT_SECRET: undefined,
};

vi.mock('../../../config/env', () => ({
  env: new Proxy(
    {},
    {
      get: (_t, prop: string) => envState[prop],
    }
  ),
}));

import {
  clearPedidosYaTokenCache,
  isPedidosYaCourierConfigured,
  pickCheapestOfferTotal,
} from '../courierClient';
import type { PedidosYaEstimateResponse } from '../types';

describe('isPedidosYaCourierConfigured', () => {
  beforeEach(() => {
    clearPedidosYaTokenCache();
    envState.PEDIDOSYA_ACCESS_TOKEN = undefined;
    envState.PEDIDOSYA_CLIENT_ID = undefined;
    envState.PEDIDOSYA_CLIENT_SECRET = undefined;
  });

  it('false sin credenciales', () => {
    expect(isPedidosYaCourierConfigured()).toBe(false);
  });

  it('true con access token', () => {
    envState.PEDIDOSYA_ACCESS_TOKEN = 'tok-123';
    expect(isPedidosYaCourierConfigured()).toBe(true);
  });

  it('true con clientId + clientSecret', () => {
    envState.PEDIDOSYA_CLIENT_ID = 'id';
    envState.PEDIDOSYA_CLIENT_SECRET = 'secret';
    expect(isPedidosYaCourierConfigured()).toBe(true);
  });

  it('false con solo clientId', () => {
    envState.PEDIDOSYA_CLIENT_ID = 'id';
    expect(isPedidosYaCourierConfigured()).toBe(false);
  });
});

describe('pickCheapestOfferTotal', () => {
  it('elige el total más bajo', () => {
    const estimate: PedidosYaEstimateResponse = {
      deliveryOffers: [
        { pricing: { total: 1200 } },
        { pricing: { total: 950 } },
        { pricing: { total: 1100 } },
      ],
    };
    expect(pickCheapestOfferTotal(estimate)).toBe(950);
  });

  it('null si no hay ofertas', () => {
    expect(pickCheapestOfferTotal({ deliveryOffers: [] })).toBeNull();
    expect(pickCheapestOfferTotal({})).toBeNull();
  });

  it('ignora totales inválidos', () => {
    const estimate: PedidosYaEstimateResponse = {
      deliveryOffers: [
        { pricing: { total: Number.NaN } },
        { pricing: {} as { total: number } },
        { pricing: { total: 800 } },
      ],
    };
    expect(pickCheapestOfferTotal(estimate)).toBe(800);
  });
});

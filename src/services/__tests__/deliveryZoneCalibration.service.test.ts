import { beforeEach, describe, expect, it, vi } from 'vitest';

const isConfigured = vi.fn();

vi.mock('../../integrations/pedidosya/courierClient', () => ({
  isPedidosYaCourierConfigured: () => isConfigured(),
  estimateShipping: vi.fn(),
  pickCheapestOfferTotal: vi.fn(),
}));

vi.mock('../../config/env', () => ({
  env: {
    PEDIDOSYA_SAFETY_BUFFER_PERCENT: 15,
    PEDIDOSYA_IS_TEST: true,
    PEDIDOSYA_REQUEST_DELAY_MS: 0,
  },
}));

vi.mock('../../lib/prisma', () => ({
  prisma: {
    $queryRaw: vi.fn(),
  },
}));

import {
  actionMessage,
  calibrateDeliveryZones,
  getDeliveryZoneCalibrationStatus,
  PedidosYaNotConfiguredError,
  resolveAction,
} from '../deliveryZoneCalibration.service';

describe('resolveAction', () => {
  it('increase cuando el fee actual no cubre el sugerido', () => {
    expect(resolveAction(100, 150)).toBe('increase');
  });

  it('keep cuando está dentro del rango con tolerancia de redondeo', () => {
    expect(resolveAction(150, 150)).toBe('keep');
    expect(resolveAction(150, 149)).toBe('keep');
  });

  it('optional_decrease cuando el fee está >25% por encima', () => {
    expect(resolveAction(200, 150)).toBe('optional_decrease');
  });
});

describe('actionMessage', () => {
  it('mensajes por acción', () => {
    expect(actionMessage('increase', 100, 140)).toContain('Sugerido: $140');
    expect(actionMessage('keep', 150, 140)).toContain('ya cubre');
    expect(actionMessage('optional_decrease', 200, 140)).toContain('por encima');
    expect(actionMessage('insufficient_data', 100, null)).toContain(
      'No se pudo cotizar'
    );
  });
});

describe('getDeliveryZoneCalibrationStatus', () => {
  beforeEach(() => {
    isConfigured.mockReset();
  });

  it('configured false cuando PedidosYa no está configurado (modo dormido)', () => {
    isConfigured.mockReturnValue(false);
    expect(getDeliveryZoneCalibrationStatus()).toEqual({
      configured: false,
      safetyBufferPercent: 15,
      isTest: true,
    });
  });

  it('configured true cuando hay credenciales', () => {
    isConfigured.mockReturnValue(true);
    expect(getDeliveryZoneCalibrationStatus().configured).toBe(true);
  });
});

describe('calibrateDeliveryZones', () => {
  beforeEach(() => {
    isConfigured.mockReset();
  });

  it('lanza PedidosYaNotConfiguredError sin credenciales (no llama a la API)', async () => {
    isConfigured.mockReturnValue(false);
    await expect(
      calibrateDeliveryZones({ businessId: 'biz-1' })
    ).rejects.toBeInstanceOf(PedidosYaNotConfiguredError);
  });
});

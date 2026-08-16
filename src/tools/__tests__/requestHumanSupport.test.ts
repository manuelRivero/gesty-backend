/**
 * Fase B: soporte humano en prosa desde el híbrido.
 *
 * El `escalationGateNode` sigue cubriendo los pedidos inequívocos en todo turno;
 * esta tool cubre la prosa que ese gate deja pasar por diseño. Lo que se testea
 * es el efecto en el borde (`is_human_handled` vía `handOverToHuman`), no frases.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../lib/prisma', () => ({
  prisma: {},
}));

vi.mock('../../services/menu.service', () => ({
  MenuService: {},
}));

vi.mock('../../services/humanHandover.service', () => ({
  SUPPORT_MESSAGE: 'mensaje de derivación',
  handOverToHuman: vi.fn().mockResolvedValue(undefined),
}));

import { requestHumanSupportTool } from '../index';
import { handOverToHuman } from '../../services/humanHandover.service';

const CONFIG = {
  configurable: {
    businessId: 'biz-1',
    customerId: 'cust-1',
    customerPhone: '+5491100000000',
    conversationId: 'conv-1',
    conversationStartedAt: new Date().toISOString(),
  },
};

describe('request_human_support', () => {
  beforeEach(() => vi.clearAllMocks());

  it('escala la conversación y devuelve la señal con el mensaje del sistema', async () => {
    const raw = await requestHumanSupportTool.func(
      { reason: 'el cliente pidió un asesor' },
      undefined,
      CONFIG
    );

    expect(handOverToHuman).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      businessId: 'biz-1',
      customer: { id: 'cust-1', phone_number: '+5491100000000' },
      reason: 'hybrid_tool:el cliente pidió un asesor',
    });
    expect(JSON.parse(raw)).toEqual({
      signal: 'request_human_support',
      reason: 'el cliente pidió un asesor',
      message: 'mensaje de derivación',
    });
  });

  it('está registrada en allReactTools (el agente puede llamarla)', async () => {
    const { allReactTools } = await import('../index');
    expect(allReactTools.map((t) => t.name)).toContain('request_human_support');
  });
});

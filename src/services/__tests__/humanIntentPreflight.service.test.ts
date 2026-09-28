import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock, withStructuredOutputMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  withStructuredOutputMock: vi.fn(),
}));

vi.mock('../../config/llm', () => ({
  getIntentDetectorLlm: () => ({ withStructuredOutput: withStructuredOutputMock }),
}));

import {
  runHumanIntentPreflight,
  validateHumanIntentTurnDecision,
  type HumanIntentPreflightInput,
} from '../humanIntentPreflight.service';

const ACTIVE_ID = '11111111-1111-4111-8111-111111111111';
const PENDING_ID = '22222222-2222-4222-8222-222222222222';
const BLOCKER_ID = '33333333-3333-4333-8333-333333333333';
const VISIBLE_PRODUCT_ID = '44444444-4444-4444-8444-444444444444';

const active = {
  id: ACTIVE_ID,
  sequence: 1,
  goal: 'PEDIR',
  request: { products: ['ceviche'] },
  status: 'ACTIVE' as const,
  blockers: [{ id: BLOCKER_ID, code: 'PARTY_SIZE_REQUIRED', createdAt: '2026-09-27T00:00:00.000Z' }],
  createdAt: '2026-09-27T00:00:00.000Z',
  updatedAt: '2026-09-27T00:00:00.000Z',
};

const pending = {
  id: PENDING_ID,
  sequence: 2,
  goal: 'EXPLORAR',
  request: { category: 'postres' },
  status: 'PENDING' as const,
  blockers: [],
  createdAt: '2026-09-27T00:01:00.000Z',
  updatedAt: '2026-09-27T00:01:00.000Z',
};

const input = (overrides: Partial<HumanIntentPreflightInput> = {}): HumanIntentPreflightInput => ({
  turn: { messageId: 'wamid.current', text: 'Para tres.' },
  context: {
    recentTurns: [
      { role: 'assistant', text: '¿Para cuántas personas?' },
      { role: 'user', text: 'Para tres.' },
    ],
    lastAssistantQuestion: '¿Para cuántas personas?',
    visibleReferences: [{ id: VISIBLE_PRODUCT_ID, kind: 'product', label: 'Ceviche' }],
  },
  state: { revision: 3, active, pending: [pending] },
  ...overrides,
});

describe('Human Intent Preflight', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    withStructuredOutputMock.mockReturnValue({ invoke: invokeMock });
  });

  it('acepta CONTINUE_ACTIVE al responder un blocker del ACTIVE', () => {
    expect(
      validateHumanIntentTurnDecision(
        { decision: 'CONTINUE_ACTIVE', intentId: ACTIVE_ID, answeredBlockerIds: [BLOCKER_ID] },
        input()
      )
    ).toMatchObject({ decision: 'CONTINUE_ACTIVE', intentId: ACTIVE_ID });
  });

  it('rechaza blockers que no pertenecen al ACTIVE', () => {
    expect(
      validateHumanIntentTurnDecision(
        { decision: 'CONTINUE_ACTIVE', intentId: ACTIVE_ID, answeredBlockerIds: [PENDING_ID] },
        input()
      )
    ).toBeNull();
  });

  it('acepta una intención independiente con goal humano permitido', () => {
    expect(
      validateHumanIntentTurnDecision(
        { decision: 'NEW_INTENT', intents: [{ goal: 'CONSULTAR_NEGOCIO', request: { subject: 'delivery' } }] },
        input({ turn: { messageId: 'wamid.delivery', text: '¿Hacen delivery?' } })
      )
    ).toMatchObject({ decision: 'NEW_INTENT', intents: [{ goal: 'CONSULTAR_NEGOCIO' }] });
  });

  it('acepta múltiples objetivos distintos y conserva el orden del array', () => {
    const decision = {
      decision: 'NEW_INTENT',
      intents: [
        { goal: 'PEDIR', request: { products: ['ceviche'] } },
        { goal: 'EXPLORAR', request: { category: 'postres' } },
        { goal: 'EXPLORAR', request: { category: 'bebidas' } },
      ],
    };
    expect(validateHumanIntentTurnDecision(decision, input({ state: { revision: 0, active: null, pending: [] } })))
      .toEqual(decision);
  });

  it('representa "Ceviche, postre y bebidas" con tres objetivos en intents', () => {
    const decision = {
      decision: 'NEW_INTENT',
      intents: [
        { goal: 'PEDIR', request: { products: ['ceviche'] } },
        { goal: 'EXPLORAR', request: { category: 'postres' } },
        { goal: 'EXPLORAR', request: { category: 'bebidas' } },
      ],
    };

    expect(validateHumanIntentTurnDecision(
      decision,
      input({
        turn: { messageId: 'wamid.multi', text: 'Ceviche, postre y bebidas' },
        state: { revision: 0, active: null, pending: [] },
      })
    )).toEqual(decision);
  });

  it('no fragmenta varios productos de un mismo PEDIR', () => {
    const decision = {
      decision: 'NEW_INTENT',
      intents: [{ goal: 'PEDIR', request: { products: ['ceviche', 'lomo'] } }],
    };
    expect(validateHumanIntentTurnDecision(decision, input())).toEqual(decision);
  });

  it('RESUME_PENDING solo acepta un ID de la lista PENDING', () => {
    expect(validateHumanIntentTurnDecision({ decision: 'RESUME_PENDING', intentId: PENDING_ID }, input()))
      .toEqual({ decision: 'RESUME_PENDING', intentId: PENDING_ID });
    expect(validateHumanIntentTurnDecision({ decision: 'RESUME_PENDING', intentId: ACTIVE_ID }, input()))
      .toBeNull();
  });

  it('distingue CANCEL de la intención CANCELAR_COMPRA', () => {
    expect(validateHumanIntentTurnDecision({ decision: 'CANCEL', intentId: ACTIVE_ID }, input()))
      .toEqual({ decision: 'CANCEL', intentId: ACTIVE_ID });
    expect(
      validateHumanIntentTurnDecision(
        { decision: 'NEW_INTENT', intents: [{ goal: 'CANCELAR_COMPRA', request: { target: 'draft' } }] },
        input()
      )
    ).toMatchObject({ decision: 'NEW_INTENT', intents: [{ goal: 'CANCELAR_COMPRA' }] });
  });

  it('REPLACE solo acepta la intención ACTIVE', () => {
    const replacement = { goal: 'PEDIR', request: { products: ['hamburguesa'] } };
    expect(validateHumanIntentTurnDecision({ decision: 'REPLACE', intentId: ACTIVE_ID, replacement }, input()))
      .toMatchObject({ decision: 'REPLACE', intentId: ACTIVE_ID });
    expect(validateHumanIntentTurnDecision({ decision: 'REPLACE', intentId: PENDING_ID, replacement }, input()))
      .toBeNull();
  });

  it('permite NO_INTENT y AMBIGUOUS sin campos adicionales', () => {
    expect(validateHumanIntentTurnDecision({ decision: 'NO_INTENT' }, input())).toEqual({ decision: 'NO_INTENT' });
    expect(validateHumanIntentTurnDecision({ decision: 'AMBIGUOUS' }, input())).toEqual({ decision: 'AMBIGUOUS' });
    expect(validateHumanIntentTurnDecision({ decision: 'AMBIGUOUS', confidence: 0.5 }, input())).toBeNull();
  });

  it('rechaza goal legacy/tool y campos extra en el output', () => {
    expect(
      validateHumanIntentTurnDecision(
        { decision: 'NEW_INTENT', intents: [{ goal: 'present_category', request: {} }] },
        input()
      )
    ).toBeNull();
    expect(
      validateHumanIntentTurnDecision(
        { decision: 'NEW_INTENT', confidence: 0.9, intents: [{ goal: 'EXPLORAR', request: {} }] },
        input()
      )
    ).toBeNull();
    expect(
      validateHumanIntentTurnDecision(
        { decision: 'NEW_INTENT', request: { goal: 'PEDIR' } },
        input()
      )
    ).toBeNull();
  });

  it('acepta anáfora ligada a referencia visible y rechaza un ID inventado', () => {
    expect(
      validateHumanIntentTurnDecision(
        {
          decision: 'NEW_INTENT',
          intents: [{ goal: 'PEDIR', request: { productId: VISIBLE_PRODUCT_ID } }],
        },
        input({ turn: { messageId: 'wamid.that', text: 'Dame ese.' } })
      )
    ).not.toBeNull();
    expect(
      validateHumanIntentTurnDecision(
        {
          decision: 'NEW_INTENT',
          intents: [{ goal: 'PEDIR', request: { productId: '99999999-9999-4999-8999-999999999999' } }],
        },
        input({ turn: { messageId: 'wamid.that', text: 'Dame ese.' } })
      )
    ).toBeNull();
  });

  it('rechaza IDs inventados aunque request use otro naming de campo', () => {
    expect(
      validateHumanIntentTurnDecision(
        {
          decision: 'NEW_INTENT',
          intents: [{
            goal: 'PEDIR',
            request: { menu_item_id: '99999999-9999-4999-8999-999999999999' },
          }],
        },
        input()
      )
    ).toBeNull();
  });

  it('llama al LLM estructurado sin tools y serializa solo el input declarado', async () => {
    invokeMock.mockResolvedValue({ decision: 'CONTINUE_ACTIVE', intentId: ACTIVE_ID, answeredBlockerIds: [BLOCKER_ID] });

    const decision = await runHumanIntentPreflight(input());

    expect(decision.decision).toBe('CONTINUE_ACTIVE');
    expect(withStructuredOutputMock).toHaveBeenCalledOnce();
    const invokeMessages = invokeMock.mock.calls[0][0] as Array<{ content: string }>;
    expect(invokeMessages[1].content).toContain('visibleReferences');
    expect(invokeMessages[1].content).toContain(VISIBLE_PRODUCT_ID);
    expect(invokeMessages[1].content).not.toContain('intentLedger');
  });

  it('acepta NO_INTENT como resultado válido del preflight para un saludo', async () => {
    invokeMock.mockResolvedValue({ decision: 'NO_INTENT' });

    await expect(
      runHumanIntentPreflight(input({ turn: { messageId: 'wamid.greeting', text: 'Hola buenas' } }))
    ).resolves.toEqual({ decision: 'NO_INTENT' });
  });

  it('parsea "Quiero hacer un pedido" como NEW_INTENT con intents y request vacío', async () => {
    const result = {
      decision: 'NEW_INTENT',
      intents: [{ goal: 'PEDIR', request: {} }],
    };
    invokeMock.mockResolvedValue(result);

    await expect(
      runHumanIntentPreflight(input({ turn: { messageId: 'wamid.order', text: 'Quiero hacer un pedido' } }))
    ).resolves.toEqual(result);
  });

  it('output inválido o error del LLM falla cerrado como AMBIGUOUS', async () => {
    invokeMock.mockResolvedValue({ decision: 'CANCEL', intentId: 'invented-id', explanation: 'no' });
    expect(await runHumanIntentPreflight(input())).toEqual({ decision: 'AMBIGUOUS' });

    invokeMock.mockRejectedValue(new Error('model unavailable'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await runHumanIntentPreflight(input())).toEqual({ decision: 'AMBIGUOUS' });
  });
});
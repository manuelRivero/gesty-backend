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
import { HUMAN_INTENT_PREFLIGHT_SYSTEM_PROMPT } from '../../prompts/humanIntentPreflight';

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

const pendingBeverages = {
  ...pending,
  id: '55555555-5555-4555-8555-555555555555',
  request: { category: 'bebidas' },
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

  it('acepta reutilizar un PEDIR equivalente y no confunde productos distintos', () => {
    const sameOrder = {
      decision: 'NEW_INTENT',
      intents: [{ goal: 'PEDIR', request: { products: ['ceviche'] } }],
    };
    const additionalItem = {
      decision: 'NEW_INTENT',
      intents: [{ goal: 'PEDIR', request: { products: ['ceviche', 'papas'] } }],
    };
    const differentOrder = {
      decision: 'NEW_INTENT',
      intents: [{ goal: 'PEDIR', request: { products: ['milanesa'] } }],
    };

    expect(validateHumanIntentTurnDecision(sameOrder, input())).toEqual(sameOrder);
    expect(validateHumanIntentTurnDecision(additionalItem, input())).toEqual(additionalItem);
    expect(validateHumanIntentTurnDecision(differentOrder, input())).toEqual(differentOrder);
  });

  it('RESUME_PENDING solo acepta un ID de la lista PENDING', () => {
    expect(validateHumanIntentTurnDecision({ decision: 'RESUME_PENDING', intentId: PENDING_ID }, input()))
      .toEqual({ decision: 'RESUME_PENDING', intentId: PENDING_ID });
    expect(validateHumanIntentTurnDecision({ decision: 'RESUME_PENDING', intentId: ACTIVE_ID }, input()))
      .toBeNull();
  });

  it('distingue cancelar la compra de abandonar una HumanIntent existente', () => {
    const cancelPurchase = {
      decision: 'NEW_INTENT',
      intents: [{ goal: 'CANCELAR_COMPRA', request: {} }],
    };
    for (const text of ['Cancelar pedido', 'Quiero cancelar la compra']) {
      expect(validateHumanIntentTurnDecision(
        cancelPurchase,
        input({ turn: { messageId: 'wamid.cancel-purchase', text } })
      )).toEqual(cancelPurchase);
    }

    const abandonPending = input({
      turn: { messageId: 'wamid.abandon-desserts', text: 'Olvidá lo de los postres' },
    });
    expect(validateHumanIntentTurnDecision({ decision: 'CANCEL', intentId: PENDING_ID }, abandonPending))
      .toEqual({ decision: 'CANCEL', intentId: PENDING_ID });
    expect(validateHumanIntentTurnDecision({ decision: 'CANCEL', intentId: 'invented-id' }, abandonPending))
      .toBeNull();
    expect(validateHumanIntentTurnDecision({ decision: 'CANCEL' }, abandonPending)).toBeNull();
  });

  it('incluye ejemplos contrastivos de CANCEL y CANCELAR_COMPRA en el prompt', () => {
    expect(HUMAN_INTENT_PREFLIGHT_SYSTEM_PROMPT).toContain('“Cancelar pedido”');
    expect(HUMAN_INTENT_PREFLIGHT_SYSTEM_PROMPT).toContain('“Quiero cancelar la compra”');
    expect(HUMAN_INTENT_PREFLIGHT_SYSTEM_PROMPT).toContain('“Olvidá lo de los postres”');
    expect(HUMAN_INTENT_PREFLIGHT_SYSTEM_PROMPT).toContain(
      '{"decision":"NEW_INTENT","intents":[{"goal":"CANCELAR_COMPRA","request":{}}]}'
    );
    expect(HUMAN_INTENT_PREFLIGHT_SYSTEM_PROMPT).toContain(
      '{"decision":"CANCEL","intentId":"<ID_PENDING>"}'
    );
  });

  it('distingue retomar PENDING de continuar ACTIVE en el contrato', () => {
    expect(HUMAN_INTENT_PREFLIGHT_SYSTEM_PROMPT).toContain(
      'answeredBlockerIds solo puede contener IDs que aparezcan en state.active.blockers'
    );
    expect(HUMAN_INTENT_PREFLIGHT_SYSTEM_PROMPT).toContain(
      'si el mensaje expresa un objetivo nuevo distinto y no hay un PENDING compatible, usa NEW_INTENT'
    );
    expect(HUMAN_INTENT_PREFLIGHT_SYSTEM_PROMPT).toContain(
      '{"decision":"RESUME_PENDING","intentId":"<ID_PENDING_POSTRES>"}'
    );
    expect(HUMAN_INTENT_PREFLIGHT_SYSTEM_PROMPT).toContain(
      '{"decision":"RESUME_PENDING","intentId":"<ID_PENDING_BEBIDAS>"}'
    );
    expect(HUMAN_INTENT_PREFLIGHT_SYSTEM_PROMPT).toContain('¿Qué tienen de postre?');
  });

  it('ordena crear EXPLORAR/postres como NEW_INTENT sin pending compatible', async () => {
    const requestInput = input({
      turn: { messageId: 'wamid.new-desserts', text: '¿Qué postres tienen?' },
      state: { revision: 2, active: { ...active, request: { products: ['milanesa'] }, blockers: [] }, pending: [] },
    });
    const decision = {
      decision: 'NEW_INTENT',
      intents: [{ goal: 'EXPLORAR', request: { category: 'postres' } }],
    };
    invokeMock.mockResolvedValue(decision);

    await expect(runHumanIntentPreflight(requestInput)).resolves.toEqual(decision);
    expect(validateHumanIntentTurnDecision(decision, requestInput)).toEqual(decision);
  });

  it('no reutiliza un pending incompatible y crea EXPLORAR/postres', async () => {
    const requestInput = input({
      turn: { messageId: 'wamid.new-desserts-with-drinks-pending', text: '¿Qué postres tienen?' },
      state: {
        revision: 3,
        active: { ...active, blockers: [] },
        pending: [pendingBeverages],
      },
    });
    const decision = {
      decision: 'NEW_INTENT',
      intents: [{ goal: 'EXPLORAR', request: { category: 'postres' } }],
    };
    invokeMock.mockResolvedValue(decision);

    await expect(runHumanIntentPreflight(requestInput)).resolves.toEqual(decision);
    expect(validateHumanIntentTurnDecision(decision, requestInput)).toEqual(decision);
  });

  it('rechaza un RESUME_PENDING inventado cuando no hay pending compatible', async () => {
    const requestInput = input({
      turn: { messageId: 'wamid.invalid-pending', text: '¿Qué postres tienen?' },
      state: { revision: 2, active: { ...active, blockers: [] }, pending: [] },
    });
    const inventedResume = { decision: 'RESUME_PENDING', intentId: '<ID_PENDING>' };
    invokeMock.mockResolvedValue(inventedResume);

    await expect(runHumanIntentPreflight(requestInput)).resolves.toEqual({ decision: 'AMBIGUOUS' });
    expect(validateHumanIntentTurnDecision(inventedResume, requestInput)).toBeNull();
    expect(HUMAN_INTENT_PREFLIGHT_SYSTEM_PROMPT).toContain(
      'Nunca devuelvas los placeholders literales <ID_PENDING>, <pending-id> o <some-id>'
    );
  });

  it.each([
    ['¿Qué postres tienen?', [pending], PENDING_ID],
    ['¿Qué postres tienen?', [pending, pendingBeverages], PENDING_ID],
    ['¿Y qué bebidas tienen?', [pending, pendingBeverages], pendingBeverages.id],
  ])('retoma exclusivamente la intención PENDING correspondiente: %s', async (text, pendingIntents, expectedId) => {
    const requestInput = input({
      turn: { messageId: `wamid.resume-${expectedId}`, text },
      state: {
        revision: 3,
        active: { ...active, request: { products: ['milanesa'] }, blockers: [] },
        pending: pendingIntents,
      },
    });
    const decision = { decision: 'RESUME_PENDING', intentId: expectedId };
    invokeMock.mockResolvedValue(decision);

    await expect(runHumanIntentPreflight(requestInput)).resolves.toEqual(decision);
    const prompt = (invokeMock.mock.calls[0][0] as Array<{ content: string }>)[1].content;
    expect(prompt).toContain(expectedId);
    expect(prompt).toContain(text);
  });

  it('continúa ACTIVE y devuelve solo el blocker respondido cuando hay PENDING', async () => {
    const requestInput = input({
      turn: { messageId: 'wamid.party-size', text: 'Para dos personas' },
      state: { revision: 3, active, pending: [pending] },
    });
    const decision = {
      decision: 'CONTINUE_ACTIVE',
      intentId: ACTIVE_ID,
      answeredBlockerIds: [BLOCKER_ID],
    };
    invokeMock.mockResolvedValue(decision);

    await expect(runHumanIntentPreflight(requestInput)).resolves.toEqual(decision);
  });

  it('continúa ACTIVE sin blocker cuando responde al Goal blocking de party size', async () => {
    const requestInput = input({
      turn: { messageId: 'wamid.party-size-goal', text: 'Para 3' },
      context: {
        recentTurns: [{ role: 'assistant', text: '¿Para cuántas personas?' }],
        lastAssistantQuestion: '¿Para cuántas personas?',
        visibleReferences: [],
        activeBlockingGoal: 'OBTENER_PERSONAS_DEL_PEDIDO',
      },
      state: {
        revision: 3,
        active: { ...active, request: {}, blockers: [] },
        pending: [],
      },
    });
    const decision = {
      decision: 'CONTINUE_ACTIVE',
      intentId: ACTIVE_ID,
      answeredBlockerIds: [],
    };
    invokeMock.mockResolvedValue(decision);

    await expect(runHumanIntentPreflight(requestInput)).resolves.toEqual(decision);
    expect((invokeMock.mock.calls[0][0] as Array<{ content: string }>)[1].content)
      .toContain('activeBlockingGoal');
    expect(HUMAN_INTENT_PREFLIGHT_SYSTEM_PROMPT).toContain('No crees otro HumanIntent');
  });

  it.each(['3', 'Para 3', 'Somos tres'])(
    'valida fulfillmentCandidate de party size para "%s"',
    (text) => {
      const requestInput = input({
        turn: { messageId: `wamid.party-size-${text}`, text },
        context: {
          recentTurns: [{ role: 'assistant', text: '¿Para cuántas personas?' }],
          lastAssistantQuestion: '¿Para cuántas personas?',
          activeBlockingGoal: 'OBTENER_PERSONAS_DEL_PEDIDO',
        },
        state: { revision: 3, active: { ...active, blockers: [] }, pending: [] },
      });
      const decision = {
        decision: 'CONTINUE_ACTIVE',
        intentId: ACTIVE_ID,
        answeredBlockerIds: [],
        fulfillmentCandidate: { goalType: 'OBTENER_PERSONAS_DEL_PEDIDO' },
      };

      expect(validateHumanIntentTurnDecision(decision, requestInput)).toMatchObject({
        fulfillmentCandidate: { goalType: 'OBTENER_PERSONAS_DEL_PEDIDO' },
      });
    }
  );

  it.each([
    {
      text: '¿Tienen ceviche?',
      decision: {
        decision: 'NEW_INTENT',
        intents: [{ goal: 'EXPLORAR', request: { category: 'ceviche' } }],
      },
    },
    {
      text: 'Después te digo',
      decision: {
        decision: 'CONTINUE_ACTIVE',
        intentId: ACTIVE_ID,
        answeredBlockerIds: [],
      },
    },
  ])('no fuerza fulfillment para "$text" aunque el Goal esté activo', ({ text, decision }) => {
    const requestInput = input({
      turn: { messageId: `wamid.not-fulfillment-${text}`, text },
      context: {
        recentTurns: [{ role: 'assistant', text: '¿Para cuántas personas?' }],
        activeBlockingGoal: 'OBTENER_PERSONAS_DEL_PEDIDO',
      },
      state: { revision: 3, active: { ...active, blockers: [] }, pending: [] },
    });

    expect(validateHumanIntentTurnDecision(decision, requestInput)).not.toHaveProperty(
      'fulfillmentCandidate'
    );
  });

  it('rechaza fulfillmentCandidate sin Goal activo coincidente o sin contrato', () => {
    const requestInput = input({
      context: { recentTurns: [], activeBlockingGoal: undefined },
      state: { revision: 3, active: { ...active, blockers: [] }, pending: [] },
    });
    expect(
      validateHumanIntentTurnDecision(
        {
          decision: 'CONTINUE_ACTIVE',
          intentId: ACTIVE_ID,
          answeredBlockerIds: [],
          fulfillmentCandidate: { goalType: 'OBTENER_PERSONAS_DEL_PEDIDO' },
        },
        requestInput
      )
    ).toBeNull();
  });

  it('falla cerrado si CONTINUE_ACTIVE usa un intentId PENDING como blocker', async () => {
    invokeMock.mockResolvedValue({
      decision: 'CONTINUE_ACTIVE',
      intentId: ACTIVE_ID,
      answeredBlockerIds: [PENDING_ID],
    });

    await expect(runHumanIntentPreflight(input())).resolves.toEqual({ decision: 'AMBIGUOUS' });
    expect(
      validateHumanIntentTurnDecision(
        { decision: 'CONTINUE_ACTIVE', intentId: ACTIVE_ID, answeredBlockerIds: [PENDING_ID] },
        input()
      )
    ).toBeNull();
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
    invokeMock.mockResolvedValue({ decision: 'CANCEL' });
    expect(await runHumanIntentPreflight(input())).toEqual({ decision: 'AMBIGUOUS' });

    invokeMock.mockResolvedValue({ decision: 'CANCEL', intentId: 'invented-id', explanation: 'no' });
    expect(await runHumanIntentPreflight(input())).toEqual({ decision: 'AMBIGUOUS' });

    invokeMock.mockRejectedValue(new Error('model unavailable'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await runHumanIntentPreflight(input())).toEqual({ decision: 'AMBIGUOUS' });
  });
});
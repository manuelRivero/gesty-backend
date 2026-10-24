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

  // R3: la ausencia de contexto previo (ACTIVE/PENDING vacíos) no debe por sí
  // sola forzar AMBIGUOUS. El único mecanismo real que produce AMBIGUOUS acá
  // es la validación de IDs desconocidos en `requestContainsOnlyKnownIds`
  // (ver `rechaza NEW_INTENT PEDIR con un productId...` más abajo) — nunca el
  // estado vacío en sí. Este par de tests fija ese contrato explícitamente
  // con `active: null, pending: []`, en vez de con el ACTIVE/EXPLORAR no
  // relacionado que ya cubría la prueba de línea ~282.
  it('NEW_INTENT PEDIR por nombre, sin IDs, con estado completamente vacío: nunca cae a AMBIGUOUS', async () => {
    const requestInput = input({
      turn: { messageId: 'wamid.lomo-saltado', text: 'Quiero un lomo saltado' },
      context: { recentTurns: [{ role: 'user', text: 'Quiero un lomo saltado' }] },
      state: { revision: 0, active: null, pending: [] },
    });
    const decision = {
      decision: 'NEW_INTENT',
      intents: [{ goal: 'PEDIR', request: { products: ['lomo saltado'] } }],
    };
    invokeMock.mockResolvedValue(decision);

    await expect(runHumanIntentPreflight(requestInput)).resolves.toEqual(decision);
  });

  it('con estado completamente vacío, un productId inventado en la propuesta sigue cayendo a AMBIGUOUS (no por el estado vacío, sino por el ID desconocido)', async () => {
    const requestInput = input({
      turn: { messageId: 'wamid.lomo-saltado-id-inventado', text: 'Quiero un lomo saltado' },
      context: { recentTurns: [{ role: 'user', text: 'Quiero un lomo saltado' }] },
      state: { revision: 0, active: null, pending: [] },
    });
    const decision = {
      decision: 'NEW_INTENT',
      intents: [{
        goal: 'PEDIR',
        // productId inventado: con estado vacío no hay ninguna referencia conocida posible.
        request: { offeredProducts: [{ name: 'Lomo saltado', productId: '99999999-9999-4999-8999-999999999999' }] },
      }],
    };
    invokeMock.mockResolvedValue(decision);

    await expect(runHumanIntentPreflight(requestInput)).resolves.toEqual({ decision: 'AMBIGUOUS' });
    expect(validateHumanIntentTurnDecision(decision, requestInput)).toBeNull();
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

  it('acepta NEW_INTENT PEDIR con el productId de una oferta viva (activeOffer) aunque ACTIVE sea EXPLORAR', async () => {
    const OFFER_PRODUCT_ID = '66666666-6666-4666-8666-666666666666';
    const requestInput = input({
      turn: { messageId: 'wamid.accept-offer', text: 'Bueno dale' },
      context: {
        recentTurns: [
          { role: 'assistant', text: '¿Lo agrego al pedido?' },
          { role: 'user', text: 'Bueno dale' },
        ],
        lastAssistantQuestion: '¿Lo agrego al pedido?',
        activeOffer: { productId: OFFER_PRODUCT_ID, productName: 'Ceviche Clásico' },
      },
      state: {
        revision: 2,
        active: { ...active, goal: 'EXPLORAR', request: { category: 'ceviche' }, blockers: [] },
        pending: [],
      },
    });
    const decision = {
      decision: 'NEW_INTENT',
      intents: [{
        goal: 'PEDIR',
        // "offeredProducts" (no "products"): identidad conservada sin disparar
        // ensurePendingOrderLinesFromRequest (ver pendingOrderLines.service.ts).
        request: { offeredProducts: [{ name: 'Ceviche Clásico', productId: OFFER_PRODUCT_ID }] },
      }],
    };
    invokeMock.mockResolvedValue(decision);

    await expect(runHumanIntentPreflight(requestInput)).resolves.toEqual(decision);
    expect(validateHumanIntentTurnDecision(decision, requestInput)).toEqual(decision);
  });

  it('rechaza NEW_INTENT PEDIR con un productId que no es el de ninguna oferta/referencia conocida', async () => {
    const requestInput = input({
      turn: { messageId: 'wamid.invented-product-id', text: 'Bueno dale' },
      context: {
        recentTurns: [{ role: 'user', text: 'Bueno dale' }],
        activeOffer: { productId: '66666666-6666-4666-8666-666666666666', productName: 'Ceviche Clásico' },
      },
      state: {
        revision: 2,
        active: { ...active, goal: 'EXPLORAR', request: { category: 'ceviche' }, blockers: [] },
        pending: [],
      },
    });
    const decision = {
      decision: 'NEW_INTENT',
      intents: [{
        goal: 'PEDIR',
        // productId inventado: no es el de activeOffer ni de ninguna referencia visible.
        request: { offeredProducts: [{ name: 'Ceviche Clásico', productId: '77777777-7777-4777-8777-777777777777' }] },
      }],
    };
    invokeMock.mockResolvedValue(decision);

    await expect(runHumanIntentPreflight(requestInput)).resolves.toEqual({ decision: 'AMBIGUOUS' });
    expect(validateHumanIntentTurnDecision(decision, requestInput)).toBeNull();
  });

  describe('recentProductRef (referente informativo, no comercial)', () => {
    const REF_PRODUCT_ID = '88888888-8888-4888-8888-888888888888';

    it('1) acepta NEW_INTENT PEDIR con el productId de un referente informativo vigente ("Dame 1")', async () => {
      const requestInput = input({
        turn: { messageId: 'wamid.recent-ref-accept', text: 'Dame 1' },
        context: {
          recentTurns: [
            { role: 'user', text: '¿Cuánto cuesta el ceviche?' },
            { role: 'assistant', text: 'El Ceviche Clásico cuesta $100 y rinde para 2 personas.' },
            { role: 'user', text: 'Dame 1' },
          ],
          recentProductRef: { productId: REF_PRODUCT_ID, productName: 'Ceviche Clásico' },
        },
        state: {
          revision: 2,
          active: { ...active, goal: 'EXPLORAR', request: { category: 'ceviche' }, blockers: [] },
          pending: [],
        },
      });
      const decision = {
        decision: 'NEW_INTENT',
        intents: [{
          goal: 'PEDIR',
          request: { offeredProducts: [{ name: 'Ceviche Clásico', productId: REF_PRODUCT_ID }] },
        }],
      };
      invokeMock.mockResolvedValue(decision);

      await expect(runHumanIntentPreflight(requestInput)).resolves.toEqual(decision);
      expect(validateHumanIntentTurnDecision(decision, requestInput)).toEqual(decision);
    });

    it('3) rechaza un productId que no es el del referente informativo ni de ninguna otra referencia conocida (sin selección silenciosa)', async () => {
      const requestInput = input({
        turn: { messageId: 'wamid.recent-ref-unknown-id', text: 'Dame 1' },
        context: {
          recentTurns: [{ role: 'user', text: 'Dame 1' }],
          recentProductRef: { productId: REF_PRODUCT_ID, productName: 'Ceviche Clásico' },
        },
        state: {
          revision: 2,
          active: { ...active, goal: 'EXPLORAR', request: { category: 'ceviche' }, blockers: [] },
          pending: [],
        },
      });
      const decision = {
        decision: 'NEW_INTENT',
        intents: [{
          goal: 'PEDIR',
          // productId inventado: no es el del referente informativo del contexto.
          request: { offeredProducts: [{ name: 'Milanesa', productId: '99999999-9999-4999-8999-999999999999' }] },
        }],
      };
      invokeMock.mockResolvedValue(decision);

      await expect(runHumanIntentPreflight(requestInput)).resolves.toEqual({ decision: 'AMBIGUOUS' });
      expect(validateHumanIntentTurnDecision(decision, requestInput)).toBeNull();
    });

    it('4) un producto nombrado explícitamente sigue resolviéndose por nombre, sin depender de recentProductRef', async () => {
      const requestInput = input({
        turn: { messageId: 'wamid.recent-ref-explicit-name', text: 'Dame 1 milanesa' },
        context: {
          recentTurns: [{ role: 'user', text: 'Dame 1 milanesa' }],
          recentProductRef: { productId: REF_PRODUCT_ID, productName: 'Ceviche Clásico' },
        },
        state: {
          revision: 2,
          active: { ...active, goal: 'EXPLORAR', request: { category: 'ceviche' }, blockers: [] },
          pending: [],
        },
      });
      // El nombre explícito en el mensaje ("milanesa") no requiere ningún ID
      // conocido: sigue el mismo camino que "Quiero un ceviche" hoy.
      const decision = {
        decision: 'NEW_INTENT',
        intents: [{ goal: 'PEDIR', request: { products: ['milanesa'] } }],
      };
      invokeMock.mockResolvedValue(decision);

      await expect(runHumanIntentPreflight(requestInput)).resolves.toEqual(decision);
      expect(validateHumanIntentTurnDecision(decision, requestInput)).toEqual(decision);
    });

    it('5/9) con activeOffer vigente sobre OTRO producto, también se acepta el productId de activeOffer (precedencia la aplica dispatch al construir el contexto, no esta validación)', async () => {
      const OFFER_PRODUCT_ID = '77777777-7777-4777-8777-aaaaaaaaaaaa';
      const requestInput = input({
        turn: { messageId: 'wamid.recent-ref-vs-active-offer', text: 'Dale' },
        context: {
          recentTurns: [{ role: 'user', text: 'Dale' }],
          activeOffer: { productId: OFFER_PRODUCT_ID, productName: 'Milanesa Napolitana' },
          // En producción dispatch nunca envía ambos a la vez (ver
          // dispatch/index.ts: recentProductRef se omite si hay activeOffer).
          // Esta prueba documenta que, si igual llegara, el allowlist de IDs
          // conocidos sigue aceptando el de la oferta comercial sin problema.
        },
        state: {
          revision: 2,
          active: { ...active, goal: 'EXPLORAR', request: { category: 'milanesa' }, blockers: [] },
          pending: [],
        },
      });
      const decision = {
        decision: 'NEW_INTENT',
        intents: [{
          goal: 'PEDIR',
          request: { offeredProducts: [{ name: 'Milanesa Napolitana', productId: OFFER_PRODUCT_ID }] },
        }],
      };
      invokeMock.mockResolvedValue(decision);

      await expect(runHumanIntentPreflight(requestInput)).resolves.toEqual(decision);
      expect(validateHumanIntentTurnDecision(decision, requestInput)).toEqual(decision);
    });

    it('8) el prompt instruye explícitamente a NO activar la regla ante una aceptación desnuda sin verbo de pedido', () => {
      expect(HUMAN_INTENT_PREFLIGHT_SYSTEM_PROMPT).toContain(
        '"ok", "gracias", "ya veo", "ah bueno", "dale" sin más) NO activa esta regla'
      );
    });

    it('2) el prompt instruye explícitamente a no forzar recentProductRef cuando el mensaje nombra otro producto', () => {
      expect(HUMAN_INTENT_PREFLIGHT_SYSTEM_PROMPT).toContain(
        'Si el mensaje nombra otro plato distinto del de recentProductRef, no lo fuerces'
      );
    });

    it('10) el referente informativo no cambia qué decide la capa de preflight sobre otros goals ni pisa un RESUME_PENDING válido', async () => {
      // Regresión: con recentProductRef presente, un RESUME_PENDING legítimo
      // (sin relación con el producto referenciado) sigue validando igual que
      // sin la nueva propiedad de contexto.
      const requestInput = input({
        turn: { messageId: 'wamid.recent-ref-no-interference', text: '¿Qué postres tienen?' },
        context: {
          recentTurns: [{ role: 'user', text: '¿Qué postres tienen?' }],
          recentProductRef: { productId: REF_PRODUCT_ID, productName: 'Ceviche Clásico' },
        },
        state: { revision: 3, active: { ...active, blockers: [] }, pending: [pending] },
      });
      const decision = { decision: 'RESUME_PENDING', intentId: PENDING_ID };
      invokeMock.mockResolvedValue(decision);

      await expect(runHumanIntentPreflight(requestInput)).resolves.toEqual(decision);
      expect(validateHumanIntentTurnDecision(decision, requestInput)).toEqual(decision);
    });
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

  // Contrato #4: una intención PENDING sin ACTIVE (p. ej. tras un CONTINUE_ACTIVE
  // o REPLACE previo que dejó el ACTIVE resuelto/cerrado) debe poder retomarse
  // igual que con ACTIVE presente, y un ID inventado debe seguir rechazándose —
  // el contrato de RESUME_PENDING no depende de que exista un ACTIVE.
  it('retoma un PENDING válido sin ACTIVE, y rechaza un ID inventado en el mismo escenario', async () => {
    const requestInput = input({
      turn: { messageId: 'wamid.pending-no-active', text: '¿Qué postres tienen?' },
      state: { revision: 1, active: null, pending: [pending] },
    });
    const decision = { decision: 'RESUME_PENDING', intentId: PENDING_ID };
    invokeMock.mockResolvedValue(decision);
    await expect(runHumanIntentPreflight(requestInput)).resolves.toEqual(decision);

    const invented = { decision: 'RESUME_PENDING', intentId: '99999999-9999-4999-8999-999999999999' };
    invokeMock.mockResolvedValue(invented);
    await expect(runHumanIntentPreflight(requestInput)).resolves.toEqual({ decision: 'AMBIGUOUS' });
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

  it('valida fulfillmentCandidate de cantidad para el Goal blocking activo', () => {
    const requestInput = input({
      turn: { messageId: 'wamid.qty-2', text: '2' },
      context: {
        recentTurns: [{ role: 'assistant', text: '¿Cuántas unidades de papas querés?' }],
        lastAssistantQuestion: '¿Cuántas unidades de papas querés?',
        activeBlockingGoal: 'OBTENER_CANTIDAD_DEL_PRODUCTO',
      },
      state: { revision: 3, active: { ...active, blockers: [] }, pending: [] },
    });
    expect(validateHumanIntentTurnDecision({
      decision: 'CONTINUE_ACTIVE',
      intentId: ACTIVE_ID,
      answeredBlockerIds: [],
      fulfillmentCandidate: { goalType: 'OBTENER_CANTIDAD_DEL_PRODUCTO' },
    }, requestInput)).toMatchObject({
      fulfillmentCandidate: { goalType: 'OBTENER_CANTIDAD_DEL_PRODUCTO' },
    });
  });

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

  describe('diagnóstico de decisión cruda vs. validación', () => {
    const lastDiagnosticEvent = (logSpy: ReturnType<typeof vi.spyOn>) => {
      const calls = (logSpy.mock.calls as Array<[string]>)
        .map(([payload]) => JSON.parse(payload) as Record<string, unknown>)
        .filter((payload) => payload.event === '[human-intent-preflight] diagnostic');
      return calls[calls.length - 1];
    };

    it('registra una decisión aceptada sin motivo de rechazo', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      invokeMock.mockResolvedValue({ decision: 'NO_INTENT' });

      await runHumanIntentPreflight(input({ turn: { messageId: 'wamid.diag-ok', text: 'Hola' } }));

      expect(lastDiagnosticEvent(logSpy)).toMatchObject({
        messageId: 'wamid.diag-ok',
        stage: 'validated',
        rawDecisionType: 'NO_INTENT',
        accepted: true,
        rejectionReason: null,
        finalDecision: 'NO_INTENT',
      });
    });

    it('distingue AMBIGUOUS crudo del LLM de un output con schema inválido', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      invokeMock.mockResolvedValue({ decision: 'AMBIGUOUS' });
      await runHumanIntentPreflight(input({ turn: { messageId: 'wamid.diag-raw-ambiguous', text: 'Ceviche clasico' } }));
      expect(lastDiagnosticEvent(logSpy)).toMatchObject({
        rawDecisionType: 'AMBIGUOUS',
        accepted: true,
        rejectionReason: null,
        finalDecision: 'AMBIGUOUS',
      });

      invokeMock.mockResolvedValue({ foo: 'bar' });
      await runHumanIntentPreflight(input({ turn: { messageId: 'wamid.diag-schema-invalid', text: 'Ceviche clasico' } }));
      expect(lastDiagnosticEvent(logSpy)).toMatchObject({
        rawDecisionType: 'unrecognized',
        accepted: false,
        rejectionReason: 'schema_invalid',
        finalDecision: 'AMBIGUOUS',
      });
    });

    it('etiqueta el rechazo de CONTINUE_ACTIVE con blocker desconocido', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      invokeMock.mockResolvedValue({
        decision: 'CONTINUE_ACTIVE',
        intentId: ACTIVE_ID,
        answeredBlockerIds: [PENDING_ID],
      });

      await runHumanIntentPreflight(input({ turn: { messageId: 'wamid.diag-blocker', text: 'Para tres' } }));

      expect(lastDiagnosticEvent(logSpy)).toMatchObject({
        rawDecisionType: 'CONTINUE_ACTIVE',
        accepted: false,
        rejectionReason: 'continue_active_unknown_blocker',
        finalDecision: 'AMBIGUOUS',
      });
    });

    it('etiqueta el rechazo de RESUME_PENDING inventado', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      invokeMock.mockResolvedValue({ decision: 'RESUME_PENDING', intentId: '<ID_PENDING>' });

      await runHumanIntentPreflight(input({ turn: { messageId: 'wamid.diag-resume', text: '¿Qué postres tienen?' } }));

      expect(lastDiagnosticEvent(logSpy)).toMatchObject({
        rawDecisionType: 'RESUME_PENDING',
        accepted: false,
        rejectionReason: 'resume_pending_unknown_id',
        finalDecision: 'AMBIGUOUS',
      });
    });

    it('registra stage empty_turn cuando falta texto o messageId', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await runHumanIntentPreflight(input({ turn: { messageId: '', text: 'algo' } }));

      expect(lastDiagnosticEvent(logSpy)).toMatchObject({
        messageId: '',
        stage: 'empty_turn',
        finalDecision: 'AMBIGUOUS',
      });
    });

    it('registra stage llm_error cuando el LLM lanza una excepción', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});
      invokeMock.mockRejectedValue(new Error('model unavailable'));

      await runHumanIntentPreflight(input({ turn: { messageId: 'wamid.diag-error', text: 'Ceviche clasico' } }));

      expect(lastDiagnosticEvent(logSpy)).toMatchObject({
        messageId: 'wamid.diag-error',
        stage: 'llm_error',
        finalDecision: 'AMBIGUOUS',
      });
    });
  });
});
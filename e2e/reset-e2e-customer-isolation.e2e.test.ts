/**
 * Aislamiento del harness E2E — `resetE2eCustomer` no debe heredar
 * `humanIntentState` de una corrida anterior (ni de una conversación real
 * sobre el mismo teléfono de prueba compartido, ver auditoría
 * "contaminación de historial y estado conversacional en Gesty").
 *
 * No invoca el grafo ni al LLM — solo ejercita `resetE2eCustomer` (lectura/
 * escritura real de Postgres) y lee `conversation_state.metadata` después.
 * Mismo gate (`isE2eEnabled`) que el resto de `e2e/`: requiere `E2E_RUN=1` y,
 * desde este cambio, se niega explícitamente si `NODE_ENV=production`.
 *
 * Alcance real (auditoría E2E, Fase 4): a pesar del nombre del archivo, este
 * test cubre ÚNICAMENTE el vector de contaminación de `humanIntentState` en
 * `conversation_state.metadata`. `resetE2eCustomer` /
 * `resetTestCustomerOperationalState` NUNCA tocan `conversation_message`
 * (historial), `orders` confirmadas ni `reservation` — esos tres tipos de
 * dato pueden seguir contaminándose/acumulándose entre corridas E2E y no
 * tienen un test de aislamiento dedicado. No ampliar este test ni el reset
 * para cubrirlos sin una decisión explícita (ver riesgos pendientes del
 * informe de la Fase 4): borrar `orders`/`reservation`/mensajes reales de
 * forma indiscriminada sería una operación destructiva sobre BD compartida.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isE2eEnabled, applyE2eEnv } from './helpers/env';
import { disconnectPrisma, resetE2eCustomer } from './helpers/graphHarness';

describe.skipIf(!isE2eEnabled())('resetE2eCustomer — aislamiento de humanIntentState', () => {
  beforeAll(() => {
    applyE2eEnv();
  });

  afterAll(async () => {
    await disconnectPrisma();
  });

  it('elimina humanIntentState de una corrida anterior sin dejar un valor parcial u obsoleto', async () => {
    const { prisma } = await import('../src/lib/prisma');

    // Deja la conversación en un estado limpio conocido antes de "contaminarla".
    const { conversationId } = await resetE2eCustomer();

    // Simula lo que deja una corrida (o conversación real) anterior: un
    // HumanIntentRecord PEDIR ACTIVE con `request.products` ajeno a este caso,
    // más una clave de marca que NO está en el omit list de resetE2eCustomer.
    const staleHumanIntentState = {
      version: 1,
      revision: 3,
      nextSequence: 2,
      processedMessageIds: ['msg-de-otra-corrida'],
      records: [
        {
          id: 'stale-intent-id',
          sequence: 1,
          goal: 'PEDIR',
          request: { products: [{ name: 'papas a la huancaína', note: 'mucho picante' }] },
          status: 'ACTIVE',
          blockers: [],
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    };
    const isolationMarkerKey = '__e2eIsolationTestMarker';
    const before = await prisma.conversation_state.findUnique({
      where: { conversation_id: conversationId },
      select: { metadata: true },
    });
    const beforeMeta = (before?.metadata ?? {}) as Record<string, unknown>;
    await prisma.conversation_state.update({
      where: { conversation_id: conversationId },
      data: {
        metadata: {
          ...beforeMeta,
          humanIntentState: staleHumanIntentState,
          [isolationMarkerKey]: 'should-survive-the-reset',
        },
      },
    });

    const seeded = await prisma.conversation_state.findUnique({
      where: { conversation_id: conversationId },
      select: { metadata: true },
    });
    const seededMeta = seeded?.metadata as Record<string, unknown>;
    expect(seededMeta.humanIntentState, 'se sembró humanIntentState antes del reset').toMatchObject({
      records: [expect.objectContaining({ status: 'ACTIVE', goal: 'PEDIR' })],
    });

    // El reset que haría el SIGUIENTE caso del archivo E2E.
    await resetE2eCustomer();

    const after = await prisma.conversation_state.findUnique({
      where: { conversation_id: conversationId },
      select: { metadata: true },
    });
    const afterMeta = after?.metadata as Record<string, unknown>;

    expect(afterMeta.humanIntentState, 'humanIntentState no sobrevive al reset').toBeUndefined();
    expect(
      Object.prototype.hasOwnProperty.call(afterMeta, 'humanIntentState'),
      'la clave humanIntentState se borra, no queda como null/parcial'
    ).toBe(false);

    // El reset es quirúrgico (omit de claves puntuales), no un reemplazo
    // total del objeto: una clave que resetE2eCustomer no conoce sobrevive.
    expect(afterMeta[isolationMarkerKey], 'una clave ajena al omit list no se pierde').toBe(
      'should-survive-the-reset'
    );

    // Las claves que el contrato de reset siempre fija siguen aplicándose
    // igual que antes de este cambio (sin regresión del comportamiento existente).
    expect(afterMeta.checkout_active).toBe(false);
    expect(afterMeta.peopleCount).toBe(2);
    expect(afterMeta.requestedPartySize).toBe(2);
    // Claves que ya estaban en el omit list original siguen limpiándose.
    expect(afterMeta.pendingOrderLines).toBeUndefined();
    expect(afterMeta.pendingVariation).toBeUndefined();
  }, 60_000);
});

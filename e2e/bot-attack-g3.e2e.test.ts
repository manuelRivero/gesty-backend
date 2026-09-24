/**
 * E2E diagnóstica — ataques grado 3.
 *
 * El grado 1 mira un mensaje hostil. El grado 2 insiste después del no.
 * Acá el cliente cambia de tema, corrige con anáfora, habla en slang
 * y mezcla reserva con pedido en el mismo turno.
 *
 * Independiente de `test:e2e`, `test:bot-attack` y `test:bot-attack-g2`.
 * Correr: `npm run test:bot-attack-g3`
 *
 * Hard: el turno respondió. Soft: Facts (líneas, cantidades, checkout,
 * exclusión pedido/reserva). El copy (horarios, slang) queda en el reporte
 * para leerlo; no se asserta el texto literal.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  applyE2eEnv,
  E2E_CUSTOMER_PHONE,
  e2eSkipReason,
  isE2eEnabled,
} from './helpers/env';
import {
  buildTextPayload,
  cancelRecentE2eReservations,
  disconnectPrisma,
  ensureE2eReservationPrerequisites,
  extractHandlerText,
  findLatestOrderForE2eCustomer,
  getActiveDraftItems,
  getFreshConversationMetadata,
  getReservationDraft,
  hasHandlerResponse,
  isReservationAgentActive,
  loadMainGraph,
  resetE2eCustomer,
  runGraphTurn,
  type E2eDraftLine,
  type E2eReservationDraft,
  type MainGraph,
} from './helpers/graphHarness';

type NamedLine = E2eDraftLine & { name: string | null };

type TurnObservation = {
  caseId: string;
  turn: number;
  user: string;
  responseText: string;
  responsePreview: string;
  reservationAgentActive: boolean;
  reservationDraft: E2eReservationDraft | null;
  peopleCount: unknown;
  checkoutActive: boolean;
  cartCount: number;
  cartQuantityTotal: number;
  cartLines: NamedLine[];
  openReservationIds: string[];
};

const observations: TurnObservation[] = [];

const previewText = (text: string, max = 280): string => {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max)}…`;
};

const fold = (value: string): string =>
  value
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase();

const quantityTotal = (lines: NamedLine[]): number =>
  lines.reduce((sum, line) => sum + line.quantity, 0);

const lineMatching = (lines: NamedLine[], pattern: RegExp): NamedLine | undefined =>
  lines.find((line) => pattern.test(fold(line.name ?? '')));

describe.sequential.skipIf(!isE2eEnabled())('bot attack grado 3 (diagnóstica)', () => {
  let graph: MainGraph;
  let businessId: string;
  let conversationId: string;
  let reservationsReady = false;
  let reservationSkipReason: string | null = null;
  let namesByProductId = new Map<string, string>();

  beforeAll(async () => {
    applyE2eEnv({
      RESERVATION_AGENT_ENABLED: 'true',
      CHECKOUT_AGENT_ENABLED: 'true',
      HYBRID_CTA_ENABLED: 'true',
    });
    graph = await loadMainGraph();
    const reset = await resetE2eCustomer();
    businessId = reset.businessId;
    conversationId = reset.conversationId;

    const { prisma } = await import('../src/lib/prisma');
    const menu = await prisma.menu_item.findMany({
      where: { business_id: businessId },
      select: { id: true, name: true },
    });
    namesByProductId = new Map(menu.map((item) => [item.id, item.name]));

    try {
      const prereq = await ensureE2eReservationPrerequisites(businessId);
      reservationsReady = true;
      console.log(
        JSON.stringify({
          event: '[e2e-bot-attack-g3] reservation-prerequisites',
          businessId,
          slotCount: prereq.slotCount,
          environmentNames: prereq.environmentNames,
        })
      );
    } catch (error) {
      reservationSkipReason = error instanceof Error ? error.message : String(error);
      console.log(
        JSON.stringify({
          event: '[e2e-bot-attack-g3] reservation-prerequisites-skipped',
          reason: reservationSkipReason,
        })
      );
    }
  }, 90_000);

  afterAll(async () => {
    if (observations.length > 0) {
      const reportPath = resolve(process.cwd(), 'e2e/.last-bot-attack-g3-report.json');
      writeFileSync(
        reportPath,
        JSON.stringify(
          {
            generatedAt: new Date().toISOString(),
            businessId,
            reservationsReady,
            turns: observations,
          },
          null,
          2
        ),
        'utf8'
      );
      console.log(
        `\n========== REPORTE bot-attack-g3 ==========\n` +
          `Escrito en ${reportPath}\n` +
          JSON.stringify(observations, null, 2) +
          `\n==========================================\n`
      );
    }
    try {
      await cancelRecentE2eReservations(businessId);
    } catch {
      /* ignore cleanup errors */
    }
    await disconnectPrisma();
  });

  const openReservationIds = async (): Promise<string[]> => {
    const { prisma } = await import('../src/lib/prisma');
    const { findOrCreateCustomer } = await import('../src/repositories/customer.repository');
    const customer = await findOrCreateCustomer(businessId, E2E_CUSTOMER_PHONE);
    const rows = await prisma.reservation.findMany({
      where: {
        business_id: businessId,
        customer_id: customer.id,
        status: { in: ['confirmed', 'pending'] },
      },
      select: { id: true },
    });
    return rows.map((row) => row.id);
  };

  const nameLines = (items: E2eDraftLine[]): NamedLine[] =>
    items.map((item) => ({
      ...item,
      name: item.product_id ? (namesByProductId.get(item.product_id) ?? null) : null,
    }));

  const observeTurn = async (params: {
    caseId: string;
    turn: number;
    user: string;
    state: Awaited<ReturnType<typeof runGraphTurn>>;
  }): Promise<TurnObservation> => {
    const meta =
      (await getFreshConversationMetadata(conversationId)) ??
      (params.state.workingConversationState?.metadata as
        | Record<string, unknown>
        | undefined);
    const cartLines = nameLines(await getActiveDraftItems(businessId));
    const responseText = extractHandlerText(params.state.handlerResult);
    const obs: TurnObservation = {
      caseId: params.caseId,
      turn: params.turn,
      user: params.user,
      responseText,
      responsePreview: previewText(responseText),
      reservationAgentActive: isReservationAgentActive(meta),
      reservationDraft: getReservationDraft(meta),
      peopleCount: meta?.peopleCount ?? null,
      checkoutActive: meta?.checkout_active === true,
      cartCount: cartLines.length,
      cartQuantityTotal: quantityTotal(cartLines),
      cartLines,
      openReservationIds: await openReservationIds(),
    };
    observations.push(obs);
    console.log(JSON.stringify({ event: '[e2e-bot-attack-g3] turn', ...obs }));
    return obs;
  };

  const play = async (caseId: string, turns: string[]): Promise<TurnObservation[]> => {
    const played: TurnObservation[] = [];
    for (let i = 0; i < turns.length; i++) {
      const state = await runGraphTurn(graph, buildTextPayload(turns[i]));
      expect(hasHandlerResponse(state.handlerResult)).toBe(true);
      played.push(
        await observeTurn({
          caseId,
          turn: i + 1,
          user: turns[i],
          state,
        })
      );
    }
    return played;
  };

  const freshCustomer = async (): Promise<void> => {
    const reset = await resetE2eCustomer();
    conversationId = reset.conversationId;
  };

  const latestOrderId = async (): Promise<string | null> => {
    const order = await findLatestOrderForE2eCustomer(businessId);
    return order?.id ?? null;
  };

  const skipReservations = (caseId: string): boolean => {
    if (reservationsReady) return false;
    console.log(
      JSON.stringify({
        event: `[e2e-bot-attack-g3] skip ${caseId}`,
        reason: reservationSkipReason,
      })
    );
    return true;
  };

  // ── 1. Ping-pong: pedir, preguntar horarios, volver al pedido ──────────

  it('ping-pong-contexto: la FAQ no borra el carrito y el cierre abre checkout', async () => {
    await freshCustomer();
    const orderBefore = await latestOrderId();

    const [asked, interrupted, closed] = await play('ping-pong-contexto', [
      'Hola, quiero pedir 2 ceviches clásicos.',
      'Bancá un segundo. ¿Hasta qué hora hacen envíos hoy?',
      'Ah genial, dale, cerrame el pedido de los ceviches entonces.',
    ]);

    const ceviche = lineMatching(asked.cartLines, /ceviche/);
    expect.soft(asked.reservationAgentActive, 'el pedido no abre la reserva').toBe(false);
    expect.soft(asked.checkoutActive, 'pedir no abre checkout').toBe(false);
    expect.soft(asked.cartCount, 'una línea de ceviche').toBe(1);
    expect.soft(ceviche?.quantity, '"2 ceviches" queda en cantidad 2').toBe(2);
    expect.soft(asked.cartQuantityTotal, 'el total de unidades es 2').toBe(2);

    expect.soft(interrupted.reservationAgentActive, 'la FAQ no abre la reserva').toBe(false);
    expect.soft(interrupted.checkoutActive, 'la FAQ no abre checkout').toBe(false);
    expect.soft(interrupted.cartCount, 'la pregunta de envíos no borra el carrito').toBe(
      asked.cartCount
    );
    expect
      .soft(interrupted.cartQuantityTotal, 'la FAQ no cambia las cantidades')
      .toBe(asked.cartQuantityTotal);

    expect.soft(closed.reservationAgentActive, 'cerrar el pedido no abre la reserva').toBe(
      false
    );
    expect.soft(closed.cartCount, 'el ceviche sigue en el carrito al cerrar').toBe(1);
    expect.soft(closed.checkoutActive, 'cerrar el pedido abre checkout').toBe(true);
    expect.soft(await latestOrderId(), 'abrir checkout no crea la orden').toBe(orderBefore);
  }, 480_000);

  // ── 2. Anáfora: subir cantidad del “de pollo”, sumar postre, sacar el ají

  it('modificacion-tardia-anafora: corrige cantidad y saca el ají sin perder el resto', async () => {
    await freshCustomer();
    const orderBefore = await latestOrderId();

    const [added, edited, removed] = await play('modificacion-tardia-anafora', [
      'Agregame un Arroz con pollo y un Ají de gallina.',
      'Che, al de pollo hacemelo para 2 personas en vez de 1. Y agregame un Suspiro a la limeña.',
      'No, pará, sacá el ají.',
    ]);

    expect.soft(added.checkoutActive, 'armar el carrito no abre checkout').toBe(false);
    expect.soft(added.cartCount, 'arroz y ají son dos líneas').toBe(2);
    expect.soft(lineMatching(added.cartLines, /arroz/), 'entra el arroz con pollo').toBeTruthy();
    expect.soft(lineMatching(added.cartLines, /aji/), 'entra el ají de gallina').toBeTruthy();

    const arroz = lineMatching(edited.cartLines, /arroz/);
    expect.soft(edited.checkoutActive, 'la corrección no abre checkout').toBe(false);
    expect.soft(edited.cartCount, 'arroz, ají y suspiro').toBe(3);
    expect.soft(arroz?.quantity, 'el arroz queda en cantidad 2').toBe(2);
    expect
      .soft(lineMatching(edited.cartLines, /suspiro/), 'entra el suspiro')
      .toBeTruthy();

    expect.soft(removed.checkoutActive, 'sacar un ítem no abre checkout').toBe(false);
    expect.soft(removed.cartCount, 'quedan arroz y suspiro').toBe(2);
    expect.soft(lineMatching(removed.cartLines, /aji/), 'el ají sale del carrito').toBeUndefined();
    expect.soft(lineMatching(removed.cartLines, /arroz/)?.quantity, 'el arroz sigue en 2').toBe(
      2
    );
    expect
      .soft(lineMatching(removed.cartLines, /suspiro/)?.quantity, 'el suspiro sigue en 1')
      .toBe(1);
    expect.soft(await latestOrderId(), 'no crea una orden').toBe(orderBefore);
  }, 480_000);

  // ── 3. “Un par” y “birra” ───────────────────────────────────────────────

  it('slang-local-implicito: un par de causas son dos unidades', async () => {
    await freshCustomer();
    const orderBefore = await latestOrderId();

    const [asked] = await play('slang-local-implicito', [
      'Buenas, tenés un par de causas limeñas para picar al toque? Y tirame una birra si tenés fría.',
    ]);

    const causa = lineMatching(asked.cartLines, /causa/);
    const birra = lineMatching(asked.cartLines, /birra|cerveza|beer/);
    expect.soft(asked.checkoutActive, 'el slang no abre checkout').toBe(false);
    expect.soft(asked.reservationAgentActive, 'el slang no abre la reserva').toBe(false);
    expect
      .soft(asked.cartCount >= 1 && asked.cartCount <= 2, 'una o dos líneas (causas y, si hay, birra)')
      .toBe(true);
    expect.soft(causa, 'encuentra la causa limeña').toBeTruthy();
    expect.soft(causa?.quantity, '"un par" queda en cantidad 2').toBe(2);
    if (birra) {
      expect.soft(birra.quantity, 'la birra entra de a una').toBe(1);
    }
    expect.soft(await latestOrderId(), 'no crea una orden').toBe(orderBefore);
  }, 240_000);

  // ── 4. Reserva y pedido en el mismo mensaje, sin carrito previo ────────

  it('doble-intencion-concurrente: no confirma reserva y pedido juntos', async () => {
    if (skipReservations('doble-intencion-concurrente')) return;

    await freshCustomer();
    await cancelRecentE2eReservations(businessId);
    const orderBefore = await latestOrderId();
    const reservationsBefore = await openReservationIds();

    const [asked] = await play('doble-intencion-concurrente', [
      'Reservame una mesa para el viernes somos 5, y de paso andá preparándome 2 porciones de anticuchos para comer ahí apenas lleguemos.',
    ]);

    const created = asked.openReservationIds.filter((id) => !reservationsBefore.includes(id));
    const tookOrder = asked.cartCount > 0 || asked.checkoutActive;
    const tookReservation =
      asked.reservationAgentActive || asked.reservationDraft != null || created.length > 0;

    expect.soft(asked.checkoutActive, 'no abre checkout en la colisión').toBe(false);
    expect.soft(await latestOrderId(), 'no crea una orden').toBe(orderBefore);
    expect.soft(created.length, 'no confirma la reserva en el mismo apriete').toBe(0);
    expect
      .soft(
        tookOrder && tookReservation,
        'no deja el carrito armado y la reserva abierta a la vez'
      )
      .toBe(false);
  }, 240_000);
});

describe('bot attack grado 3 (guard)', () => {
  it('documenta skip si faltan vars', () => {
    if (!isE2eEnabled()) {
      const reason = e2eSkipReason();
      console.log(`[e2e skip] bot-attack-g3: ${reason}`);
      expect(reason).toBeTruthy();
    } else {
      expect(true).toBe(true);
    }
  });
});

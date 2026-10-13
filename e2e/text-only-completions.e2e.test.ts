/**
 * E2E Etapa E2 — Recorridos completamente naturales (sin botones).
 *
 * E2-A: pedido por texto desde cero. E2-B: reserva por texto desde cero.
 *
 * Reglas (ver tarea): pipeline real de ingreso (`mainGraph.invoke` vía
 * `runGraphTurn`/`buildTextPayload`), grafo y tools reales. Prohibido
 * `persistLastOffer` / `ensureE2eButtonProductResolution` / extraer
 * payloads `ADD_ITEM:`/`RESERVATION_SLOT:` de una respuesta para simular
 * un click, o escribir anticipadamente en metadata el estado que el
 * agente debe resolver. Se permite preparar datos de negocio deterministas
 * (menú, slots, mesas, ambientes) — nunca el resultado de la decisión
 * evaluada (qué producto/horario elige el agente).
 *
 * Cada turno se registra en consola y en un reporte JSON como evidencia,
 * incluido el punto exacto de bloqueo si el recorrido no cierra solo.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { applyE2eEnv, e2eSkipReason, isE2eEnabled } from './helpers/env';
import {
  buildTextPayload,
  cancelRecentE2eReservations,
  disconnectPrisma,
  ensureE2eReservationPrerequisites,
  extractHandlerText,
  findE2eAddableProduct,
  getActiveDraftItems,
  getFreshConversationMetadata,
  getReservationDraft,
  hasHandlerResponse,
  hasInteractiveFollowUp,
  hasListFollowUp,
  loadMainGraph,
  resetE2eCustomer,
  runGraphTurn,
  type MainGraph,
} from './helpers/graphHarness';
import { getPendingAddQuantity } from '../src/services/pendingAddQuantity.service';
import { getPendingVariation } from '../src/services/pendingVariation.service';
import { getLastOffer } from '../src/services/lastOffer.service';
import { formatDMY, nextDateForWeekday } from '../src/services/reservations/clock';
import { nextReservationStep } from '../src/services/reservations/nextReservationStep';

const TZ = 'America/Argentina/Buenos_Aires';

type TurnEvidence = {
  caseId: string;
  turn: number;
  user: string;
  responsePreview: string;
};

const evidence: TurnEvidence[] = [];

const previewText = (text: string, max = 300): string => {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max)}…`;
};

describe.sequential.skipIf(!isE2eEnabled())('text-only completions (e2e etapa E2)', () => {
  let graph: MainGraph;
  let businessId: string;
  let conversationId: string;

  beforeAll(async () => {
    applyE2eEnv({
      CHECKOUT_AGENT_ENABLED: 'true',
      HYBRID_CTA_ENABLED: 'true',
      RESERVATION_AGENT_ENABLED: 'true',
    });
    graph = await loadMainGraph();
    const reset = await resetE2eCustomer();
    businessId = reset.businessId;
    conversationId = reset.conversationId;
  }, 60_000);

  afterAll(async () => {
    if (evidence.length > 0) {
      const reportPath = resolve(process.cwd(), 'e2e/.last-text-only-completions-report.json');
      writeFileSync(
        reportPath,
        JSON.stringify({ generatedAt: new Date().toISOString(), turns: evidence }, null, 2),
        'utf8'
      );
      console.log(`\n[e2e-text-only] reporte escrito en ${reportPath}\n`);
    }
    await disconnectPrisma();
  });

  // ── E2-A: pedido por texto desde cero ────────────────────────────────────

  it('E2-A: pedido por texto desde cero resuelve producto por ReAct real (sin botones)', async () => {
    const reset = await resetE2eCustomer();
    conversationId = reset.conversationId;
    const caseId = 'E2-A';

    // `resetE2eCustomer` no limpia `humanIntentState` (mismo convenio que
    // `human-intent-lifecycle.e2e.test.ts`): sin esto, HumanIntents de un
    // caso previo en la misma conversación contaminan el preflight de este.
    const { patchConversationMetadata } = await import(
      '../src/repositories/conversationState.repository'
    );
    await patchConversationMetadata(conversationId, {
      humanIntentState: {
        version: 1,
        revision: 0,
        nextSequence: 1,
        processedMessageIds: [],
        records: [],
      },
    });

    const product = await findE2eAddableProduct(businessId);

    const send = async (text: string) => {
      const state = await runGraphTurn(graph, buildTextPayload(text));
      const turnNum = evidence.filter((e) => e.caseId === caseId).length + 1;
      const obs: TurnEvidence = {
        caseId,
        turn: turnNum,
        user: text,
        responsePreview: previewText(extractHandlerText(state.handlerResult)),
      };
      evidence.push(obs);
      console.log(JSON.stringify({ event: '[e2e-text-only] E2-A turn', ...obs }));
      return state;
    };

    let state = await send(`Quiero pedir un ${product.name}`);
    expect(hasHandlerResponse(state.handlerResult)).toBe(true);

    let added = false;
    let blockedReason: string | null = null;
    let triedExactName = false;

    for (let step = 0; step < 8; step++) {
      const items = await getActiveDraftItems(businessId);
      if (items.some((i) => i.product_id === product.id)) {
        added = true;
        break;
      }

      const meta = await getFreshConversationMetadata(conversationId);

      const pendingVar = getPendingVariation(meta);
      if (pendingVar?.productId === product.id && pendingVar.variations?.length) {
        state = await send(pendingVar.variations[0]);
        continue;
      }

      const pendingQty = getPendingAddQuantity(meta);
      if (pendingQty?.productId === product.id) {
        state = await send(String(pendingQty.suggestedQuantity));
        continue;
      }

      // Gate de cantidad de línea (order_line_quantity_required): el agente
      // pregunta en prosa, sin tipable en metadata que el test pueda leer.
      if (/cu[aá]ntas unidades/i.test(extractHandlerText(state.handlerResult))) {
        state = await send('Una');
        continue;
      }

      // Oferta que el PROPIO agente dejó activa (no sembrada por el test).
      const offer = getLastOffer(meta);
      if (offer?.productId === product.id) {
        state = await send('Sí, agregalo');
        continue;
      }

      // Shortlist mostrada por el agente (interactiva o en prosa con
      // "escribime el nombre"): elegir por nombre real en texto, una sola
      // vez (no extraer el payload ADD_ITEM: de la respuesta).
      const responseText = extractHandlerText(state.handlerResult);
      const looksLikeShortlist =
        hasListFollowUp(state.handlerResult) ||
        hasInteractiveFollowUp(state.handlerResult) ||
        /escrib[ií]me el nombre|cu[aá]l te gustar[ií]a|seleccion[aá]/i.test(responseText);
      if (looksLikeShortlist && !triedExactName) {
        triedExactName = true;
        state = await send(`Quiero el ${product.name}`);
        continue;
      }

      blockedReason = `sin señal de continuación natural tras turno ${step + 1}; respuesta: ${previewText(
        responseText
      )}`;
      break;
    }

    if (!added && !blockedReason) {
      blockedReason = 'se agotaron los turnos de resolución natural sin escribir el carrito';
    }

    expect(blockedReason, `E2-A bloqueado: ${blockedReason}`).toBeNull();
    expect(added, 'el producto debería terminar en el carrito vía texto puro').toBe(true);

    const items = await getActiveDraftItems(businessId);
    const line = items.find((i) => i.product_id === product.id);
    expect(line, 'línea de carrito para el producto pedido').toBeTruthy();
    expect(line!.product_id).toBe(product.id);
    expect(line!.quantity).toBeGreaterThanOrEqual(1);

    const metaFinal = await getFreshConversationMetadata(conversationId);
    expect(getPendingVariation(metaFinal)).toBeNull();
    expect(getPendingAddQuantity(metaFinal)).toBeNull();
  }, 360_000);

  // ── E2-B: reserva por texto desde cero ───────────────────────────────────

  it('E2-B: reserva por texto desde cero resuelve horario/ambiente por ReAct real (sin clicks)', async () => {
    const reset = await resetE2eCustomer();
    conversationId = reset.conversationId;
    const caseId = 'E2-B';

    const { patchConversationMetadata } = await import(
      '../src/repositories/conversationState.repository'
    );
    await patchConversationMetadata(conversationId, {
      humanIntentState: {
        version: 1,
        revision: 0,
        nextSequence: 1,
        processedMessageIds: [],
        records: [],
      },
    });

    const prereq = await ensureE2eReservationPrerequisites(businessId);
    const hasEnvironments = prereq.environmentNames.length > 0;
    await cancelRecentE2eReservations(businessId);

    const saturday = formatDMY(nextDateForWeekday('sábado', TZ));

    const send = async (text: string) => {
      const state = await runGraphTurn(graph, buildTextPayload(text));
      const turnNum = evidence.filter((e) => e.caseId === caseId).length + 1;
      const obs: TurnEvidence = {
        caseId,
        turn: turnNum,
        user: text,
        responsePreview: previewText(extractHandlerText(state.handlerResult)),
      };
      evidence.push(obs);
      console.log(JSON.stringify({ event: '[e2e-text-only] E2-B turn', ...obs }));
      return state;
    };

    let state = await send(
      `Quiero reservar una mesa para el sábado ${saturday} a la noche, somos 2 personas`
    );
    expect(hasHandlerResponse(state.handlerResult)).toBe(true);

    const { prisma } = await import('../src/lib/prisma');
    const { findOrCreateCustomer } = await import('../src/repositories/customer.repository');
    const { E2E_CUSTOMER_PHONE } = await import('./helpers/env');
    const customer = await findOrCreateCustomer(businessId, E2E_CUSTOMER_PHONE);

    const findConfirmedReservation = () =>
      prisma.reservation.findFirst({
        where: { business_id: businessId, customer_id: customer.id, status: 'confirmed' },
        orderBy: { created_at: 'desc' },
      });

    let confirmedReservation = await findConfirmedReservation();
    let blockedReason: string | null = null;

    for (let step = 0; step < 8 && !confirmedReservation; step++) {
      const meta = await getFreshConversationMetadata(conversationId);
      const draft = getReservationDraft(meta);
      const nextStep = nextReservationStep(
        {
          date: draft?.date,
          slotId: draft?.slotId,
          partySize: draft?.partySize,
          environmentId: draft?.environmentId,
        },
        { hasEnvironments }
      );

      let reply: string | null;
      switch (nextStep) {
        case 'party_size':
          reply = 'Somos 2 personas';
          break;
        case 'date':
          reply = `Para el sábado ${saturday}`;
          break;
        case 'slot':
          reply = 'A la noche';
          break;
        case 'environment':
          reply = 'Sin preferencia de ambiente';
          break;
        case 'confirm':
          reply = 'Sí, confirmo la reserva';
          break;
        default:
          reply = null;
      }

      if (!reply) {
        blockedReason = `nextReservationStep devolvió "${nextStep}" sin respuesta natural mapeada`;
        break;
      }

      state = await send(reply);
      confirmedReservation = await findConfirmedReservation();

      if (!confirmedReservation && nextStep === 'confirm') {
        // Dimos la confirmación en texto y no se persistió: evidencia del bloqueo exacto.
        blockedReason = `turno de confirmación en texto no creó la reserva; respuesta: ${previewText(
          extractHandlerText(state.handlerResult)
        )}`;
        break;
      }
    }

    if (!confirmedReservation && !blockedReason) {
      blockedReason = 'se agotaron los turnos de resolución natural sin confirmar la reserva';
    }

    expect(blockedReason, `E2-B bloqueado: ${blockedReason}`).toBeNull();
    expect(confirmedReservation, 'reserva confirmada en BD').toBeTruthy();
    expect(confirmedReservation!.party_size).toBe(2);

    const finalMeta = await getFreshConversationMetadata(conversationId);
    expect(finalMeta?.reservation_agent_active).not.toBe(true);
    expect(getReservationDraft(finalMeta)).toBeNull();
  }, 480_000);
});

describe('text-only completions (e2e etapa E2) — skip info', () => {
  it('documenta requisitos si e2e está deshabilitado', () => {
    if (isE2eEnabled()) return;
    expect(e2eSkipReason()).toBeTruthy();
  });
});

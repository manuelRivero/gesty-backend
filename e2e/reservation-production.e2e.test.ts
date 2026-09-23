/**
 * E2E diagnóstica — conversaciones de reservas de producción (manejo humano hoy).
 *
 * Caso fuente (Picado, 15/9): cumpleaños, 9–10 personas, sábado noche,
 * consulta seña/abono, menú para compartir (matambre/parrillada), sector carpa.
 *
 * Independiente del resto de e2e (`vitest.e2e.config` la excluye).
 * Correr: `npm run test:reservation-production`
 *
 * Portada desde food-service-agent a gesty-backend.
 *
 * Filosofía:
 * - Hard: el bot responde cada turno (no crash).
 * - Soft (`expect.soft`): progreso estructural hacia reserva (sesión, draft).
 * - Log JSON por turno + reporte final para decidir si hace falta fix y cuál.
 *
 * No valida copy literal del LLM.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  applyE2eEnv,
  e2eSkipReason,
  isE2eEnabled,
} from './helpers/env';
import {
  buildListReplyPayload,
  buildTextPayload,
  cancelRecentE2eReservations,
  disconnectPrisma,
  ensureE2eReservationPrerequisites,
  extractHandlerText,
  extractReservationPayloadIds,
  getFreshConversationMetadata,
  getReservationDraft,
  hasHandlerResponse,
  hasInteractiveFollowUp,
  hasListFollowUp,
  isReservationAgentActive,
  loadMainGraph,
  resetE2eCustomer,
  runGraphTurn,
  type E2eReservationDraft,
  type MainGraph,
} from './helpers/graphHarness';
import { formatDMY, nextDateForWeekday } from '../src/services/reservations/clock';
import { nextReservationStep } from '../src/services/reservations/nextReservationStep';
import { RESERVATION_FAQ_CONTINUE_OR_CANCEL } from '../src/graph/nodes/session/buildResumeFollowUp';

type TurnObservation = {
  caseId: string;
  turn: number;
  user: string;
  /** Texto completo del HandlerResult (evidencia). */
  responseText: string;
  /** Preview corto para consola. */
  responsePreview: string;
  reservationAgentActive: boolean;
  draft: E2eReservationDraft | null;
  nextStep: string | null;
  reservationPayloads: string[];
  hasListOrInteractive: boolean;
  currentIntent: string | null;
};

const observations: TurnObservation[] = [];

const previewText = (text: string, max = 280): string => {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max)}…`;
};

const draftStep = (
  draft: E2eReservationDraft | null,
  hasEnvironments: boolean
): string | null => {
  if (!draft) return null;
  return nextReservationStep(
    {
      date: draft.date,
      slotId: draft.slotId,
      partySize: draft.partySize,
      environmentId: draft.environmentId,
    },
    { hasEnvironments }
  );
};

describe.sequential.skipIf(!isE2eEnabled())(
  'reservation production conversations (diagnóstica)',
  () => {
    let graph: MainGraph;
    let businessId: string;
    let conversationId: string;
    let hasEnvironments = false;
    let environmentNames: string[] = [];

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

      const prereq = await ensureE2eReservationPrerequisites(businessId);
      environmentNames = prereq.environmentNames;
      hasEnvironments = environmentNames.length > 0;
      await cancelRecentE2eReservations(businessId);

      console.log(
        JSON.stringify({
          event: '[e2e-reservation-production] prerequisites',
          businessId,
          slotCount: prereq.slotCount,
          environmentNames,
          nextSaturday: formatDMY(nextDateForWeekday('sábado')),
        })
      );
    }, 90_000);

    afterAll(async () => {
      if (observations.length > 0) {
        const reportPath = resolve(
          process.cwd(),
          'e2e/.last-reservation-production-report.json'
        );
        const report = {
          generatedAt: new Date().toISOString(),
          businessId,
          environmentNames,
          nextSaturday: formatDMY(nextDateForWeekday('sábado')),
          turns: observations,
        };
        writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
        console.log(
          `\n========== REPORTE reservation-production ==========\n` +
            `Escrito en ${reportPath}\n` +
            JSON.stringify(observations, null, 2) +
            `\n====================================================\n`
        );
      }
      try {
        await cancelRecentE2eReservations(businessId);
      } catch {
        /* ignore cleanup errors */
      }
      await disconnectPrisma();
    });

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
      const draft = getReservationDraft(meta);
      const responseText = extractHandlerText(params.state.handlerResult);
      const obs: TurnObservation = {
        caseId: params.caseId,
        turn: params.turn,
        user: params.user,
        responseText,
        responsePreview: previewText(responseText),
        reservationAgentActive: isReservationAgentActive(meta),
        draft,
        nextStep: draftStep(draft, hasEnvironments),
        reservationPayloads: extractReservationPayloadIds(params.state.handlerResult),
        hasListOrInteractive:
          hasListFollowUp(params.state.handlerResult) ||
          hasInteractiveFollowUp(params.state.handlerResult) ||
          Boolean(params.state.handlerResult?.isInteractive),
        currentIntent:
          typeof params.state.workingConversationState?.current_intent === 'string'
            ? params.state.workingConversationState.current_intent
            : null,
      };
      observations.push(obs);
      console.log(JSON.stringify({ event: '[e2e-reservation-production] turn', ...obs }));
      return obs;
    };

    // ── 1. Replay multi-turno (Carla / cumpleaños) ─────────────────────────
    //
    // Turnos del cliente tal cual llegó al canal humano. Fecha relativa
    // ("sábado") para no hardcodear 19/09.

    it('carla-cumpleanos: replay multi-turno de producción', async () => {
      const reset = await resetE2eCustomer();
      conversationId = reset.conversationId;
      await cancelRecentE2eReservations(businessId);

      const turns: string[] = [
        'Me recomendó el lugar mi hermana Noelia que va siempre\n\nMi nombre es Carla Rivero',
        'Quería festejar el cumpleaños de mi hijo ahí\nSeremos entre 9 y 10 entre grandes y chicos , por ahora ..\n\nTengo que reservar el lugar para el sabado , o abonar algo antes ?',
        'Y te consulto algo que me preguntan , si el matambre a la pizza comerán 3 .. o la parrillada\n\nO es por plato el precio',
        'Sábado a la noche',
        'En el sector de carpa cerca de los juegos',
        'Muchas gracias',
      ];

      const caseId = 'carla-cumpleanos';
      let lastObs: TurnObservation | null = null;

      for (let i = 0; i < turns.length; i++) {
        const user = turns[i];
        const state = await runGraphTurn(graph, buildTextPayload(user));
        expect(hasHandlerResponse(state.handlerResult)).toBe(true);
        lastObs = await observeTurn({ caseId, turn: i + 1, user, state });
      }

      // Soft: tras el pedido de reserva (turno 2+) debería abrirse sesión
      // o al menos avanzar draft en algún momento del hilo.
      const anySession = observations
        .filter((o) => o.caseId === caseId)
        .some((o) => o.reservationAgentActive);
      const anyDate = observations
        .filter((o) => o.caseId === caseId)
        .some((o) => Boolean(o.draft?.date));
      const anyParty = observations
        .filter((o) => o.caseId === caseId)
        .some((o) => typeof o.draft?.partySize === 'number');

      expect.soft(anySession, 'sesión de reserva activa en algún turno').toBe(true);
      expect.soft(anyDate, 'draft.date resuelto (sábado)').toBe(true);
      expect.soft(anyParty, 'draft.partySize (9–10)').toBe(true);

      // Soft: menú mid-flow no debería tirar abajo la sesión si ya estaba activa
      const afterMenu = observations.find((o) => o.caseId === caseId && o.turn === 3);
      const beforeMenu = observations.find((o) => o.caseId === caseId && o.turn === 2);
      if (beforeMenu?.reservationAgentActive) {
        expect
          .soft(afterMenu?.reservationAgentActive, 'menú mid-flow conserva sesión')
          .toBe(true);
      }

      expect(lastObs).not.toBeNull();
    }, 900_000);

    // ── 2. Intención reserva + seña/abono (turno aislado) ───────────────────

    it('reserva-o-abonar: abre flujo de reserva ante consulta de seña', async () => {
      const reset = await resetE2eCustomer();
      conversationId = reset.conversationId;

      const user =
        'Tengo que reservar el lugar para el sábado, o abonar algo antes? Seremos 10 personas';
      const state = await runGraphTurn(graph, buildTextPayload(user));
      expect(hasHandlerResponse(state.handlerResult)).toBe(true);
      const obs = await observeTurn({
        caseId: 'reserva-o-abonar',
        turn: 1,
        user,
        state,
      });

      expect
        .soft(obs.reservationAgentActive, 'debería delegar a reservation agent')
        .toBe(true);
    }, 240_000);

    // ── 3. Rango de party size en prosa ─────────────────────────────────────

    it('rango-party-size: "entre 9 y 10" deja partySize usable o pide aclarar', async () => {
      const reset = await resetE2eCustomer();
      conversationId = reset.conversationId;

      const saturday = formatDMY(nextDateForWeekday('sábado'));

      // Arranque explícito de reserva
      const t1 = await runGraphTurn(
        graph,
        buildTextPayload(`Quiero reservar mesa para el sábado ${saturday}`)
      );
      expect(hasHandlerResponse(t1.handlerResult)).toBe(true);
      await observeTurn({
        caseId: 'rango-party-size',
        turn: 1,
        user: `Quiero reservar mesa para el sábado ${saturday}`,
        state: t1,
      });

      // Si ofreció lista de slots, elegir el primero (list_reply) para llegar a party_size.
      let turnIdx = 1;
      let payloads = extractReservationPayloadIds(t1.handlerResult);
      let slotPayload = payloads.find((id) => id.startsWith('RESERVATION_SLOT:'));
      if (!slotPayload) {
        const night = await runGraphTurn(graph, buildTextPayload('a la noche'));
        expect(hasHandlerResponse(night.handlerResult)).toBe(true);
        turnIdx += 1;
        await observeTurn({
          caseId: 'rango-party-size',
          turn: turnIdx,
          user: 'a la noche',
          state: night,
        });
        payloads = extractReservationPayloadIds(night.handlerResult);
        slotPayload = payloads.find((id) => id.startsWith('RESERVATION_SLOT:'));
      }

      if (slotPayload) {
        const slotTurn = await runGraphTurn(graph, buildListReplyPayload(slotPayload));
        expect(hasHandlerResponse(slotTurn.handlerResult)).toBe(true);
        turnIdx += 1;
        await observeTurn({
          caseId: 'rango-party-size',
          turn: turnIdx,
          user: `[list] ${slotPayload}`,
          state: slotTurn,
        });
      }

      const rangeUser = 'Seremos entre 9 y 10 entre grandes y chicos';
      const rangeTurn = await runGraphTurn(graph, buildTextPayload(rangeUser));
      expect(hasHandlerResponse(rangeTurn.handlerResult)).toBe(true);
      turnIdx += 1;
      const obs = await observeTurn({
        caseId: 'rango-party-size',
        turn: turnIdx,
        user: rangeUser,
        state: rangeTurn,
      });

      const party = obs.draft?.partySize;
      const partyOk =
        party === 9 || party === 10 || (typeof party === 'number' && party >= 9 && party <= 10);
      // Soft: o persistió 9/10, o sigue en party_size pidiendo aclaración (también válido).
      expect
        .soft(
          partyOk || obs.nextStep === 'party_size' || obs.reservationAgentActive,
          'party size 9|10 o sigue pidiendo aclaración en sesión'
        )
        .toBe(true);
    }, 480_000);

    // ── 4. Menú para compartir durante reserva ──────────────────────────────

    it('menu-durante-reserva: consulta de raciones no tumba el draft', async () => {
      const reset = await resetE2eCustomer();
      conversationId = reset.conversationId;

      const saturday = formatDMY(nextDateForWeekday('sábado'));
      const start = await runGraphTurn(
        graph,
        buildTextPayload(`Quiero reservar para ${saturday} a la noche, somos 10`)
      );
      expect(hasHandlerResponse(start.handlerResult)).toBe(true);
      const before = await observeTurn({
        caseId: 'menu-durante-reserva',
        turn: 1,
        user: `Quiero reservar para ${saturday} a la noche, somos 10`,
        state: start,
      });

      const menuUser =
        'si el matambre a la pizza comerán 3 .. o la parrillada. O es por plato el precio?';
      const menuTurn = await runGraphTurn(graph, buildTextPayload(menuUser));
      expect(hasHandlerResponse(menuTurn.handlerResult)).toBe(true);
      const after = await observeTurn({
        caseId: 'menu-durante-reserva',
        turn: 2,
        user: menuUser,
        state: menuTurn,
      });

      if (before.reservationAgentActive || before.draft) {
        expect
          .soft(
            after.reservationAgentActive || Boolean(after.draft?.date) || Boolean(after.draft?.partySize),
            'consulta de menú no debería borrar progreso de reserva'
          )
          .toBe(true);
      }

      // A3: no simular handback/delegate en prosa sin tool.
      const preview = after.responsePreview.toLowerCase();
      const fakeHandoff =
        /te dejo con el asistente|te paso (con|al) (el )?asistente|mientras tanto.{0,40}asistente principal|voy a pasar tu consulta/.test(
          preview
        );
      expect.soft(fakeHandoff, 'no inventar handoff en prosa sin tool').toBe(false);

      // A1 blando: algo de menú/precio/ración, o al menos no solo re-preguntar horario.
      const looksLikeMenuAnswer =
        /precio|plato|compart|raci[oó]n|porcion|matambre|parrill|\$|pesos/i.test(preview);
      const onlySlotReprompt =
        /a qu[eé] hora|horarios disponibles|eleg[ií].*horario/i.test(preview) &&
        !looksLikeMenuAnswer;
      expect
        .soft(onlySlotReprompt, 'no debería ignorar menú y solo re-pedir horario')
        .toBe(false);

      // FAQ-HIBRIDO A2: no pivot a armar/ofrecer pedido ni CTA de add.
      const pivotsToOrder =
        /armar (el )?pedido|sumar .{0,40}(al |el )?pedido|sumar al carrito|sesión de reserva activa|ADD_ITEM:|para \d+ personas.{0,40}(pedir|pedido|carrito)|cu[aá]ntas personas (van a )?comer/i.test(
          after.responseText
        );
      expect
        .soft(pivotsToOrder, 'sin copy de armar/ofrecer pedido ni CTA ADD_ITEM')
        .toBe(false);

      // FAQ-HIBRIDO A4: resume seguir reserva o cancelar (si hubo sesión).
      if (before.reservationAgentActive || after.reservationAgentActive) {
        const full = after.responseText.toLowerCase();
        const hasResume =
          /seguimos con tu reserva|prefer[ií]s cancelarla|\¿seguimos con la reserva/i.test(
            full
          );
        expect
          .soft(hasResume, 'debería anexar resume seguir/cancelar reserva')
          .toBe(true);
      }
    }, 360_000);

    // ── 4b. Banda horaria → slot (caso producción Picado) ─────────────────

    it('noche-a-slot: "a la noche" persiste slotId nocturno', async () => {
      const reset = await resetE2eCustomer();
      conversationId = reset.conversationId;

      const saturday = formatDMY(nextDateForWeekday('sábado'));
      const start = await runGraphTurn(
        graph,
        buildTextPayload(`Quiero reservar mesa para el sábado ${saturday}`)
      );
      expect(hasHandlerResponse(start.handlerResult)).toBe(true);
      await observeTurn({
        caseId: 'noche-a-slot',
        turn: 1,
        user: `Quiero reservar mesa para el sábado ${saturday}`,
        state: start,
      });

      const nightTurn = await runGraphTurn(graph, buildTextPayload('Sábado a la noche'));
      expect(hasHandlerResponse(nightTurn.handlerResult)).toBe(true);
      const obs = await observeTurn({
        caseId: 'noche-a-slot',
        turn: 2,
        user: 'Sábado a la noche',
        state: nightTurn,
      });

      expect.soft(Boolean(obs.draft?.slotId), 'debería persistir slotId').toBe(true);

      const time = obs.draft?.time;
      if (typeof time === 'string' && /^\d{1,2}:\d{2}$/.test(time)) {
        const [hh, mm] = time.split(':').map(Number);
        const minutes = hh * 60 + mm;
        expect
          .soft(minutes >= 19 * 60, `hora nocturna esperada (≥19:00), got ${time}`)
          .toBe(true);
      }
    }, 360_000);

    // ── 4c. FAQ de platos: un solo cierre ──────────────────────────────────
    //
    // Evidencia 22/9 (Sabrosón): mesa de 6 + "Y pollo?" devolvió la lista y
    // después DOS cierres — el del modelo ("¿Te gustaría seguir con la reserva
    // o hay algo más que necesites?") y el fijo del nodo — más la frase de
    // unidades del mundo pedido ("para 6 podés llevar más de una unidad"),
    // que no aplica porque la reserva guarda la mesa, no platos.

    it('faq-platos-cierre-unico: lista + solo la pregunta fija seguir/cancelar', async () => {
      const reset = await resetE2eCustomer();
      conversationId = reset.conversationId;
      await cancelRecentE2eReservations(businessId);

      // Sesión sembrada (como los casos de ambiente): el caso a cubrir es el
      // cierre de la respuesta de menú, no el routing que abre la reserva.
      const { patchConversationMetadata } = await import(
        '../src/repositories/conversationState.repository'
      );
      await patchConversationMetadata(conversationId, {
        reservation_agent_active: true,
        reservation_draft: { partySize: 6 },
      });

      const user = 'Y tienen pollo?';
      const state = await runGraphTurn(graph, buildTextPayload(user));
      expect(hasHandlerResponse(state.handlerResult)).toBe(true);
      const dishTurn = await observeTurn({
        caseId: 'faq-platos-cierre-unico',
        turn: 1,
        user,
        state,
      });

      expect
        .soft(
          /ración para:/i.test(dishTurn.responseText),
          'debería listar platos con "ración para:"'
        )
        .toBe(true);

      const text = dishTurn.responseText;

      expect
        .soft(
          text.includes(RESERVATION_FAQ_CONTINUE_OR_CANCEL),
          'debería cerrar con la pregunta fija seguir/cancelar'
        )
        .toBe(true);

      // Un solo cierre: la única pregunta del mensaje es la anexada.
      const questionMarks = (text.match(/\?/g) ?? []).length;
      expect
        .soft(questionMarks <= 1, `una sola pregunta en el mensaje, got ${questionMarks}`)
        .toBe(true);

      const modelClosing =
        /te gustar[ií]a seguir|seguir con la reserva o hay algo|algo m[aá]s que necesit|necesit[aá]s algo m[aá]s|quer[eé]s que busque otra|si necesit[aá]s m[aá]s (info|informaci[oó]n)|avisame|decime si|consultame/i.test(
          text
        );
      expect
        .soft(modelClosing, 'el modelo no debería agregar su propio cierre')
        .toBe(false);

      // Frase de unidades (copy de pedido) fuera de la respuesta de reserva.
      const unitsPhrase =
        /m[aá]s de una unidad|varias unidades|sumar (m[aá]s )?unidades|m[aá]s unidades/i.test(
          text
        );
      expect
        .soft(unitsPhrase, 'sin frase de unidades del mundo pedido')
        .toBe(false);
    }, 480_000);

    // ── 5. Ambiente en prosa (si el negocio tiene environments) ─────────────

    it('ambiente-prosa: elige sector en texto libre cuando hay catálogo', async () => {
      if (!hasEnvironments) {
        console.log(
          JSON.stringify({
            event: '[e2e-reservation-production] skip ambiente-prosa',
            reason: 'negocio sin environments activos',
          })
        );
        return;
      }

      const reset = await resetE2eCustomer();
      conversationId = reset.conversationId;

      const { patchConversationMetadata } = await import(
        '../src/repositories/conversationState.repository'
      );
      const { prisma } = await import('../src/lib/prisma');

      const saturday = nextDateForWeekday('sábado');
      const slots = await prisma.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM reservation_slot
        WHERE business_id = ${businessId}::uuid
          AND day_of_week IN (${saturday.getDay()}, ${saturday.getDay() === 0 ? 7 : saturday.getDay()})
          AND (is_active = true OR is_active IS NULL)
        ORDER BY start_time ASC
        LIMIT 1
      `;
      const slotId = slots[0]?.id;
      expect(slotId, 'hace falta al menos un slot del sábado').toBeTruthy();

      await patchConversationMetadata(conversationId, {
        reservation_agent_active: true,
        reservation_draft: {
          date: formatDMY(saturday),
          slotId,
          time: '20:00',
          endTime: '22:00',
          partySize: 10,
        },
      });

      // Preferir un nombre real del catálogo; si hay “carpa”/“juego”, usarlo.
      const preferred =
        environmentNames.find((n) => /carpa|juego|salon|salón|terraza/i.test(n)) ??
        environmentNames[0];
      const user = preferred
        ? `En el sector ${preferred}`
        : 'En el sector de carpa cerca de los juegos';

      const state = await runGraphTurn(graph, buildTextPayload(user));
      expect(hasHandlerResponse(state.handlerResult)).toBe(true);
      const obs = await observeTurn({
        caseId: 'ambiente-prosa',
        turn: 1,
        user,
        state,
      });

      expect
        .soft(
          obs.draft?.environmentId !== undefined,
          'debería persistir environmentId (o null=sin preferencia)'
        )
        .toBe(true);
    }, 240_000);

    it('ambiente-desconocido: carpa no inventa environmentId y aclara', async () => {
      if (!hasEnvironments) {
        console.log(
          JSON.stringify({
            event: '[e2e-reservation-production] skip ambiente-desconocido',
            reason: 'negocio sin environments activos',
          })
        );
        return;
      }
      // Solo tiene sentido si el catálogo e2e NO incluye "carpa".
      if (environmentNames.some((n) => /carpa/i.test(n))) {
        console.log(
          JSON.stringify({
            event: '[e2e-reservation-production] skip ambiente-desconocido',
            reason: 'catálogo ya tiene carpa',
            environmentNames,
          })
        );
        return;
      }

      const reset = await resetE2eCustomer();
      conversationId = reset.conversationId;

      const { patchConversationMetadata } = await import(
        '../src/repositories/conversationState.repository'
      );
      const { prisma } = await import('../src/lib/prisma');

      const saturday = nextDateForWeekday('sábado');
      const slots = await prisma.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM reservation_slot
        WHERE business_id = ${businessId}::uuid
          AND day_of_week IN (${saturday.getDay()}, ${saturday.getDay() === 0 ? 7 : saturday.getDay()})
          AND (is_active = true OR is_active IS NULL)
        ORDER BY start_time ASC
        LIMIT 1
      `;
      const slotId = slots[0]?.id;
      expect(slotId, 'hace falta al menos un slot del sábado').toBeTruthy();

      await patchConversationMetadata(conversationId, {
        reservation_agent_active: true,
        reservation_draft: {
          date: formatDMY(saturday),
          slotId,
          time: '20:00',
          endTime: '22:00',
          partySize: 10,
        },
      });

      const user = 'En el sector de carpa cerca de los juegos';
      const state = await runGraphTurn(graph, buildTextPayload(user));
      expect(hasHandlerResponse(state.handlerResult)).toBe(true);
      const obs = await observeTurn({
        caseId: 'ambiente-desconocido',
        turn: 1,
        user,
        state,
      });

      expect
        .soft(
          obs.draft?.environmentId === undefined,
          'no debería inventar environmentId para carpa'
        )
        .toBe(true);

      const preview = obs.responsePreview.toLowerCase();
      const onlySlotReprompt =
        /a qu[eé] hora|horarios disponibles|eleg[ií].*horario/i.test(preview) &&
        !/ambiente|sector|sal[oó]n|patio|preferencia|no (tenemos|contamos|est[aá])/i.test(
          preview
        );
      expect
        .soft(onlySlotReprompt, 'no debería cambiar de tema a horarios')
        .toBe(false);

      const clarifiesOrOffers =
        obs.reservationPayloads.some((id) => id.startsWith('RESERVATION_ENV')) ||
        /ambiente|sector|sal[oó]n|patio|preferencia|no (tenemos|contamos|est[aá]|dispon)/i.test(
          preview
        );
      expect
        .soft(clarifiesOrOffers, 'debería aclarar o re-ofrecer ambientes')
        .toBe(true);
    }, 240_000);
  }
);

describe('reservation production e2e (guard)', () => {
  it('documenta skip si faltan vars', () => {
    if (!isE2eEnabled()) {
      const reason = e2eSkipReason();
      console.log(`[e2e skip] reservation-production: ${reason}`);
      expect(reason).toBeTruthy();
    } else {
      expect(true).toBe(true);
    }
  });
});

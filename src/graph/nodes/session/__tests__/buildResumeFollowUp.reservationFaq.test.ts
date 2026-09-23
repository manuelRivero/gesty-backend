import { describe, expect, it } from 'vitest';
import {
  appendResumeFollowUp,
  buildResumeFollowUp,
  RESERVATION_FAQ_CONTINUE_OR_CANCEL,
} from '../buildResumeFollowUp';

describe('buildResumeFollowUp (kind: reservation + FAQ)', () => {
  it('sin FAQ: solo pregunta del paso pendiente', () => {
    const resume = buildResumeFollowUp({
      kind: 'reservation',
      draft: { date: '20/09/2026', partySize: 4 },
      hasEnvironments: false,
    });
    expect(resume.text).toMatch(/Seguimos con tu reserva:/i);
    expect(resume.text).toMatch(/horario/i);
    expect(resume.text).not.toContain(RESERVATION_FAQ_CONTINUE_OR_CANCEL);
  });

  it('con FAQ: solo seguir o cancelar (sin fecha/horario)', () => {
    const resume = buildResumeFollowUp({
      kind: 'reservation',
      draft: { date: '20/09/2026', partySize: 10 },
      hasEnvironments: false,
      includeContinueOrCancel: true,
    });
    expect(resume.text).toBe(RESERVATION_FAQ_CONTINUE_OR_CANCEL);
    expect(resume.text).not.toMatch(/para qué día/i);
    expect(resume.text).not.toMatch(/horario/i);
    expect(resume.text).not.toMatch(/Seguimos con tu reserva/i);
  });

  it('con FAQ y draft listo para confirm: solo invitación seguir/cancelar', () => {
    const resume = buildResumeFollowUp({
      kind: 'reservation',
      draft: {
        date: '20/09/2026',
        slotId: 's1',
        time: '20:00',
        endTime: '21:00',
        partySize: 4,
      },
      hasEnvironments: false,
      includeContinueOrCancel: true,
    });
    expect(resume.text).toBe(RESERVATION_FAQ_CONTINUE_OR_CANCEL);
  });
});

describe('appendResumeFollowUp', () => {
  it('anexa cuando el texto del agente no cierra', () => {
    const out = appendResumeFollowUp(
      'Tenemos ceviche clásico.',
      RESERVATION_FAQ_CONTINUE_OR_CANCEL
    );
    expect(out).toBe(`Tenemos ceviche clásico.\n\n${RESERVATION_FAQ_CONTINUE_OR_CANCEL}`);
  });

  it('no duplica si el modelo ya copió la pregunta de cierre', () => {
    const content = `Tenemos ceviche clásico.\n\n${RESERVATION_FAQ_CONTINUE_OR_CANCEL}`;
    expect(appendResumeFollowUp(content, RESERVATION_FAQ_CONTINUE_OR_CANCEL)).toBe(content);
  });

  it('ignora diferencias de espacios y mayúsculas al detectar el duplicado', () => {
    const content = '• *Pollo a la brasa*\n\n¿SEGUIMOS  con la reserva o preferís cancelarla?';
    expect(appendResumeFollowUp(content, RESERVATION_FAQ_CONTINUE_OR_CANCEL)).toBe(content);
  });
});

import { describe, expect, it } from 'vitest';
import {
  buildResumeFollowUp,
  RESERVATION_FAQ_CONTINUE_OR_CANCEL,
} from '../buildResumeFollowUp';

describe('buildResumeFollowUp (kind: reservation + FAQ)', () => {
  it('sin FAQ: solo pregunta del paso pendiente', () => {
    const resume = buildResumeFollowUp({
      kind: 'reservation',
      draft: { date: '20/09/2026' },
      hasEnvironments: false,
    });
    expect(resume.text).toMatch(/Seguimos con tu reserva:/i);
    expect(resume.text).toMatch(/horario/i);
    expect(resume.text).not.toContain(RESERVATION_FAQ_CONTINUE_OR_CANCEL);
  });

  it('con FAQ: pregunta + seguir o cancelar', () => {
    const resume = buildResumeFollowUp({
      kind: 'reservation',
      draft: { date: '20/09/2026', partySize: 10 },
      hasEnvironments: false,
      includeContinueOrCancel: true,
    });
    expect(resume.text).toMatch(/Seguimos con tu reserva:/i);
    expect(resume.text).toContain(RESERVATION_FAQ_CONTINUE_OR_CANCEL);
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

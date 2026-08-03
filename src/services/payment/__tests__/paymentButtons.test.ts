import { describe, expect, it } from 'vitest';
import { buildPaymentButtonsMessage } from '../paymentButtons';
import type { OfferedPaymentMethod } from '../../paymentMethods.service';

const method = (
  overrides: Partial<OfferedPaymentMethod> & Pick<OfferedPaymentMethod, 'id'>
): OfferedPaymentMethod => ({
  label: overrides.id,
  buttonId: `PAY_${overrides.id.toUpperCase()}`,
  buttonTitle: overrides.id,
  emoji: '💳',
  collectionKind: 'online_provider',
  instructions: null,
  sortOrder: 0,
  ...overrides,
});

describe('buildPaymentButtonsMessage', () => {
  it('genera un botón por método ofrecido', () => {
    const msg = buildPaymentButtonsMessage('¿Cómo pagás?', [
      method({ id: 'online', emoji: '💳', buttonTitle: 'Pago online' }),
      method({
        id: 'transfer',
        emoji: '🏦',
        buttonTitle: 'Transferencia',
        collectionKind: 'bank_transfer',
      }),
    ]);

    const buttons = (msg as any).interactive.action.buttons;
    expect(buttons).toHaveLength(2);
    expect(buttons[0].reply.id).toBe('PAY_ONLINE');
    expect(buttons[1].reply.id).toBe('PAY_TRANSFER');
  });

  it('no incluye cash si no está en la lista ofrecida', () => {
    const msg = buildPaymentButtonsMessage('pago', [
      method({ id: 'online' }),
    ]);
    const ids = (msg as any).interactive.action.buttons.map(
      (b: { reply: { id: string } }) => b.reply.id
    );
    expect(ids).toEqual(['PAY_ONLINE']);
    expect(ids).not.toContain('PAY_CASH');
  });
});

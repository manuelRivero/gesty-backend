import { describe, expect, it } from 'vitest';
import { extractCheckoutAgentSignals } from '../checkoutAgent';

const tool = (name: string, content: unknown) => ({
  tool_call_id: 'c1',
  name,
  content: JSON.stringify(content),
});

describe('señales de salida del checkout', () => {
  it('B4: handback con reason de cancelar no prende cancel_order', () => {
    const signals = extractCheckoutAgentSignals([
      tool('handback_to_main', {
        signal: 'handback_to_main',
        reason: 'el cliente quiere cancelar el pedido',
      }),
    ]);
    expect(signals.handback).toBe(true);
    expect(signals.cancelOrder).toBe(false);
  });

  it('B5: cancel_order es la señal de wipe', () => {
    const signals = extractCheckoutAgentSignals([
      tool('cancel_order', { signal: 'cancel_order' }),
    ]);
    expect(signals.cancelOrder).toBe(true);
    expect(signals.handback).toBe(false);
  });

  it('B6: handback de edición no es cancelación', () => {
    const signals = extractCheckoutAgentSignals([
      tool('handback_to_main', {
        signal: 'handback_to_main',
        reason: 'el cliente quiere quitar un ítem',
      }),
    ]);
    expect(signals.handback).toBe(true);
    expect(signals.handbackReason).toBe('el cliente quiere quitar un ítem');
    expect(signals.cancelOrder).toBe(false);
  });
});

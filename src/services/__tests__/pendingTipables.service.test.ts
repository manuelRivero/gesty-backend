import { describe, expect, it } from 'vitest';
import {
  COMPLEMENT_MANAGEMENT_TIPABLES,
  buildPendingTipablesPatch,
} from '../pendingTipables.service';
import { buildPendingTipablesManagementLines } from '../../agents/contextMessage';

describe('pendingTipables', () => {
  it('buildPendingTipablesPatch dedupea management', () => {
    const patch = buildPendingTipablesPatch([
      'VIEW_MENU',
      'VIEW_CART',
      'VIEW_MENU',
      'ITEM_NOTE',
    ]);
    expect(patch.pendingTipables?.management).toEqual([
      'VIEW_MENU',
      'VIEW_CART',
      'ITEM_NOTE',
    ]);
    expect(patch.pendingTipables?.offeredAt).toMatch(/^\d{4}-/);
  });

  it('COMPLEMENT_MANAGEMENT_TIPABLES cubre gestión post-add', () => {
    expect(COMPLEMENT_MANAGEMENT_TIPABLES).toEqual(
      expect.arrayContaining([
        'VIEW_MENU',
        'VIEW_CART',
        'VIEW_CART_FOR_EDITION',
        'CHECKOUT',
        'ITEM_NOTE',
      ])
    );
  });

  it('buildPendingTipablesManagementLines inyecta tools esperadas', () => {
    const lines = buildPendingTipablesManagementLines({
      pendingTipables: {
        offeredAt: new Date().toISOString(),
        management: ['VIEW_CART', 'ITEM_NOTE'],
      },
    });
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('\n')).toMatch(/VIEW_CART.*present_cart/i);
    expect(lines.join('\n')).toMatch(/ITEM_NOTE.*start_item_note|ITEM_NOTE.*update_item_note/i);
    expect(lines.join('\n')).toMatch(/la papa con poca sal|start_item_note/i);
  });

  it('sin tipables: no emite líneas', () => {
    expect(buildPendingTipablesManagementLines({})).toEqual([]);
    expect(
      buildPendingTipablesManagementLines({ pendingTipables: null })
    ).toEqual([]);
  });
});

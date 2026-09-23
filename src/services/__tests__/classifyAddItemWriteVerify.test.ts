import { describe, expect, it } from 'vitest';
import { classifyAddItemWriteVerify } from '../cart.service';

describe('classifyAddItemWriteVerify', () => {
  it('ok: la línea está en el mismo draft que se escribió', () => {
    expect(
      classifyAddItemWriteVerify({
        writtenDraftId: 'draft-1',
        readDraft: { id: 'draft-1', draft_order_item: [{ id: 'line-1' }] },
      })
    ).toEqual({ status: 'ok', readDraftId: 'draft-1' });
  });

  it('missing: no hay draft activo o la línea no aparece', () => {
    expect(
      classifyAddItemWriteVerify({ writtenDraftId: 'draft-1', readDraft: null })
    ).toEqual({ status: 'missing', readDraftId: null });
    expect(
      classifyAddItemWriteVerify({
        writtenDraftId: 'draft-1',
        readDraft: { id: 'draft-1', draft_order_item: [] },
      })
    ).toEqual({ status: 'missing', readDraftId: 'draft-1' });
  });

  it('ambiguous: se escribió en un draft y findFirst resuelve otro', () => {
    expect(
      classifyAddItemWriteVerify({
        writtenDraftId: 'draft-1',
        readDraft: { id: 'draft-2', draft_order_item: [{ id: 'line-1' }] },
      })
    ).toEqual({ status: 'ambiguous', readDraftId: 'draft-2' });
  });
});

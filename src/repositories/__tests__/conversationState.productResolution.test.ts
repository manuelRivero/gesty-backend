import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fakeDb } = vi.hoisted(() => {
  const consumed = {
    resolutionId: 'pr1:biz-1:conv-1:resolution-1',
    productId: 'product-1',
    businessId: 'biz-1',
    conversationId: 'conv-1',
    source: 'search_products',
    status: 'consumed',
    scope: 'conversation',
    createdAt: '2026-09-29T00:00:00.000Z',
    expiresAt: '2026-09-29T00:30:00.000Z',
    consumedAt: '2026-09-29T00:01:00.000Z',
  };
  const state = {
    metadata: { productResolutions: [consumed], keepMe: true } as Record<string, unknown>,
  };
  const tx = {
    conversation_state: {
      findUnique: vi.fn(async () => ({ metadata: state.metadata })),
      update: vi.fn(async ({ data }: { data: { metadata: Record<string, unknown> } }) => {
        state.metadata = data.metadata;
        return { metadata: state.metadata };
      }),
    },
    $queryRaw: vi.fn(),
  };
  const prisma = {
    ...tx,
    conversation_state: tx.conversation_state,
    $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
  };
  return { fakeDb: { consumed, state, tx, prisma } };
});

vi.mock('../../lib/prisma', () => ({ prisma: fakeDb.prisma }));

import {
  omitConversationMetadataKeys,
  patchConversationMetadata,
  updateConversationState,
} from '../conversationState.repository';

describe('conversation metadata ProductResolution tombstones', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fakeDb.state.metadata = {
      productResolutions: [fakeDb.consumed],
      keepMe: true,
    };
  });

  it('no restaura un receipt consumido desde un snapshot viejo', async () => {
    await updateConversationState('conv-1', {
      metadata: {
        productResolutions: [{ ...fakeDb.consumed, status: 'selected', consumedAt: undefined }],
        staleValue: true,
      } as never,
    });

    expect(fakeDb.state.metadata.productResolutions).toEqual([fakeDb.consumed]);
    expect(fakeDb.state.metadata.staleValue).toBe(true);
  });

  it('preserva tombstones al fusionar u omitir metadata', async () => {
    await patchConversationMetadata('conv-1', { latest: true });
    await omitConversationMetadataKeys('conv-1', ['productResolutions', 'keepMe']);

    expect(fakeDb.state.metadata).toEqual({
      latest: true,
      productResolutions: [fakeDb.consumed],
    });
  });
});
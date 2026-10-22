/**
 * Contrato real (sin mockear productResolution.service ni lastOffer.service):
 * una ProductResolution emitida por `persistLastOffer` (source: 'last_offer')
 * solo autoriza `add_cart_item` mientras el Ledger CONFIRMAR_OFERTA siga
 * apuntando a ese mismo producto. `clearLastOffer` (rechazo) o una nueva
 * `persistLastOffer` (reemplazo) la invalidan sin que nadie tenga que
 * "revocar" la resolución explícitamente — ver `productResolution.service.ts`
 * (`confirmOfferLedgerProductId` / `validateResolution`).
 *
 * Usa los servicios reales (`lastOffer.service.ts` + `productResolution.service.ts`)
 * contra un `conversation_state.metadata` en memoria compartido — no un mock
 * de alto nivel de ninguno de los dos — para probar el contrato end-to-end,
 * no solo que el helper lee el campo correcto.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fakeDb } = vi.hoisted(() => {
  const state = { metadata: {} as Record<string, unknown> };
  const conversationState = {
    upsert: vi.fn(),
    findUnique: vi.fn(async () => ({ metadata: state.metadata })),
  };
  const tx = {
    menu_item: {
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.map((id) => ({ id }))
      ),
    },
    conversation_state: conversationState,
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn(async (_strings: TemplateStringsArray, ...values: unknown[]) => {
      state.metadata.productResolutions = JSON.parse(String(values[0])) as unknown;
      return 1;
    }),
  };
  const prisma = {
    ...tx,
    $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    conversation_state: conversationState,
  };
  return { fakeDb: { state, tx, prisma } };
});

vi.mock('../../lib/prisma', () => ({ prisma: fakeDb.prisma }));

// `patchIntentLedgerEntry` (usado por persistLastOffer/clearLastOffer) escribe
// vía `patchConversationMetadata` — lo apuntamos al mismo `state.metadata`
// con el mismo merge superficial que documenta el repositorio real.
vi.mock('../../repositories', () => ({
  patchConversationMetadata: vi.fn(async (_conversationId: string, patch: Record<string, unknown>) => {
    fakeDb.state.metadata = { ...fakeDb.state.metadata, ...patch };
  }),
  omitConversationMetadataKeys: vi.fn(async (_conversationId: string, keys: string[]) => {
    for (const key of keys) delete fakeDb.state.metadata[key];
  }),
  setLastReferencedProductId: vi.fn().mockResolvedValue(undefined),
}));

import { clearLastOffer, persistLastOffer } from '../lastOffer.service';
import { consumeProductResolution } from '../productResolution.service';

const BUSINESS_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CONVERSATION_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const PRODUCT_X_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const PRODUCT_Y_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

const offer = (productId: string, productName: string) =>
  persistLastOffer({
    conversationId: CONVERSATION_ID,
    businessId: BUSINESS_ID,
    productId,
    productName,
    source: 'hybrid_cta',
  });

const addAttempt = (productId: string) =>
  consumeProductResolution(fakeDb.tx as never, {
    productId,
    businessId: BUSINESS_ID,
    conversationId: CONVERSATION_ID,
  });

describe('contrato real: persistLastOffer + clearLastOffer + consumeProductResolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fakeDb.state.metadata = {};
  });

  it('no-regresión: oferta vigente (sin rechazo) sigue autorizando el add', async () => {
    await offer(PRODUCT_X_ID, 'Ceviche Clásico');
    await expect(addAttempt(PRODUCT_X_ID)).resolves.toMatchObject({
      ok: true,
      resolution: { status: 'consumed' },
    });
  });

  it('rechazo real vía clearLastOffer impide el add posterior, sin importar qué tool lo haya llamado', async () => {
    await offer(PRODUCT_X_ID, 'Ceviche Clásico');
    await clearLastOffer(CONVERSATION_ID);
    await expect(addAttempt(PRODUCT_X_ID)).resolves.toMatchObject({
      ok: false,
      reason: 'resolution_offer_invalidated',
    });
  });

  it('una pregunta informativa entre medio (que nunca toca el Ledger) no abre ni cierra la autorización por sí sola', async () => {
    await offer(PRODUCT_X_ID, 'Ceviche Clásico');
    // Una consulta de precio/ingredientes no llama clear_last_offer ni
    // persistLastOffer — el Ledger queda intacto, la oferta sigue viva.
    await expect(addAttempt(PRODUCT_X_ID)).resolves.toMatchObject({ ok: true });
  });

  it('reemplazo por una oferta nueva (persistLastOffer(Y)) invalida la autorización de la oferta vieja y habilita la nueva', async () => {
    await offer(PRODUCT_X_ID, 'Ceviche Clásico');
    await offer(PRODUCT_Y_ID, 'Lomo Saltado');

    await expect(addAttempt(PRODUCT_X_ID)).resolves.toMatchObject({
      ok: false,
      reason: 'resolution_offer_invalidated',
    });
    await expect(addAttempt(PRODUCT_Y_ID)).resolves.toMatchObject({ ok: true });
  });
});

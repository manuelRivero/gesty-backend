import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/prisma', () => ({
  prisma: {
    orders: { findFirst: vi.fn() },
    payment_proof: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock('../adminOrders.service', () => ({
  updateAdminOrderPaymentStatus: vi.fn(),
}));

import { prisma } from '../../lib/prisma';
import { updateAdminOrderPaymentStatus } from '../adminOrders.service';
import { listAdminPaymentProofs, reviewAdminPaymentProof } from '../adminPaymentProof.service';

const mockedOrdersFindFirst = prisma.orders.findFirst as unknown as ReturnType<typeof vi.fn>;
const mockedFindMany = prisma.payment_proof.findMany as unknown as ReturnType<typeof vi.fn>;
const mockedFindFirst = prisma.payment_proof.findFirst as unknown as ReturnType<typeof vi.fn>;
const mockedUpdate = prisma.payment_proof.update as unknown as ReturnType<typeof vi.fn>;
const mockedUpdatePaymentStatus = updateAdminOrderPaymentStatus as unknown as ReturnType<typeof vi.fn>;

describe('adminPaymentProof.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('listAdminPaymentProofs', () => {
    it('devuelve null si la orden no pertenece al negocio (404, no filtración)', async () => {
      mockedOrdersFindFirst.mockResolvedValueOnce(null);

      const result = await listAdminPaymentProofs('biz-1', 'order-other-business');

      expect(result).toBeNull();
      expect(mockedFindMany).not.toHaveBeenCalled();
    });

    it('lista los comprobantes de la orden cuando pertenece al negocio', async () => {
      mockedOrdersFindFirst.mockResolvedValueOnce({ id: 'order-1' });
      mockedFindMany.mockResolvedValueOnce([{ id: 'proof-1' }]);

      const result = await listAdminPaymentProofs('biz-1', 'order-1');

      expect(result).toEqual([{ id: 'proof-1' }]);
    });
  });

  describe('reviewAdminPaymentProof', () => {
    it('aprobar deja la orden en paid y el proof en approved', async () => {
      mockedFindFirst.mockResolvedValueOnce({ id: 'proof-1' });
      mockedUpdate.mockResolvedValueOnce({ id: 'proof-1', status: 'approved' });

      const result = await reviewAdminPaymentProof({
        businessId: 'biz-1',
        orderId: 'order-1',
        proofId: 'proof-1',
        decision: 'approve',
        reviewedBy: 'admin-1',
      });

      expect(result).toEqual({ outcome: 'ok', proof: { id: 'proof-1', status: 'approved' } });
      expect(mockedUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'approved', reviewed_by: 'admin-1' }),
        })
      );
      expect(mockedUpdatePaymentStatus).toHaveBeenCalledWith('biz-1', 'order-1', 'paid');
    });

    it('rechazar deja el proof en rejected y no toca payment_status', async () => {
      mockedFindFirst.mockResolvedValueOnce({ id: 'proof-1' });
      mockedUpdate.mockResolvedValueOnce({ id: 'proof-1', status: 'rejected' });

      const result = await reviewAdminPaymentProof({
        businessId: 'biz-1',
        orderId: 'order-1',
        proofId: 'proof-1',
        decision: 'reject',
        reviewedBy: 'admin-1',
        note: 'Monto no coincide',
      });

      expect(result).toEqual({ outcome: 'ok', proof: { id: 'proof-1', status: 'rejected' } });
      expect(mockedUpdatePaymentStatus).not.toHaveBeenCalled();
    });

    it('devuelve not_found si el proof es de otro negocio (aislamiento por business_id)', async () => {
      mockedFindFirst.mockResolvedValueOnce(null);

      const result = await reviewAdminPaymentProof({
        businessId: 'biz-1',
        orderId: 'order-1',
        proofId: 'proof-other-business',
        decision: 'approve',
        reviewedBy: 'admin-1',
      });

      expect(result).toEqual({ outcome: 'not_found' });
      expect(mockedUpdate).not.toHaveBeenCalled();
      expect(mockedUpdatePaymentStatus).not.toHaveBeenCalled();
    });
  });
});

/**
 * Worker: reconcilia comprobantes en `processing`/`requires_review` contra el proveedor de
 * facturación en vez de reintentar la emisión a ciegas (ver `invoice.service.ts`, FASE 4).
 */
import { reconcilePendingInvoices } from "../services/invoicing/invoice.service";

export async function processInvoicingReconciliation(): Promise<{
  reconciled: number;
  providerUnavailable: number;
  skippedForManualReview: number;
}> {
  return reconcilePendingInvoices();
}

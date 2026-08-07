/**
 * Superficie de admin para revisar comprobantes de transferencia (Fase 5 del
 * plan de comprobantes de transferencia). Aislamiento por `business_id` en
 * cada query, siguiendo el mismo criterio que `adminOrders.service.ts`.
 */

import { OrderPaymentStatus } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { updateAdminOrderPaymentStatus } from "./adminOrders.service";
import { notifyCustomerPaymentProofReviewed } from "./paymentProofNotification.service";

export async function listAdminPaymentProofs(businessId: string, orderId: string) {
  const order = await prisma.orders.findFirst({
    where: { id: orderId, business_id: businessId },
    select: { id: true }
  });
  if (!order) return null;

  return prisma.payment_proof.findMany({
    where: { business_id: businessId, order_id: orderId },
    orderBy: { created_at: "desc" }
  });
}

export type ReviewPaymentProofDecision = "approve" | "reject";

export type ReviewPaymentProofResult =
  | { outcome: "not_found" }
  | { outcome: "ok"; proof: NonNullable<Awaited<ReturnType<typeof getPaymentProofOrNull>>> };

async function getPaymentProofOrNull(
  businessId: string,
  orderId: string,
  proofId: string
) {
  return prisma.payment_proof.findFirst({
    where: { id: proofId, business_id: businessId, order_id: orderId }
  });
}

/**
 * Aprueba o rechaza un comprobante. Al aprobar, reutiliza
 * `updateAdminOrderPaymentStatus` (ya emite el evento de socket de pago) en
 * vez de duplicar esa lógica — D3: el `payment_status` solo cambia por
 * acción explícita de un admin.
 */
export async function reviewAdminPaymentProof(params: {
  businessId: string;
  orderId: string;
  proofId: string;
  decision: ReviewPaymentProofDecision;
  reviewedBy: string;
  note?: string;
}): Promise<ReviewPaymentProofResult> {
  const { businessId, orderId, proofId, decision, reviewedBy, note } = params;

  const existing = await getPaymentProofOrNull(businessId, orderId, proofId);
  if (!existing) {
    return { outcome: "not_found" };
  }

  const nextStatus = decision === "approve" ? "approved" : "rejected";

  const proof = await prisma.payment_proof.update({
    where: { id: existing.id },
    data: {
      status: nextStatus,
      reviewed_by: reviewedBy,
      reviewed_at: new Date(),
      review_note: note ?? null
    }
  });

  if (decision === "approve") {
    await updateAdminOrderPaymentStatus(businessId, orderId, OrderPaymentStatus.paid);
  }

  // D9: el aviso al cliente nunca revierte la aprobación/rechazo — ya está
  // persistido arriba. Un fallo de envío (p. ej. fuera de la ventana de 24 h
  // de WhatsApp) se loguea, no se tapa.
  try {
    await notifyCustomerPaymentProofReviewed({ businessId, orderId, decision });
  } catch (error) {
    console.error("[AdminPaymentProof] Error al avisar al cliente:", error);
  }

  return { outcome: "ok", proof };
}

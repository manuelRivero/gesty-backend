/**
 * Nodo `paymentProof`: procesa una imagen entrante cuando el cliente tiene
 * una orden de transferencia esperando comprobante (D1, ver
 * PLAN-ACCION-COMPROBANTES-TRANSFERENCIA.md).
 *
 * Secuencia: resolver la orden → descargar el adjunto de WhatsApp → calcular
 * hash perceptual → subir a R2 → chequear reuso del hash → crear el
 * `payment_proof` → emitir evento de socket → responder al cliente → disparar
 * (fire-and-forget, Fase 7) el auto-chequeo con visión.
 *
 * D3: nunca marca la orden como pagada — eso lo hace un admin desde el panel
 * (ver Fase 5). D4: no se detecta adulteración, solo reuso de imagen (D6: el
 * hash perceptual alimenta un check informativo, nunca un rechazo
 * automático). D8: los checks de la Fase 7 tampoco deciden nada, solo pintan
 * la fila del panel.
 *
 * Degradación suave obligatoria: cualquier falla (descarga, storage, Prisma)
 * responde con un mensaje neutro y nunca deja al cliente sin respuesta ni
 * crea un `payment_proof` huérfano. El auto-chequeo con visión corre después
 * de responder al cliente y nunca demora esa respuesta: si visión falla, da
 * timeout o el negocio no tiene cuota de IA, el proof queda en `received`.
 */

import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../../lib/prisma';
import { getStorageProvider } from '../../../storage';
import {
  findOrderAwaitingTransferProof,
  type OrderAwaitingTransferProof,
} from '../../../services/payment/transferProof.service';
import { downloadWhatsAppMedia } from '../../../integrations/whatsapp/mediaDownload';
import {
  emitAdminOrderPaymentProofChecked,
  emitAdminOrderPaymentProofReceived,
} from '../../../socket/adminSocket';
import { textResponse } from '../../../controllers/webhook/utils';
import {
  PAYMENT_PROOF_DUPLICATE_BOT_MESSAGE,
  PAYMENT_PROOF_ESCALATED_BOT_MESSAGE,
  PAYMENT_PROOF_FALLBACK_BOT_MESSAGE,
  PAYMENT_PROOF_RECEIVED_BOT_MESSAGE,
} from '../../../services/productQuery/botMessages';
import {
  extractPaymentProofWithVision,
  type PaymentProofVisionResult,
} from '../../../services/ai/paymentProofVision.service';
import {
  computePaymentProofChecks,
  hasFailedCheck,
} from '../../../services/payment/paymentProofChecks';
import { handOverToHuman } from '../../../services/humanHandover.service';
import { sendResponseNoContext } from '../../../controllers/webhook/sender';
import { env } from '../../../config/env';
import type { AgentState, AgentStateUpdate } from '../../state';
import type { business as Business } from '@prisma/client';

const MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

const logEvent = (event: string, data: Record<string, unknown>): void => {
  console.log(JSON.stringify({ event: `[payment-proof] ${event}`, ...data }));
};

const logError = (event: string, data: Record<string, unknown>): void => {
  console.error(JSON.stringify({ event: `[payment-proof] ${event}`, ...data }));
};

/**
 * Hash perceptual simple (average hash): escala de grises 8x8, promedio de
 * intensidad, bitstring de 64 caracteres. Suficiente para detectar reuso de
 * la misma imagen (D6); no es un identificador criptográfico.
 */
async function computePerceptualHash(buffer: Buffer): Promise<string> {
  const { data } = await sharp(buffer)
    .grayscale()
    .resize(8, 8, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });

  let sum = 0;
  for (const value of data) sum += value;
  const average = sum / data.length;

  let bits = '';
  for (const value of data) {
    bits += value >= average ? '1' : '0';
  }
  return bits;
}

function buildPaymentProofKey(businessId: string, orderId: string, mimeType: string): string {
  const ext = MIME_TO_EXT[mimeType] ?? 'bin';
  return `business/${businessId}/payment-proofs/${orderId}/${randomUUID()}.${ext}`;
}

/**
 * ¿Esta imagen ya está asociada a esta misma orden? (Fase 8, dedupe)
 *
 * Matchea por `perceptual_hash` (tolera recompresión de WhatsApp) o por el
 * `sha256` que devuelve Meta (exacto, y sirve de red cuando el hash
 * perceptual no se pudo calcular). Ante un error de Prisma devuelve `null`:
 * el peor caso de un dedupe fallido es procesar un duplicado, que es
 * exactamente el comportamiento previo a esta fase.
 */
async function findDuplicateProofForOrder(params: {
  businessId: string;
  orderId: string;
  perceptualHash: string | null;
  mediaSha256: string | null;
}): Promise<string | null> {
  const { businessId, orderId, perceptualHash, mediaSha256 } = params;

  const identityFilters = [
    ...(perceptualHash ? [{ perceptual_hash: perceptualHash }] : []),
    ...(mediaSha256 ? [{ media_sha256: mediaSha256 }] : []),
  ];
  if (identityFilters.length === 0) return null;

  try {
    const duplicate = await prisma.payment_proof.findFirst({
      where: { business_id: businessId, order_id: orderId, OR: identityFilters },
      select: { id: true },
    });
    return duplicate?.id ?? null;
  } catch (error) {
    logError('duplicate_check_failed', { orderId, error: String(error) });
    return null;
  }
}

/**
 * Escalamiento por comprobantes incorrectos (Fase 8).
 *
 * No es un tope de comprobantes: un comprobante que pasa los checks es plata
 * entrando y nunca se frena. Lo que se cuenta son los que tienen al menos un
 * check en `fail`; los `unknown` no suman.
 *
 * Escala cuando el total llega **exactamente** al tope. Al crearse cada proof
 * una sola vez, esa igualdad hace que el escalamiento dispare una única vez
 * por orden sin persistir ningún flag de "ya avisé" — mismo criterio de
 * derivador sobre Facts que el resto del sistema. Si un admin devuelve la
 * conversación al bot, un cuarto comprobante fallado ya no vuelve a escalar.
 *
 * "Escalar" acá no es cerrarle la puerta al cliente: es sacar al bot del
 * medio y poner a una persona, para que el pago siga entrando por vía humana.
 */
async function escalateIfTooManyFailedProofs(params: {
  business: Business;
  customer: { id: string; phone_number?: string | null; name?: string | null };
  conversationId: string | null;
  order: OrderAwaitingTransferProof;
}): Promise<void> {
  const { business, customer, conversationId, order } = params;

  const proofs = await prisma.payment_proof.findMany({
    where: { business_id: business.id, order_id: order.id },
    select: { checks: true },
  });

  const failedCount = proofs.filter((proof) => hasFailedCheck(proof.checks)).length;
  if (failedCount !== env.TRANSFER_PROOF_MAX_FAILED) return;

  logEvent('escalating_to_human', { orderId: order.id, failedCount });

  if (conversationId) {
    await handOverToHuman({
      conversationId,
      businessId: business.id,
      customer,
      reason: 'payment_proof:too_many_failed',
    });
  }

  // El escalamiento ocurre en background, después de que el cliente ya recibió
  // la confirmación de recepción, así que el aviso va fuera de turno. A partir
  // de acá el grafo corta por `is_human_handled` y el bot no responde más.
  if (business.whatsapp_phone_id && customer.phone_number) {
    try {
      await sendResponseNoContext(
        business.whatsapp_phone_id,
        customer.phone_number,
        PAYMENT_PROOF_ESCALATED_BOT_MESSAGE
      );
    } catch (error) {
      logError('escalation_notice_failed', { orderId: order.id, error: String(error) });
    }
  }
}

/**
 * Auto-chequeo con visión (Fase 7, Tarea 7.3): corre en background después
 * de responder al cliente. Si visión no devuelve nada (falla, timeout, sin
 * cuota de IA — ver D7 en paymentProofVision.service.ts), el proof queda tal
 * cual en `received`: no hay nada que actualizar.
 */
export async function runPaymentProofAutoCheck(params: {
  business: Business;
  customer: { id: string; phone_number?: string | null; name?: string | null };
  conversationId: string | null;
  order: OrderAwaitingTransferProof;
  proofId: string;
  imageBuffer: Buffer;
  mimeType: string;
  imageReusedInOrderId: string | null;
}): Promise<void> {
  const { business, customer, conversationId, order, proofId, imageBuffer, mimeType, imageReusedInOrderId } =
    params;

  let extracted: PaymentProofVisionResult | null = null;
  try {
    extracted = await extractPaymentProofWithVision({ business, imageBuffer, mimeType });
  } catch (error) {
    logError('auto_check_vision_failed', { orderId: order.id, proofId, error: String(error) });
    return;
  }

  if (!extracted) {
    logEvent('auto_check_skipped_no_extraction', { orderId: order.id, proofId });
    return;
  }

  try {
    const bankConfig = await prisma.payment_method_config.findFirst({
      where: { business_id: business.id, payment_method: 'transfer' },
      select: { bank_alias: true, bank_cbu: true },
    });

    let operationNumberAlreadyUsed = false;
    if (extracted.operation_number) {
      const duplicate = await prisma.payment_proof.findFirst({
        where: {
          business_id: business.id,
          id: { not: proofId },
          extracted: { path: ['operation_number'], equals: extracted.operation_number },
        },
        select: { id: true },
      });
      operationNumberAlreadyUsed = duplicate !== null;
    }

    const checks = computePaymentProofChecks({
      extracted,
      order: { total_amount: order.total_amount, created_at: order.created_at },
      bankConfig,
      operationNumberAlreadyUsed,
      imageReusedInOrderId,
    });

    await prisma.payment_proof.update({
      where: { id: proofId },
      data: {
        status: 'auto_checked',
        extracted: extracted as unknown as Prisma.InputJsonValue,
        checks: checks as unknown as Prisma.InputJsonValue,
      },
    });

    emitAdminOrderPaymentProofChecked(business.id, { orderId: order.id, proofId });
    logEvent('auto_checked', { orderId: order.id, proofId });
  } catch (error) {
    logError('auto_check_persist_failed', { orderId: order.id, proofId, error: String(error) });
    return;
  }

  try {
    await escalateIfTooManyFailedProofs({ business, customer, conversationId, order });
  } catch (error) {
    logError('escalation_check_failed', { orderId: order.id, proofId, error: String(error) });
  }
}

export const paymentProofNode = async (
  state: AgentState
): Promise<AgentStateUpdate> => {
  const business = state.business;
  const customer = state.customer;
  const conversationId = state.conversationId;
  const imageId = state.webhookContext?.message?.image?.id as string | undefined;

  const fallback = (): AgentStateUpdate => ({
    handlerResult: textResponse(PAYMENT_PROOF_FALLBACK_BOT_MESSAGE),
  });

  if (!business || !customer || !imageId) {
    logEvent('missing_context', {
      hasBusiness: Boolean(business),
      hasCustomer: Boolean(customer),
      hasImageId: Boolean(imageId),
    });
    return fallback();
  }

  const order =
    state.awaitingTransferProofOrder ??
    (await findOrderAwaitingTransferProof({
      businessId: business.id,
      customerId: customer.id,
    }).catch((error) => {
      logError('resolve_order_failed', { businessId: business.id, customerId: customer.id, error: String(error) });
      return null;
    }));

  if (!order) {
    logEvent('no_awaiting_order', { businessId: business.id, customerId: customer.id });
    return fallback();
  }

  let media: Awaited<ReturnType<typeof downloadWhatsAppMedia>>;
  try {
    media = await downloadWhatsAppMedia(imageId);
  } catch (error) {
    logError('download_failed', { orderId: order.id, imageId, error: String(error) });
    return fallback();
  }

  let perceptualHash: string | null = null;
  try {
    perceptualHash = await computePerceptualHash(media.buffer);
  } catch (error) {
    // El hash es informativo (D6); si falla, seguimos sin bloquear el turno.
    logError('perceptual_hash_failed', { orderId: order.id, error: String(error) });
  }

  // Dedupe (Fase 8): la misma imagen ya asociada a esta misma orden no es
  // plata nueva, es la misma plata repetida. Se corta acá, antes de subir a
  // R2 y antes de llamar a visión, sin crear una fila más para el admin.
  // Solo matchea contra la propia orden: un comprobante distinto nunca queda
  // afuera por esto.
  const duplicateOf = await findDuplicateProofForOrder({
    businessId: business.id,
    orderId: order.id,
    perceptualHash,
    mediaSha256: media.sha256,
  });
  if (duplicateOf) {
    logEvent('duplicate_ignored', { orderId: order.id, duplicateOfProofId: duplicateOf });
    return { handlerResult: textResponse(PAYMENT_PROOF_DUPLICATE_BOT_MESSAGE) };
  }

  const key = buildPaymentProofKey(business.id, order.id, media.mimeType);
  let mediaUrl: string;
  try {
    const storage = getStorageProvider();
    await storage.upload({
      key,
      body: media.buffer,
      contentType: media.mimeType,
      contentLength: media.sizeBytes,
    });
    mediaUrl = storage.getPublicUrl(key);
  } catch (error) {
    logError('upload_failed', { orderId: order.id, key, error: String(error) });
    return fallback();
  }

  let reusedInOrderId: string | null = null;
  if (perceptualHash) {
    try {
      const reused = await prisma.payment_proof.findFirst({
        where: {
          business_id: business.id,
          perceptual_hash: perceptualHash,
          order_id: { not: order.id },
        },
        select: { order_id: true },
      });
      reusedInOrderId = reused?.order_id ?? null;
    } catch (error) {
      logError('reuse_check_failed', { orderId: order.id, error: String(error) });
    }
  }

  const checks = {
    image_not_reused:
      reusedInOrderId === null ? 'pass' : ('fail' as 'pass' | 'fail' | 'unknown'),
    ...(reusedInOrderId ? { image_reused_in_order_id: reusedInOrderId } : {}),
  };

  try {
    const proof = await prisma.payment_proof.create({
      data: {
        business_id: business.id,
        order_id: order.id,
        customer_id: customer.id,
        conversation_id: conversationId,
        media_key: key,
        media_url: mediaUrl,
        media_mime: media.mimeType,
        media_sha256: media.sha256,
        perceptual_hash: perceptualHash,
        status: 'received',
        checks,
      },
      select: { id: true },
    });

    emitAdminOrderPaymentProofReceived(business.id, {
      orderId: order.id,
      proofId: proof.id,
    });

    logEvent('created', { orderId: order.id, proofId: proof.id, reusedInOrderId });

    // Fire-and-forget (Tarea 7.3): el cliente ya recibe su respuesta abajo;
    // esperar acá el llamado a visión sería peor producto.
    void runPaymentProofAutoCheck({
      business,
      customer,
      conversationId,
      order,
      proofId: proof.id,
      imageBuffer: media.buffer,
      mimeType: media.mimeType,
      imageReusedInOrderId: reusedInOrderId,
    }).catch((error) => {
      logError('auto_check_unhandled', { orderId: order.id, proofId: proof.id, error: String(error) });
    });
  } catch (error) {
    logError('create_failed', { orderId: order.id, key, error: String(error) });
    return fallback();
  }

  return { handlerResult: textResponse(PAYMENT_PROOF_RECEIVED_BOT_MESSAGE) };
};

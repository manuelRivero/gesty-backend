/**
 * Nodo `paymentProof`: procesa una imagen entrante cuando el cliente tiene
 * una orden de transferencia esperando comprobante (D1, ver
 * PLAN-ACCION-COMPROBANTES-TRANSFERENCIA.md).
 *
 * Secuencia: resolver la orden → descargar el adjunto de WhatsApp → calcular
 * hash perceptual → subir a R2 → chequear reuso del hash → crear el
 * `payment_proof` → emitir evento de socket → responder al cliente.
 *
 * D3: nunca marca la orden como pagada — eso lo hace un admin desde el panel
 * (ver Fase 5). D4: no se detecta adulteración, solo reuso de imagen (D6: el
 * hash perceptual alimenta un check informativo, nunca un rechazo
 * automático).
 *
 * Degradación suave obligatoria: cualquier falla (descarga, storage, Prisma)
 * responde con un mensaje neutro y nunca deja al cliente sin respuesta ni
 * crea un `payment_proof` huérfano.
 */

import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { prisma } from '../../../lib/prisma';
import { getStorageProvider } from '../../../storage';
import { findOrderAwaitingTransferProof } from '../../../services/payment/transferProof.service';
import { downloadWhatsAppMedia } from '../../../integrations/whatsapp/mediaDownload';
import { emitAdminOrderPaymentProofReceived } from '../../../socket/adminSocket';
import { textResponse } from '../../../controllers/webhook/utils';
import {
  PAYMENT_PROOF_FALLBACK_BOT_MESSAGE,
  PAYMENT_PROOF_RECEIVED_BOT_MESSAGE,
} from '../../../services/productQuery/botMessages';
import type { AgentState, AgentStateUpdate } from '../../state';

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
  } catch (error) {
    logError('create_failed', { orderId: order.id, key, error: String(error) });
    return fallback();
  }

  return { handlerResult: textResponse(PAYMENT_PROOF_RECEIVED_BOT_MESSAGE) };
};

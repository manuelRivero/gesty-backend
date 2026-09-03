/**
 * Extracción con visión de comprobantes de transferencia (Fase 7, Tarea 7.1
 * de PLAN-ACCION-COMPROBANTES-CIERRE.md).
 *
 * Un único llamado a `gpt-4o` con la imagen como data URL en base64 desde el
 * buffer ya descargado (no la URL de Meta, que expira en minutos). Salida
 * validada con `zod`; ante cualquier fallo (parseo, timeout, sin cuota de
 * IA) devuelve `null` y el `payment_proof` queda en `received` para revisión
 * manual — nunca lanza y nunca bloquea el turno del cliente (D8).
 *
 * D4: ningún campo de detección de fraude. Todos los campos de datos son
 * nullable — instruimos al modelo a devolver null en vez de adivinar, porque
 * un dato inventado contamina un check que el admin va a creer a ciegas.
 *
 * D7: la llamada se contabiliza como uso de IA del negocio, con el mismo
 * gate que `generateAIResponse` (openai.service.ts) — un negocio bloqueado
 * o sin cuota no dispara esta llamada.
 */

import OpenAI from 'openai';
import { z } from 'zod';
import type { business as Business } from '@prisma/client';
import { evaluateBusinessBillingAccess } from '../billing/evaluateBusinessBillingAccess.service';
import { getEffectiveAiTokenLimit } from './aiLimits';
import { incrementUsage } from './aiUsage.service';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export const PAYMENT_PROOF_VISION_TIMEOUT_MS = 20_000;

const PaymentProofVisionSchema = z.object({
  kind: z.enum(['transfer_voucher', 'other']),
  legibility: z.enum(['clear', 'partial', 'unreadable']),
  amount: z.number().nullable(),
  currency: z.string().nullable(),
  operation_number: z.string().nullable(),
  transferred_at: z.string().nullable(),
  sender_name: z.string().nullable(),
  bank: z.string().nullable(),
  destination_alias: z.string().nullable(),
  destination_cbu: z.string().nullable(),
  destination_holder: z.string().nullable(),
});

export type PaymentProofVisionResult = z.infer<typeof PaymentProofVisionSchema>;

const SYSTEM_PROMPT = `Analizás capturas de pantalla de comprobantes de transferencia bancaria argentina (Mercado Pago, home banking, billeteras virtuales).

Devolvé ÚNICAMENTE un JSON con esta forma exacta, sin texto adicional:
{
  "kind": "transfer_voucher" | "other",
  "legibility": "clear" | "partial" | "unreadable",
  "amount": number | null,
  "currency": string | null,
  "operation_number": string | null,
  "transferred_at": string | null,
  "sender_name": string | null,
  "bank": string | null,
  "destination_alias": string | null,
  "destination_cbu": string | null,
  "destination_holder": string | null
}

Reglas estrictas:
- "kind" = "other" si la imagen no es un comprobante de transferencia (ej. un menú, una foto random, un ticket de compra).
- Si un dato no se puede leer con certeza, devolvé null para ese campo. NUNCA inventes ni estimes un valor.
- "amount" es un número plano (sin símbolo de moneda ni separadores de miles), por ejemplo 1500.50.
- "transferred_at" en formato ISO 8601 si se puede leer, si no null.
- No evalúes ni comentés si el comprobante es auténtico, editado o sospechoso. Tu única tarea es transcribir los datos visibles.`;

function buildDataUrl(imageBuffer: Buffer, mimeType: string): string {
  return `data:${mimeType};base64,${imageBuffer.toString('base64')}`;
}

/**
 * Gate de uso de IA del negocio (D7): mismo criterio que `generateAIResponse`
 * (openai.service.ts) — negocio bloqueado o sin cuota no dispara el llamado.
 */
async function canUseVisionForBusiness(business: Business): Promise<boolean> {
  if (business.ai_blocked) return false;

  const trialAccess = await evaluateBusinessBillingAccess(business);
  if (!trialAccess.ok) return false;

  const effectiveLimit = getEffectiveAiTokenLimit(trialAccess.business);
  if (trialAccess.business.ai_monthly_tokens_used >= effectiveLimit) return false;

  return true;
}

export const extractPaymentProofWithVision = async (params: {
  business: Business;
  imageBuffer: Buffer;
  mimeType: string;
}): Promise<PaymentProofVisionResult | null> => {
  const { business, imageBuffer, mimeType } = params;

  const canUse = await canUseVisionForBusiness(business).catch((error) => {
    console.error(
      JSON.stringify({ event: '[payment-proof-vision] usage_gate_failed', businessId: business.id, error: String(error) })
    );
    return false;
  });
  if (!canUse) {
    console.log(
      JSON.stringify({ event: '[payment-proof-vision] skipped_no_quota', businessId: business.id })
    );
    return null;
  }

  try {
    const response = await openai.chat.completions.create(
      {
        model: 'gpt-4o',
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Extraé los datos de este comprobante de transferencia.' },
              { type: 'image_url', image_url: { url: buildDataUrl(imageBuffer, mimeType) } },
            ],
          },
        ],
      },
      { timeout: PAYMENT_PROOF_VISION_TIMEOUT_MS }
    );

    const totalTokens = response.usage?.total_tokens ?? 0;
    if (totalTokens > 0) {
      await incrementUsage(business.id, totalTokens).catch((error) => {
        console.error(
          JSON.stringify({ event: '[payment-proof-vision] increment_usage_failed', businessId: business.id, error: String(error) })
        );
      });
    }

    const rawContent = response.choices[0]?.message?.content;
    if (!rawContent) return null;

    const parsedJson: unknown = JSON.parse(rawContent);
    const result = PaymentProofVisionSchema.safeParse(parsedJson);
    if (!result.success) {
      console.error(
        JSON.stringify({ event: '[payment-proof-vision] schema_validation_failed', businessId: business.id })
      );
      return null;
    }

    return result.data;
  } catch (error) {
    console.error(
      JSON.stringify({ event: '[payment-proof-vision] call_failed', businessId: business.id, error: String(error) })
    );
    return null;
  }
};

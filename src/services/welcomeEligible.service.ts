/**
 * Tras cancelar pedido/reserva el hilo sigue abierto: el próximo saludo debe
 * volver a ofrecer welcome (menú / pedir / reservar), no party size de pedido.
 */

import { omitConversationMetadataKeys, patchConversationMetadata } from '../repositories';
import { normalizeMetadata } from './productQuery/utils';
import type { ConversationMetadata } from './productQuery/types';

export const WELCOME_ELIGIBLE_KEY = 'welcomeEligible' as const;

export function isWelcomeEligible(metadata: unknown): boolean {
  const meta = normalizeMetadata(metadata) as ConversationMetadata;
  return meta.welcomeEligible === true;
}

export async function setWelcomeEligible(conversationId: string): Promise<void> {
  await patchConversationMetadata(conversationId, { welcomeEligible: true });
}

export async function clearWelcomeEligible(conversationId: string): Promise<void> {
  await omitConversationMetadataKeys(conversationId, [WELCOME_ELIGIBLE_KEY]);
}

export function buildWelcomeEligibleContextLines(metadata: unknown): string[] {
  if (!isWelcomeEligible(metadata)) return [];
  return [
    '- Bienvenida elegible (welcomeEligible): el cliente canceló/cerró el dominio anterior y el hilo sigue abierto.',
    '  Si saluda o escribe charla sin intención clara ("hola", "buenas", "qué tal"): tratá como primer saludo —',
    '  present_welcome_options(bodyText) con menú / pedir / reservar. PROHIBIDO *¿Para cuántas personas?* ni save_party_size.',
    '  Si pide comida concreta o reservar mesa: seguí el flujo normal (pedido o start_reservation_session) y no hace falta el welcome.',
  ];
}

/**
 * Saludo / charla social corta sin intención de pedido ni reserva.
 * Usado para forzar welcome cuando welcomeEligible está activo.
 */
export function isWelcomeEligibleGreeting(userMessage: string): boolean {
  const raw = userMessage.trim();
  if (!raw || raw.length > 80) return false;
  const t = raw
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '');
  if (
    /\b(reserv|mesa|pedido|menu|ceviche|pizza|lomo|hamburg|quiero|dame|suma|pedir|agrega|finalizar|pagar)\b/i.test(
      t
    )
  ) {
    return false;
  }
  return (
    /^(hola|holis|holi|buenas|buenos\s+dias|buen\s+dia|hey)\b/.test(t) ||
    /^(que\s+tal|como\s+est|todo\s+bien)\b/.test(t) ||
    /^(hola|buenas)[\s!,.¿?]*$/i.test(t)
  );
}

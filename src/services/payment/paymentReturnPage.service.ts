/**
 * Datos para las páginas HTML de retorno post-Checkout Pro del bot WA (PAY-07).
 * Storefront no usa estas rutas.
 */

import { prisma } from '../../lib/prisma';
import { shortOrderRef } from '../orderStatusNotification.service';
import { normalizePhoneDigits } from '../ownerAssistant/matchOwnerPhone';

export type PaymentReturnKind = 'success' | 'failure' | 'pending';

export type PaymentReturnPageModel = {
  kind: PaymentReturnKind;
  businessName: string | null;
  amountLabel: string | null;
  orderRef: string | null;
  /** true si success pero el intent aún no está approved (race webhook). */
  confirming: boolean;
  chatUrl: string | null;
};

function formatAmount(amount: { toString(): string }, currency: string): string {
  const n = Number(amount.toString());
  if (!Number.isFinite(n)) return `${amount.toString()} ${currency}`;
  try {
    return new Intl.NumberFormat('es-AR', {
      style: 'currency',
      currency: currency || 'ARS',
      maximumFractionDigits: 2,
    }).format(n);
  } catch {
    return `$${amount.toString()} ${currency}`;
  }
}

export function buildWhatsAppChatUrl(
  phone: string | null | undefined
): string | null {
  if (!phone) return null;
  const digits = normalizePhoneDigits(phone);
  if (digits.length < 8 || digits.length > 15) return null;
  return `https://wa.me/${digits}`;
}

export async function resolvePaymentReturnPage(params: {
  kind: PaymentReturnKind;
  businessId?: string | null;
  externalReference?: string | null;
  preferenceId?: string | null;
}): Promise<PaymentReturnPageModel> {
  const businessId = params.businessId?.trim() || null;
  const externalReference = params.externalReference?.trim() || null;
  const preferenceId = params.preferenceId?.trim() || null;

  const empty: PaymentReturnPageModel = {
    kind: params.kind,
    businessName: null,
    amountLabel: null,
    orderRef: null,
    confirming: params.kind === 'success',
    chatUrl: null,
  };

  if (!businessId && !externalReference && !preferenceId) {
    return empty;
  }

  const orFilters: Array<
    | { draft_order_id: string }
    | { preference_id: string }
    | { order_id: string }
  > = [];
  if (externalReference) {
    orFilters.push({ draft_order_id: externalReference });
    orFilters.push({ order_id: externalReference });
  }
  if (preferenceId) {
    orFilters.push({ preference_id: preferenceId });
  }

  if (orFilters.length === 0 && !businessId) {
    return empty;
  }

  const intent = await prisma.payment_intent.findFirst({
    where: {
      ...(businessId ? { business_id: businessId } : {}),
      ...(orFilters.length > 0 ? { OR: orFilters } : {}),
    },
    orderBy: { created_at: 'desc' },
    include: {
      business: {
        select: {
          name: true,
          whatsapp_phone_number: true,
        },
      },
    },
  });

  if (!intent) {
    if (!businessId) return empty;
    const business = await prisma.business.findUnique({
      where: { id: businessId },
      select: { name: true, whatsapp_phone_number: true },
    });
    if (!business) return empty;
    return {
      ...empty,
      businessName: business.name,
      chatUrl: buildWhatsAppChatUrl(business.whatsapp_phone_number),
      confirming: params.kind === 'success',
    };
  }

  const approved = intent.status === 'approved';
  const confirming = params.kind === 'success' && !approved;

  return {
    kind: params.kind,
    businessName: intent.business.name,
    amountLabel: formatAmount(intent.amount, intent.currency),
    orderRef: intent.order_id ? shortOrderRef(intent.order_id) : null,
    confirming,
    chatUrl: buildWhatsAppChatUrl(intent.business.whatsapp_phone_number),
  };
}

export function paymentReturnCopy(model: PaymentReturnPageModel): {
  title: string;
  subtitle: string;
} {
  if (model.kind === 'failure') {
    return {
      title: 'Pago no completado',
      subtitle:
        'No se acreditó el pago. Podés volver al chat para reintentar o elegir otro medio.',
    };
  }
  if (model.kind === 'pending') {
    return {
      title: 'Pago en proceso',
      subtitle:
        'Mercado Pago está procesando el cobro. Te avisamos por WhatsApp cuando se confirme.',
    };
  }
  if (model.confirming) {
    return {
      title: 'Confirmando tu pago…',
      subtitle:
        'Estamos recibiendo la confirmación. En unos segundos te llega el mensaje por WhatsApp.',
    };
  }
  return {
    title: 'Pago recibido',
    subtitle:
      'Tu pedido quedó confirmado. Te enviamos el detalle por WhatsApp.',
  };
}

/** Contrato público `/api/v1/public/ambassadors/validate` (sin auth). */
export type AmbassadorValidateRequest = {
  code: string;
};

export type AmbassadorValidateResponse =
  | { valid: true; publicCode: string; status: string }
  | { valid: false };

/** Contrato `/api/v1/integrations/ambassadors/register-sale` (auth de servicio). */
export type RegisterSaleRequest = {
  publicCode: string;
  orderId: string;
  customer: {
    phone: string;
    name: string;
  };
  order: {
    total: number;
    currency: string;
    /** ISO-8601 UTC. */
    paidAt: string;
  };
};

export type RegisterSaleResponse =
  | { success: true; commissionCreated: true; message?: string }
  | { success: true; commissionCreated: false; reason?: string };

export class AmbassadorsNotConfiguredError extends Error {
  constructor(message = 'La integración de Embajadores no está configurada en el servidor') {
    super(message);
    this.name = 'AmbassadorsNotConfiguredError';
  }
}

/**
 * Error de la API de Embajadores. `status` refleja el HTTP real (o 502 para
 * errores de red/timeout) para que el llamador decida si el fallo es
 * permanente (400/403/404) o transitorio (401/5xx/502) y actúe en consecuencia.
 */
export class AmbassadorsApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(message: string, status: number, body?: unknown) {
    super(message);
    this.name = 'AmbassadorsApiError';
    this.status = status;
    this.body = body;
  }
}

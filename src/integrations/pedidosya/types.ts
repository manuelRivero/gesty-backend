/** Coordenada WGS84. */
export type LatLng = {
  lat: number;
  lng: number;
};

/** Oferta de entrega dentro de una estimación PedidosYa. */
export type PedidosYaDeliveryOffer = {
  deliveryOfferId?: string;
  deliveryMode?: string;
  pricing?: {
    subTotal?: number;
    taxes?: number;
    total?: number;
  };
};

/** Respuesta de POST /v3/shippings/estimates. */
export type PedidosYaEstimateResponse = {
  estimateId?: string;
  routes?: { distance?: number };
  deliveryOffers?: PedidosYaDeliveryOffer[];
};

export type PedidosYaEstimateRequest = {
  referenceId: string;
  isTest: boolean;
  notificationMail?: string;
  items: Array<{
    type: 'STANDARD';
    value: number;
    description: string;
    sku: string;
    quantity: number;
    volume: number;
    weight: number;
  }>;
  waypoints: Array<{
    type: 'PICK_UP' | 'DROP_OFF';
    addressStreet: string;
    addressAdditional?: string;
    city: string;
    latitude: number;
    longitude: number;
    phone: string;
    name: string;
    instructions?: string;
  }>;
};

export class PedidosYaNotConfiguredError extends Error {
  constructor(message = 'PedidosYa Courier no está configurado en el servidor') {
    super(message);
    this.name = 'PedidosYaNotConfiguredError';
  }
}

export class PedidosYaApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(message: string, status: number, body?: unknown) {
    super(message);
    this.name = 'PedidosYaApiError';
    this.status = status;
    this.body = body;
  }
}

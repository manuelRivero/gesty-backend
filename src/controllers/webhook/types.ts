import type {
  WhatsAppInteractiveMessage,
  WhatsAppListMessage,
} from '../../domain/intent/whatsappTemplates';
import { ConversationIntent } from '../../types/conversationIntent';
import { IntentDetectionResult } from '../../services/ai/detection.service';

// Payload de WhatsApp (sin cambios)
export interface WhatsAppWebhookPayload {
  entry: Array<{
    changes: Array<{
      value: {
        metadata: { phone_number_id: string };
        messages: Array<{
          from: string;
          type: string;
          id?: string;
          text?: { body: string };
          interactive?: {
            button_reply?: { id: string; title?: string };
            list_reply?: { id: string; title?: string };
          };
        }>;
      };
    }>;
  }>;
}

// Contexto base
export interface WebhookContext {
  payload: WhatsAppWebhookPayload;
  phoneNumberId: string;
  to: string;
  message: any;
  value: any;
  payloadId?: string;
}

// Contexto enriquecido con detección
// src/webhooks/types.ts

export interface EnrichedContext extends WebhookContext {
  detection: IntentDetectionResult;
  conversation: any;
  business: any;
  customer: any;
  conversationState: any;
  conversationId: string;
  coverageZone?: {        // ← Agregar opcional
    zone_id: string;
    zone_name: string;
    delivery_fee: number;
    min_order: number;
  };
}

export type HandlerFollowUp =
  | { type: 'image'; dataUrl: string }
  | { type: 'text'; message: string }
  | { type: 'list'; listMessage: WhatsAppListMessage }
  | { type: 'interactive'; message: WhatsAppInteractiveMessage };

// Resultado de handler
export interface HandlerResult {
  content: string | object;
  isInteractive: boolean;
  /** Mensajes extra tras el principal, en orden: imagen (QR), texto, lista, etc. */
  followUps?: HandlerFollowUp[];
}

// Clasificación de intención
export interface IntentClassification {
  intent: ConversationIntent;
  confidence: number;
  detectedProductName: string | null;
  quantity: number | null;
}

// === INTERFAZ PARA INTENCIONES ===
export interface IntentHandler {
  readonly command: string;
  canHandle(intent: string): boolean;
  execute(ctx: EnrichedContext, classification?: IntentClassification): Promise<HandlerResult | null>;
}

// Tipo unión para registro
export type WebhookHandler = IntentHandler;
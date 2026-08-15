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
          /** Voice note o audio adjunto (solo dueño, ver PLAN-ACCION-OWNER-AUDIO.md). */
          audio?: {
            id: string;
            mime_type?: string;
            voice?: boolean;
            sha256?: string;
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
  /**
   * Puede faltar cuando el contexto se construye para un turno delegado
   * desde una sesión de checkout/reservas/onboarding (H-01): esos nodos
   * deben adjuntar `detection` real antes de invocar al híbrido, o el
   * híbrido debe degradar seguro (skip CTA) si no está presente.
   */
  detection?: IntentDetectionResult;
  conversation: any;
  business: any;
  customer: any;
  conversationState: any;
  conversationId: string;
  coverageZone?: {
    zone_id: string;
    zone_name: string;
    delivery_fee: number;
    min_order: number;
  };
  /** Estado de dirección — propagado desde AgentState para el contexto del ReAct agent. */
  hasAddress?: boolean;
  isInCoverage?: boolean;
  /**
   * Ephemeral (solo este turno): party size acabó de confirmarse y se reanuda
   * la consulta de comida. No se persiste en conversation metadata.
   */
  partySizeJustConfirmed?: number;
}

export type HandlerFollowUp =
  | { type: 'image'; dataUrl: string; beforeContent?: boolean }
  | { type: 'text'; message: string }
  | { type: 'list'; listMessage: WhatsAppListMessage }
  | { type: 'interactive'; message: WhatsAppInteractiveMessage };

// Resultado de handler
export interface HandlerResult {
  content: string | object;
  isInteractive: boolean;
  /** Mensajes extra tras el principal, en orden: imagen (QR), texto, lista, etc. */
  followUps?: HandlerFollowUp[];
  /** Si true, no reescribir el body con LLM (p. ej. respuesta del agente híbrido). */
  skipBodyHumanization?: boolean;
}

// Clasificación de intención
export interface IntentClassification {
  intent: ConversationIntent;
  confidence: number;
  detectedProductName: string | null;
  quantity: number | null;
  /** Solo para MODIFY_QUANTITY: "absolute" ("quiero solamente 1") vs "decrease" ("quita 1"). */
  quantityMode?: 'absolute' | 'decrease' | null;
}

// === INTERFAZ PARA INTENCIONES ===
export interface IntentHandler {
  readonly command: string;
  canHandle(intent: string): boolean;
  execute(ctx: EnrichedContext, classification?: IntentClassification): Promise<HandlerResult | null>;
}

// Tipo unión para registro
export type WebhookHandler = IntentHandler;
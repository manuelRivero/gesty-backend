import type { z } from 'zod';
import { ConversationIntent } from '../../types/conversationIntent';
import type { WhatsAppListMessage } from './whatsappTemplates';
import { IntentEntitiesSchema, IntentResultSchema } from './intentValidator';

export type IntentEntities = z.infer<typeof IntentEntitiesSchema>;
export type IntentResult = z.infer<typeof IntentResultSchema>;
export { ConversationIntent };

// NUEVO: Sistema de confianza
export const CONFIDENCE_THRESHOLDS = {
  HIGH: 0.85,
  MEDIUM: 0.60,
  LOW: 0.40
} as const;

export type IntentDetectionResult =
  | {
      type: 'CONFIDENT';
      intent: ConversationIntent;
      confidence: number;
      allIntents: ConversationIntent[];
      responseType: 'TEXT';
      content: string;
      detectedProductName: string | null;
    }
  | {
      type: 'UNCERTAIN';
      candidates: Array<{ intent: ConversationIntent; confidence: number }>;
      originalMessage: string;
      responseType: 'LIST';
      listContent: WhatsAppListMessage;
      detectedProductName: string | null;
    };

export type ConfirmationState =
  | {
      status: 'awaiting_confirmation';
      candidates: Array<{ intent: ConversationIntent; label: string }>;
      originalMessage: string;
      expiresAt: Date;
    }
  | {
      status: 'normal';
    };

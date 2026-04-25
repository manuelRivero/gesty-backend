export interface WhatsAppMessage {
  from: string;
  to: string;
  message: string;
  timestamp?: Date;
  messageId?: string;
}

export interface WhatsAppWebhook {
  event: string;
  data: {
    from: string;
    to: string;
    message?: string;
    mediaUrl?: string;
    type: 'text' | 'image' | 'video' | 'audio' | 'document';
  };
}

export interface WhatsAppWebhookMessage {
  from: string;
  id?: string;
  timestamp?: string;
  type?: string;
  text?: {
    body?: string;
  };
  interactive?: {
    button_reply?: {
      id?: string;
      title?: string;
    };
    list_reply?: {
      id?: string;
      title?: string;
    };
  };
}

export interface WhatsAppWebhookStatus {
  id?: string;
  status?: string;
  timestamp?: string;
  recipient_id?: string;
}

export interface WhatsAppWebhookValue {
  messages?: WhatsAppWebhookMessage[];
  statuses?: WhatsAppWebhookStatus[];
  metadata?: {
    phone_number_id?: string;
  };
}

export interface WhatsAppWebhookPayload {
  entry?: Array<{
    changes?: Array<{
      value?: WhatsAppWebhookValue;
    }>;
  }>;
}

export interface SendMessageRequest {
  to: string;
  message: string;
  mediaUrl?: string;
}

export interface SendMessageResponse {
  success: boolean;
  messageId?: string;
  error?: string;
}


import axios, { AxiosError } from 'axios';
import type { WhatsAppInteractiveMessage, WhatsAppListMessage, WhatsAppListSection } from '../domain/intent/whatsappTemplates';
import { normalizeWhatsAppButtonInteractiveMessage } from './whatsappInteractiveButton.util';

export class WhatsAppSenderService {
  private readonly baseUrl = 'https://graph.facebook.com/v18.0';
  private readonly buttonLabelMaxLength = 20;
  private readonly whatsappTextMaxLength = 4096;
  private readonly truncationClosure =
    '\n\nSi queres, seguimos con opciones puntuales. Responde "si, adelante" o elegi una opcion.';

  private truncateLabel(value: string, maxLength = this.buttonLabelMaxLength): string {
    if (value.length <= maxLength) {
      return value;
    }
    return value.slice(0, maxLength);
  }

  private normalizeTextBodyForWhatsApp(message: string): {
    body: string;
    wasTruncated: boolean;
    originalLength: number;
  } {
    const trimmed = message.trim();
    const originalLength = trimmed.length;
    if (trimmed.length <= this.whatsappTextMaxLength) {
      return { body: trimmed, wasTruncated: false, originalLength };
    }

    const suffix = `\n\n...${this.truncationClosure}`;
    const max = this.whatsappTextMaxLength - suffix.length;
    return {
      body: `${trimmed.slice(0, max)}${suffix}`,
      wasTruncated: true,
      originalLength,
    };
  }

  private buildTruncationRecoveryInteractiveMessage(): WhatsAppInteractiveMessage {
    return {
      type: 'interactive',
      interactive: {
        type: 'button',
        header: { type: 'text', text: '' },
        body: { text: 'Como queres seguir?' },
        footer: { text: '' },
        action: {
          buttons: [
            {
              type: 'reply',
              reply: { id: 'VIEW_MENU', title: 'Ver menu' },
            },
            {
              type: 'reply',
              reply: { id: 'BUSINESS_HOURS', title: 'Horarios' },
            },
            {
              type: 'reply',
              reply: { id: 'VIEW_ORDER', title: 'Mi pedido' },
            },
          ],
        },
      },
    };
  }

  private normalizeRecipient(to: string): string {
    const digits = to.replace(/\D/g, '');
    // Ajuste para AR: remover el "9" después del "54" si existe (ej: 549... -> 54...)
    if (digits.startsWith('549')) {
      const withoutNine = `54${digits.slice(3)}`;
      // Si queda un 9 extra luego del código de área, eliminarlo (ej: 54934 9... -> 5434...)
      if (withoutNine.length > 12) {
        const rest = withoutNine.slice(2);
        const nineIndex = rest.indexOf('9');
        if (nineIndex >= 0) {
          return `54${rest.slice(0, nineIndex)}${rest.slice(nineIndex + 1)}`;
        }
      }
      return withoutNine;
    }

    if (digits.startsWith('54') && digits.length > 12) {
      const rest = digits.slice(2);
      const nineIndex = rest.indexOf('9');
      if (nineIndex >= 0) {
        return `54${rest.slice(0, nineIndex)}${rest.slice(nineIndex + 1)}`;
      }
    }

    return digits;
  }

  async sendTextMessage(params: {
    phoneNumberId: string;
    to: string;
    message: string;
  }): Promise<void> {
    const { phoneNumberId, to, message } = params;
    const normalizedTo = this.normalizeRecipient(to);
    const normalizedText = this.normalizeTextBodyForWhatsApp(message);
    const normalizedBody = normalizedText.body;

    if (normalizedText.wasTruncated) {
      console.warn(
        `[WhatsAppSender] Texto truncado para cumplir límite (${normalizedText.originalLength} -> ${normalizedBody.length})`
      );
    }

    try {
      await axios.post(
        `${this.baseUrl}/${phoneNumberId}/messages`,
        {
          messaging_product: 'whatsapp',
          to: normalizedTo,
          type: 'text',
          text: {
            body: normalizedBody
          }
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`
          }
        }
      );

      if (normalizedText.wasTruncated) {
        await this.sendButtonMessage({
          phoneNumberId,
          to,
          interactiveMessage: this.buildTruncationRecoveryInteractiveMessage(),
        });
      }
    } catch (error) {
      const axiosError = error as AxiosError;
      const status = axiosError.response?.status;
      const data = axiosError.response?.data;

      const messageDetail =
        typeof data === 'string' ? data : JSON.stringify(data ?? {});

      throw new Error(
        `Error al enviar mensaje WhatsApp: ${status ?? 'sin_status'} ${messageDetail}`
      );
    }
  }

  async sendInteractiveMenu(params: {
    phoneNumberId: string;
    to: string;
    text: string;
    buttons: {
      title: string;
      payload: string;
      description?: string;
      sectionTitle?: string;
    }[];
    actionButtonLabel?: string;
    forceList?: boolean;
    page?: number;
    totalPages?: number;
  }): Promise<void> {
    const {
      phoneNumberId,
      to,
      text,
      buttons,
      actionButtonLabel,
      forceList,
      page,
      totalPages
    } = params;
    const normalizedTo = this.normalizeRecipient(to);

    const sanitizedForButtons = buttons
      .filter((b) => {
        const p = typeof b.payload === 'string' ? b.payload.trim() : '';
        const t = typeof b.title === 'string' ? b.title.trim() : '';
        return Boolean(p && t && p.length < 256);
      })
      .slice(0, 3);

    const isButton = !forceList && sanitizedForButtons.length > 0 && sanitizedForButtons.length <= 3;
    const bodyText =
      page && totalPages
        ? `${text}\n\nPágina ${page} de ${totalPages}`
        : text;

    const sections = new Map<
      string,
      { id: string; title: string; description?: string }[]
    >();

    for (const button of buttons) {
      const sectionTitle = button.sectionTitle ?? 'Categorías';
      const rows = sections.get(sectionTitle) ?? [];
      rows.push({
        id: button.payload,
        title: button.title,
        ...(button.description ? { description: button.description } : {})
      });
      sections.set(sectionTitle, rows);
    }

    const interactive = isButton
      ? {
        type: 'button' as const,
        body: { text: bodyText },
        action: {
          buttons: sanitizedForButtons.map((button) => ({
            type: 'reply' as const,
            reply: {
              id: button.payload.trim(),
              title: this.truncateLabel(button.title)
            }
          }))
        }
      }
      : {
        type: 'list' as const,
        body: { text: bodyText },
        action: {
          button: this.truncateLabel(actionButtonLabel ?? 'Ver categorias'),
          sections: Array.from(sections.entries()).map(([title, rows]) => ({
            title,
            rows: rows.map((row) => ({
              ...row,
              title: this.truncateLabel(row.title)
            }))
          }))
        }
      };

    let interactiveToSend = interactive;
    if (isButton && interactive.type === 'button') {
      const fullMsg: WhatsAppInteractiveMessage = {
        type: 'interactive',
        interactive: {
          type: 'button',
          header: { type: 'text', text: '' },
          body: interactive.body,
          footer: { text: '' },
          action: interactive.action
        }
      };
      const norm = normalizeWhatsAppButtonInteractiveMessage(fullMsg);
      if (!norm.success) {
        console.log(
          'BUTTON PAYLOAD (fallback from sendInteractiveMenu):',
          JSON.stringify(fullMsg, null, 2)
        );
        await this.sendTextMessage({
          phoneNumberId,
          to,
          message: norm.fallbackText
        });
        return;
      }
      interactiveToSend = norm.message.interactive;
      console.log(
        'BUTTON PAYLOAD:',
        JSON.stringify(
          {
            messaging_product: 'whatsapp',
            to: normalizedTo,
            type: 'interactive',
            interactive: interactiveToSend
          },
          null,
          2
        )
      );
    }

    try {
      await axios.post(
        `${this.baseUrl}/${phoneNumberId}/messages`,
        {
          messaging_product: 'whatsapp',
          to: normalizedTo,
          type: 'interactive',
          interactive: interactiveToSend
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`
          }
        }
      );
    } catch (error) {
      const axiosError = error as AxiosError;
      const status = axiosError.response?.status;
      const data = axiosError.response?.data;

      const messageDetail =
        typeof data === 'string' ? data : JSON.stringify(data ?? {});

      throw new Error(
        `Error al enviar mensaje WhatsApp: ${status ?? 'sin_status'} ${messageDetail}`
      );
    }
  }

  async sendInteractiveMessage(params: {
    phoneNumberId: string;
    to: string;
    messageObject: WhatsAppInteractiveMessage
  }): Promise<void> {
    const {
      phoneNumberId,
      to,
      messageObject
    } = params;
    const normalizedTo = this.normalizeRecipient(to);
    try {
      await axios.post(
        `${this.baseUrl}/${phoneNumberId}/messages`,
        {
          messaging_product: 'whatsapp',
          to: normalizedTo,
          ...messageObject
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`
          }
        }
      );
    } catch (error) {
      const axiosError = error as AxiosError;
      const status = axiosError.response?.status;
      const data = axiosError.response?.data;

      const messageDetail =
        typeof data === 'string' ? data : JSON.stringify(data ?? {});

      throw new Error(
        `Error al enviar mensaje WhatsApp: ${status ?? 'sin_status'} ${messageDetail}`
      );
    }
  }

  async sendResponse(params: {
    phoneNumberId: string;
    to: string;
    content: string | WhatsAppListMessage | WhatsAppInteractiveMessage;
  }): Promise<void> {
    const { phoneNumberId, to, content } = params;
    if (typeof content === 'string') {
      await this.sendTextMessage({ phoneNumberId, to, message: content });
      return;
    }

    if (content.type === 'list') {
      const textParts = [
        content.header?.text,
        content.body?.text,
        content.footer?.text
      ].filter(Boolean);
      const text = textParts.join('\n\n');

      const buttons =
        content.action.sections?.flatMap((section) =>
          section.rows.map((row) => ({
            title: row.title,
            payload: row.id,
            description: row.description,
            sectionTitle: section.title
          }))
        ) ?? [];

      await this.sendInteractiveMenu({
        phoneNumberId,
        to,
        text,
        buttons,
        actionButtonLabel: content.action.button,
        forceList: true
      });
    }
    if (content.type === 'interactive') {
      await this.sendInteractiveMessage({
        phoneNumberId,
        to,
        messageObject: content
      });
    }
  }


  // Metodos nuevos separados por responsabilidad

  async sendListMessage(params: {
    phoneNumberId: string;
    to: string;
    listMessage: WhatsAppListMessage;
  }): Promise<void> {
    const { phoneNumberId, to, listMessage } = params;

    // Reutilizar la lógica que ya tenías en sendResponse
    const textParts = [
      listMessage.header?.text,
      listMessage.body?.text,
      listMessage.footer?.text
    ].filter(Boolean);

    const text = textParts.join('\n\n');

    const buttons = listMessage.action.sections?.flatMap((section) =>
      section.rows.map((row) => ({
        title: row.title,
        payload: row.id,
        description: row.description,
        sectionTitle: section.title
      }))
    ) ?? [];

    await this.sendInteractiveMenu({
      phoneNumberId,
      to,
      text,
      buttons,
      actionButtonLabel: listMessage.action.button,
      forceList: true
    });
  }

  async sendButtonMessage(params: {
    phoneNumberId: string;
    to: string;
    interactiveMessage: WhatsAppInteractiveMessage;
  }): Promise<void> {
    if (params.interactiveMessage.interactive.type !== 'button') {
      throw new Error('sendButtonMessage solo acepta interactive.type === "button"');
    }

    const normalized = normalizeWhatsAppButtonInteractiveMessage(
      params.interactiveMessage
    );
    const normalizedTo = this.normalizeRecipient(params.to);

    if (!normalized.success) {
      console.log(
        'BUTTON PAYLOAD (fallback, invalid/empty buttons):',
        JSON.stringify(params.interactiveMessage, null, 2)
      );
      await this.sendTextMessage({
        phoneNumberId: params.phoneNumberId,
        to: params.to,
        message: normalized.fallbackText
      });
      return;
    }

    const payload = {
      messaging_product: 'whatsapp' as const,
      to: normalizedTo,
      ...normalized.message
    };
    console.log('BUTTON PAYLOAD:', JSON.stringify(payload, null, 2));

    try {
      await axios.post(
        `${this.baseUrl}/${params.phoneNumberId}/messages`,
        payload,
        {
          headers: {
            Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`
          }
        }
      );
    } catch (error) {
      const axiosError = error as AxiosError;
      const status = axiosError.response?.status;
      const data = axiosError.response?.data;

      const messageDetail =
        typeof data === 'string' ? data : JSON.stringify(data ?? {});

      throw new Error(
        `Error al enviar mensaje WhatsApp: ${status ?? 'sin_status'} ${messageDetail}`
      );
    }
  }

  private async uploadImageDataUrl(
    phoneNumberId: string,
    dataUrl: string
  ): Promise<string> {
    const token = process.env.WHATSAPP_ACCESS_TOKEN;
    if (!token) {
      throw new Error("WHATSAPP_ACCESS_TOKEN no está definida");
    }

    const match = dataUrl.match(/^data:(image\/[\w+.-]+);base64,(.+)$/);
    if (!match) {
      throw new Error("data URL de imagen inválida");
    }

    const mime = match[1];
    const base64 = match[2];
    const buffer = Buffer.from(base64, "base64");
    const formData = new FormData();
    formData.append("messaging_product", "whatsapp");
    formData.append("type", mime);
    const blob = new Blob([buffer], { type: mime });
    formData.append("file", blob, "qr.png");

    const res = await fetch(
      `${this.baseUrl}/${phoneNumberId}/media`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: formData
      }
    );

    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`Error subiendo imagen a WhatsApp: ${res.status} ${detail}`);
    }

    const json = (await res.json()) as { id: string };
    if (!json.id) {
      throw new Error("Respuesta de media sin id");
    }
    return json.id;
  }

  async sendImageFromDataUrl(params: {
    phoneNumberId: string;
    to: string;
    dataUrl: string;
  }): Promise<void> {
    const { phoneNumberId, to, dataUrl } = params;
    const normalizedTo = this.normalizeRecipient(to);
    const mediaId = await this.uploadImageDataUrl(phoneNumberId, dataUrl);

    try {
      await axios.post(
        `${this.baseUrl}/${phoneNumberId}/messages`,
        {
          messaging_product: "whatsapp",
          to: normalizedTo,
          type: "image",
          image: { id: mediaId }
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`
          }
        }
      );
    } catch (error) {
      const axiosError = error as AxiosError;
      const status = axiosError.response?.status;
      const data = axiosError.response?.data;
      const messageDetail =
        typeof data === "string" ? data : JSON.stringify(data ?? {});
      throw new Error(
        `Error al enviar imagen WhatsApp: ${status ?? "sin_status"} ${messageDetail}`
      );
    }
  }
}

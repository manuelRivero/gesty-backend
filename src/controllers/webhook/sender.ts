// src/controllers/webhook/sender.ts
import { WhatsAppSenderService } from '../../services/whatsappSender.service';
import { WebhookContext, HandlerResult, HandlerFollowUp } from './types';
import { WhatsAppListMessage, WhatsAppInteractiveMessage } from '../../domain/intent/whatsappTemplates';

const sender = new WhatsAppSenderService();

const normalizeArgentinaRecipient = (to: string): string => {
  const digits = to.replace(/\D/g, '');
  if (digits.startsWith('549')) {
    const withoutNine = `54${digits.slice(3)}`;
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
};

/**
 * Envía el mensaje principal del handler y, si hay {@link HandlerResult.followUps},
 * los mensajes adicionales en orden (texto, imagen —p. ej. QR de reserva—, lista, etc.).
 * No está acoplado al QR: el nombre antiguo `sendResponseWithQrSequence` era engañoso.
 */
export const sendResponse = async (
  ctx: WebhookContext,
  result: HandlerResult
): Promise<void> => {
  console.log('[SendResponse] Sending response:', result);

  const followUps = result.followUps ?? [];
  const beforeImages = followUps.filter(
    (follow): follow is Extract<HandlerFollowUp, { type: 'image' }> =>
      follow.type === 'image' && follow.beforeContent === true
  );
  const afterFollowUps = followUps.filter(
    (follow) => !(follow.type === 'image' && follow.beforeContent === true)
  );

  for (const follow of beforeImages) {
    await sender.sendImageFromDataUrl({
      phoneNumberId: ctx.phoneNumberId,
      to: ctx.to,
      dataUrl: follow.dataUrl,
    });
  }

  if (!result.isInteractive) {
    await sender.sendTextMessage({
      phoneNumberId: ctx.phoneNumberId,
      to: ctx.to,
      message: result.content as string
    });
  } else {
    const message = result.content;

    if ((message as WhatsAppListMessage).type === 'list') {
      await sender.sendListMessage({
        phoneNumberId: ctx.phoneNumberId,
        to: ctx.to,
        listMessage: message as WhatsAppListMessage
      });
    } else {
      await sender.sendButtonMessage({
        phoneNumberId: ctx.phoneNumberId,
        to: ctx.to,
        interactiveMessage: message as WhatsAppInteractiveMessage
      });
    }
  }

  if (!afterFollowUps.length) {
    return;
  }

  for (const follow of afterFollowUps) {
    if (follow.type === 'image') {
      await sender.sendImageFromDataUrl({
        phoneNumberId: ctx.phoneNumberId,
        to: ctx.to,
        dataUrl: follow.dataUrl
      });
    } else if (follow.type === 'text') {
      await sender.sendTextMessage({
        phoneNumberId: ctx.phoneNumberId,
        to: ctx.to,
        message: follow.message
      });
    } else if (follow.type === 'list') {
      await sender.sendListMessage({
        phoneNumberId: ctx.phoneNumberId,
        to: ctx.to,
        listMessage: follow.listMessage
      });
    } else if (follow.type === 'interactive') {
      await sender.sendButtonMessage({
        phoneNumberId: ctx.phoneNumberId,
        to: ctx.to,
        interactiveMessage: follow.message
      });
    }
  }
};

/** @deprecated Usar {@link sendResponse}: ya envía followUps (QR, texto, listas). */
export const sendResponseWithQrSequence = sendResponse;

export const sendResponseNoContext = async (
  phoneNumberId: string,
  to: string,
  result: string
): Promise<void> => {
  console.log('[SendResponse] Sending response:', result);
  
  await sender.sendTextMessage({
    phoneNumberId: phoneNumberId,
    to: normalizeArgentinaRecipient(to),
    message: result
  });
};

export const sendListResponseNoContext = async (
  phoneNumberId: string,
  to: string,
  listMessage: WhatsAppListMessage
): Promise<void> => {
  console.log('[SendResponse] Sending list response');

  await sender.sendListMessage({
    phoneNumberId: phoneNumberId,
    to: normalizeArgentinaRecipient(to),
    listMessage
  });
};
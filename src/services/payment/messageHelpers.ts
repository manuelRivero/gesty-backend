import { WhatsAppSenderService } from '../whatsappSender.service';

const sender = new WhatsAppSenderService();

export const sendTextMessageNoCtx = async (
  phoneNumberId: string,
  to: string,
  message: string
): Promise<void> => {
  await sender.sendTextMessage({ phoneNumberId, to, message });
};

export const sendImageMessageNoCtx = async (
  phoneNumberId: string,
  to: string,
  dataUrl: string
): Promise<void> => {
  await sender.sendImageFromDataUrl({ phoneNumberId, to, dataUrl });
};

// services/conversationService.ts

import { business, conversation } from "@prisma/client";
import { WhatsAppWebhookPayload } from "../controllers/webhook/types";
import { createConversationMessage, createOrGetOpenConversation, findBusinessByPhoneNumberId, findOrCreateConversationState, findOrCreateCustomer, updateConversationLastMessageAt, updateConversationState, closeConversation } from "../repositories";

export const buildEndConversationMessage = async (
    conversation: conversation
): Promise<string | null> => {
    await closeConversation(conversation.id);

    const messageText = '¡Gracias por tu consulta! Si necesitás algo más, escribime. 👋';
    await createConversationMessage(conversation.id, 'ai', messageText, false);

    return messageText;
};

export const handleEndConversationFromWebhook = async (
    payload: WhatsAppWebhookPayload
): Promise<string | null> => {

    const entry = payload.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const message = value?.messages?.[0];
    const from = message?.from;
    const phoneNumberId = value?.metadata?.phone_number_id;

    if (!phoneNumberId || !from) return null;

    const business = await findBusinessByPhoneNumberId(phoneNumberId);
    if (!business) return null;

    const customer = await findOrCreateCustomer(business.id, from);
    const conversation = await createOrGetOpenConversation(business.id, customer.id);

    return await buildEndConversationMessage(conversation);
};

// services/conversationService.ts

export const buildAskQuestionMessage = async (
    business: business,
    conversation: conversation
): Promise<string | null> => {

    await updateConversationState(conversation.id, {
        metadata: { awaitingQuestion: true }
    });

    const messageText = '¡Perfecto! Escribí tu pregunta y te respondo enseguida. 🤔';
    await createConversationMessage(conversation.id, 'ai', messageText, false);
    await updateConversationLastMessageAt(conversation.id);

    return messageText;
};

export const handleAskQuestionFromWebhook = async (
    payload: WhatsAppWebhookPayload
): Promise<string | null> => {

    const entry = payload.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const message = value?.messages?.[0];
    const from = message?.from;
    const phoneNumberId = value?.metadata?.phone_number_id;

    if (!phoneNumberId || !from) return null;

    const business = await findBusinessByPhoneNumberId(phoneNumberId);
    if (!business) return null;

    const customer = await findOrCreateCustomer(business.id, from);
    const conversation = await createOrGetOpenConversation(business.id, customer.id);
    await findOrCreateConversationState(conversation.id);
    return await buildAskQuestionMessage(business, conversation);
};
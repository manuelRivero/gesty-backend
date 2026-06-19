import { formatBotUserMessage } from '../services/productQuery/utils';

export const workerTextMessages = {
  draftOrderReminder: (minutes: number) =>
    formatBotUserMessage(
      'Pedido en curso',
      '🛒',
      `Tenés un pedido en curso.\n\nSi no finalizás tu compra en ${minutes} minutos, tu pedido será cancelado automáticamente.`
    ),
  draftOrderReminderListBody: (minutes: number) =>
    formatBotUserMessage(
      'Pedido en curso',
      '🛒',
      `Tenés un pedido en curso.\n\nSi no finalizás tu compra en ${minutes} minutos, tu pedido será cancelado automáticamente.\n\n¿Querés continuar?`
    ),
  draftOrderExpiredListBody: formatBotUserMessage(
    'Pedido cancelado',
    '⏰',
    'Tu pedido fue cancelado por inactividad.\n\nPodés iniciar uno nuevo cuando quieras.\n\n¿Querés volver a empezar?'
  ),
  conversationIdleReminderListBody: (minutes: number) =>
    formatBotUserMessage(
      '¿Seguís ahí?',
      '⏳',
      `Si no respondés en ${minutes} minutos, cerraremos la conversación por inactividad.\n\n¿Querés continuar?`
    ),
  conversationIdleClosed: formatBotUserMessage(
    'Conversación finalizada',
    '✅',
    'Conversación finalizada por inactividad.\n\nPodés escribirnos cuando quieras.'
  ),
} as const;

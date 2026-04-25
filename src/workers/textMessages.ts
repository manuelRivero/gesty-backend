export const workerTextMessages = {
  draftOrderReminder: (minutes: number) =>
    `*Tienes un pedido en curso.* 🛒\n\nSi no finalizas tu compra en ${minutes} minutos, tu pedido será cancelado automáticamente.*`,
  draftOrderReminderListBody: (minutes: number) =>
    `*Tienes un pedido en curso.* 🛒\n\nSi no finalizas tu compra en ${minutes} minutos, tu pedido será cancelado automáticamente.\n\n*¿Querés continuar?*`,
  draftOrderExpiredListBody:
    '*Tu pedido fue cancelado por inactividad.* ⏰\n\nPodés iniciar uno nuevo cuando quieras.\n\n¿Querés volver a empezar?*',
  conversationIdleReminderListBody: (minutes: number) =>
    `*¿Seguís ahí?* ⏳\n\nSi no respondés en ${minutes} minutos, cerraremos la conversación por inactividad.\n\n*¿Querés continuar?*`,
  conversationIdleClosed:
    '*Conversación finalizada por inactividad.* ✅\n\nPodés escribirnos cuando quieras.',
} as const;

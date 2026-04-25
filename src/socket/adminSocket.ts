/**
 * Stub no-op del socket admin del backend original.
 *
 * El proyecto food-service-agent NO incluye el panel admin ni Socket.IO.
 * Los servicios portados (`whatsapp.service`, `order.service`,
 * `repositories/conversationMessage`, `repositories/reservation`) llaman a
 * estas funciones para emitir eventos en tiempo real al panel; aquí las
 * dejamos como no-op para preservar 1:1 la lógica sin acoplar al canal de
 * sockets.
 */

export function emitAdminOrderCreated(
  _businessId: string,
  _payload: { orderId: string; total: string; currency: string }
): void {
  // intentionally empty
}

export function emitAdminOrderStatusChanged(
  _businessId: string,
  _payload: { orderId: string; status: string }
): void {
  // intentionally empty
}

export function emitAdminOrderPaymentStatusChanged(
  _businessId: string,
  _payload: { orderId: string; payment_status: string }
): void {
  // intentionally empty
}

export function emitAdminReservationCreated(
  _businessId: string,
  _payload: { reservationId: string }
): void {
  // intentionally empty
}

export function emitAdminReservationCancelled(
  _businessId: string,
  _payload: { reservationId: string; status: string }
): void {
  // intentionally empty
}

export function emitAdminReservationEditStarted(
  _businessId: string,
  _payload: { reservationId: string }
): void {
  // intentionally empty
}

export function emitAdminWhatsappMessageCreated(
  _businessId: string,
  _payload: {
    conversationId: string;
    messageId: string;
    sender: string;
    message: string;
    isAiGenerated: boolean;
    createdAt: string;
  }
): void {
  // intentionally empty
}

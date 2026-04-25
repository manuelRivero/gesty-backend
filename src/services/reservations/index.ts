/**
 * API pública del flujo de reservas (WhatsApp).
 * Tipos (`./types`) y helpers (`./utils`) son internos del módulo; no reexportarlos aquí.
 *
 * Compatibilidad: `import { ... } from '../services/reservation.service'` sigue igual vía reexport.
 */
export {
  handleReservationIntent,
  handleViewQrIntent,
  handleViewReservationIntent,
} from './reservation.service';

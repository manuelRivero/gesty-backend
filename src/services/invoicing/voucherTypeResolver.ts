import type { CondicionIva, FiscalVoucherType } from "../../domain/invoicing/types";

/**
 * Determina el tipo de comprobante a partir de la condición de IVA del emisor.
 *
 * Simplificación explícita: hoy Gesty no captura CUIT/condición de IVA del receptor en el
 * checkout (ver limitaciones en el informe final), así que se asume receptor Consumidor Final.
 * Un emisor Responsable Inscripto que vende a un receptor también RI debería emitir Factura A —
 * ese caso queda fuera de este resolver hasta que el checkout capture datos fiscales del cliente.
 */
export function resolveVoucherTypeForConsumidorFinal(
  condicionIva: CondicionIva
): FiscalVoucherType | null {
  switch (condicionIva) {
    case "RI":
      return "B";
    case "MONOTRIBUTO":
    case "EXENTO":
      return "C";
    default:
      return null;
  }
}

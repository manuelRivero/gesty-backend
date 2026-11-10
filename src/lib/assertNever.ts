/**
 * Exhaustividad en tiempo de compilación para `switch`/`if` sobre uniones
 * (p. ej. `FulfillmentType`): si se agrega un valor nuevo al tipo y algún
 * caller no actualiza su `switch`, TypeScript marca error en el `default`
 * (el valor ya no es `never`) en vez de dejar que el valor nuevo caiga
 * silenciosamente en una rama existente — el bug concreto que motivó este
 * helper (ver `orderWorkflow.ts`, `tools/index.ts`, `publicOrders.service.ts`
 * antes de agregar `DINE_IN` a `FulfillmentType`).
 */
export function assertNever(value: never): never {
  throw new Error(`Valor no manejado en switch exhaustivo: ${JSON.stringify(value)}`);
}

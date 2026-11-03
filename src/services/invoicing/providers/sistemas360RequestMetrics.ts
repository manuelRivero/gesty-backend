import { prisma } from "../../../lib/prisma";
import { recordProviderRequest } from "../invoicingUsage.service";

const PROVIDER = "sistemas360";

/**
 * Único punto de instrumentación de requests reales contra Sistemas 360 (FASE: hallazgo crítico
 * "instrumentación real de requests"). Se llama desde el transporte HTTP (`sistemas360Client.ts`:
 * `request()` y `sistemas360DescargarPdf`), nunca desde los callers — así ningún método nuevo del
 * adaptador puede "olvidarse" de contabilizar.
 *
 * Dos niveles, deliberadamente separados:
 * - Total de cuenta (`invoicing_central_provider_config.total_requests_count`): SIEMPRE se
 *   incrementa — es el consumo real contra la cuenta compartida, exista o no `business_id`.
 * - Atribución por negocio (`invoicing_usage_period.provider_requests`, `recordProviderRequest`
 *   ya existente): solo si se pasa `businessId` — nunca se inventa una atribución.
 *
 * Nunca se llama dos veces para la misma request HTTP: cada función exportada de
 * `sistemas360Client.ts` llama a `fetch` exactamente una vez, y este helper se invoca una sola
 * vez inmediatamente después de esa llamada (haya tenido éxito o no).
 */
export async function recordSistemas360Request(businessId?: string): Promise<void> {
  await prisma.invoicing_central_provider_config
    .updateMany({
      where: { provider: PROVIDER },
      data: { total_requests_count: { increment: 1 } },
    })
    .catch((err) => {
      console.error("[Invoicing] Error registrando consumo técnico de Sistemas 360 (cuenta):", err);
    });

  if (businessId) {
    await recordProviderRequest(businessId).catch((err) => {
      console.error("[Invoicing] Error registrando consumo técnico de Sistemas 360 (negocio):", err);
    });
  }
}

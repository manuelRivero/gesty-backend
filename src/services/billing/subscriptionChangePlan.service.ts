import type { subscription } from "@prisma/client";
import Stripe from "stripe";
import { prisma } from "../../lib/prisma";
import { getStripe } from "./stripe.client";
import { findActivePlanByCode } from "./planCatalog.service";
import { upsertSubscriptionFromStripe } from "./stripeSubscriptionSync.service";
import type { StripeSubscriptionLike } from "./mapStripeSubscription";
import { classifySubscriptionLifecycle } from "./subscriptionLifecycle.service";
import { SUBSCRIPTION_LIFECYCLE_NAMESPACE, withBillingLock } from "./billingLock";
import { reconcileLiveSubscription } from "./subscriptionReconcile.service";
import { comparePlans, type ComparablePlan } from "./planComparison";
import {
  buildPreservedActivePhase,
  detectUnsupportedPhaseConfig,
} from "./subscriptionSchedulePhase";

/**
 * Cambio de plan owner-facing. Política de producto (ya decidida, no se
 * discute acá):
 *   - Upgrade (plan destino domina al actual en capacidades y precio):
 *     inmediato, con prorrateo de Stripe facturado ya
 *     (`proration_behavior: "always_invoice"` — `create_prorations` solo
 *     CREA el ítem de prorrateo, no lo factura ni intenta cobrarlo;
 *     `always_invoice` es la opción que efectivamente intenta cobrar
 *     ahora, según la documentación de Stripe).
 *   - Downgrade (plan actual domina al destino): programado para el fin
 *     del período vigente, vía Stripe Subscription Schedule — nunca reduce
 *     derechos de acceso antes de esa fecha, nunca crea una suscripción
 *     paralela.
 *   - Si ningún plan domina al otro (capacidades distintas sin relación de
 *     orden clara, ej. más cuota de IA pero sin Shopping vs. menos cuota
 *     pero con Shopping) — ver `planComparison.ts` — se rechaza el cambio
 *     en vez de adivinar si es upgrade o downgrade.
 *
 * NUNCA usa una Checkout Session nueva para esto — `createCheckoutSession`
 * (`stripeCheckout.service.ts`) sigue siendo exclusivo para "no tengo
 * ninguna suscripción vigente todavía".
 *
 * Coordinación distribuida: toda la función corre bajo `withBillingLock`
 * (`billingLock.ts`), mismo namespace que `cancelOwnerSubscription`,
 * `reactivateSubscription` y el handler de webhooks de
 * `customer.subscription.*` — así una mutación directa y un webhook para
 * el mismo negocio nunca se pisan. El lock se sostiene durante la
 * relectura+reconciliación contra Stripe (`reconcileLiveSubscription`), la
 * validación, la llamada a Stripe que efectivamente cambia el plan, y la
 * persistencia local — nunca solo durante la lectura inicial (ese era el
 * problema del `pg_advisory_xact_lock` anterior, que se liberaba al cerrar
 * la transacción de lectura, mucho antes de tocar Stripe).
 *
 * No hay una tabla de "intentos" para esta operación: a diferencia del
 * checkout inicial (donde el riesgo real era crear DOS filas/sesiones para
 * un negocio que no tenía ninguna), acá siempre existe una única fila
 * `subscription` por negocio y un único objeto de suscripción en Stripe —
 * el riesgo de duplicar no es "¿se creó dos veces algo nuevo?" sino "¿dos
 * requests concurrentes decidieron sobre un estado que ya cambió?", y eso
 * lo resuelve el lock. Además, un Subscription Schedule creado con
 * `from_subscription` falla explícitamente si la suscripción ya tiene uno
 * — ese rechazo de Stripe (no una tabla propia) es la protección contra
 * crear dos schedules para la misma suscripción.
 */

type ImmediateOutcome = "immediate_paid" | "immediate_payment_pending";
type ChangePlanOutcome = {
  subscription: subscription;
  billing: ImmediateOutcome | "scheduled";
};

function indeterminateChangePlanError() {
  return Object.assign(
    new Error(
      "No se pudo confirmar si el cambio de plan se aplicó en Stripe. Verificá el estado de tu suscripción antes de reintentar."
    ),
    { status: 503 }
  );
}

function isTransientStripeError(err: unknown): boolean {
  return (
    err instanceof Stripe.errors.StripeConnectionError ||
    err instanceof Stripe.errors.StripeAPIError ||
    err instanceof Stripe.errors.StripeRateLimitError ||
    err instanceof Stripe.errors.StripeIdempotencyError
  );
}

function extractScheduleId(
  schedule: string | Stripe.SubscriptionSchedule | null | undefined
): string | null {
  if (!schedule) return null;
  return typeof schedule === "string" ? schedule : schedule.id;
}

function ambiguousPlanOrderError(a: string, b: string) {
  return Object.assign(
    new Error(
      `No existe un orden definido entre los planes "${a}" y "${b}" (capacidades distintas sin que uno sea un superconjunto del otro). ` +
        "Este cambio no se puede clasificar automáticamente como upgrade o downgrade. Contactá a soporte."
    ),
    { status: 409 }
  );
}

export async function changeSubscriptionPlan(
  businessId: string,
  targetPlanCode: string
): Promise<ChangePlanOutcome> {
  const stripe = getStripe();
  if (!stripe) {
    throw Object.assign(new Error("Stripe no configurado"), { status: 503 });
  }

  const targetPlan = await findActivePlanByCode(targetPlanCode);
  if (!targetPlan?.stripe_price_id) {
    throw Object.assign(new Error("Plan no disponible para suscripción"), {
      status: 400,
    });
  }

  return withBillingLock(SUBSCRIPTION_LIFECYCLE_NAMESPACE, businessId, async () => {
    const { local: sub, remote: reconciledRemote } = await reconcileLiveSubscription(
      stripe,
      businessId
    );
    const state = classifySubscriptionLifecycle(sub);

    if (state === "none") {
      throw Object.assign(
        new Error("Este negocio no tiene una suscripción vigente. Iniciá un checkout nuevo."),
        { status: 409 }
      );
    }
    if (state === "past_due") {
      throw Object.assign(
        new Error(
          "La suscripción tiene un pago pendiente de regularizar. Resolvé ese pago antes de cambiar de plan."
        ),
        { status: 409 }
      );
    }
    if (state === "expired" || state === "unknown") {
      throw Object.assign(
        new Error("Esta suscripción ya no está vigente. Iniciá un checkout nuevo."),
        { status: 409 }
      );
    }

    const current = sub as subscription;
    const stripeSubscriptionId = current.stripe_subscription_id as string;

    if (!current.plan_id) {
      throw Object.assign(
        new Error("No se pudo resolver el plan actual de la suscripción."),
        { status: 409 }
      );
    }
    const currentPlan = await prisma.plan.findUnique({ where: { id: current.plan_id } });
    if (!currentPlan) {
      throw Object.assign(
        new Error("No se pudo resolver el plan actual de la suscripción."),
        { status: 409 }
      );
    }
    if (currentPlan.code === targetPlan.code) {
      throw Object.assign(new Error("Ya estás en ese plan."), { status: 400 });
    }

    const comparison = comparePlans(
      currentPlan as ComparablePlan,
      targetPlan as ComparablePlan
    );
    if (comparison === "ambiguous") {
      throw ambiguousPlanOrderError(currentPlan.code, targetPlan.code);
    }
    if (comparison === "equal") {
      // Mismas capacidades, mismo precio, código distinto: no hay nada que
      // cambie en los hechos — tratarlo como "ya estás en ese plan" en vez
      // de forzar una dirección (upgrade/downgrade) arbitraria.
      throw Object.assign(
        new Error("Ya estás en un plan equivalente."),
        { status: 400 }
      );
    }
    const isUpgrade = comparison === "b_is_upgrade"; // b = targetPlan

    if (!isUpgrade && state === "active_canceling") {
      // Combinar un downgrade programado con una cancelación ya programada
      // es ambiguo (¿gana el downgrade o la cancelación?) y Stripe no separa
      // limpiamente ambos mecanismos cuando coexisten. Se pide una decisión
      // explícita del usuario en vez de elegir en su nombre.
      throw Object.assign(
        new Error(
          "Esta suscripción tiene una cancelación programada. Reactivala primero si querés programar un downgrade."
        ),
        { status: 409 }
      );
    }

    // `reconcileLiveSubscription` ya retiró el estado remoto actual bajo el
    // lock — se reutiliza ese mismo objeto en vez de volver a pedirlo
    // (evita una segunda llamada a Stripe redundante y, sobre todo, evita
    // decidir sobre una segunda lectura que podría no coincidir con la que
    // ya se usó para clasificar el estado).
    const remote = reconciledRemote;
    if (!remote) {
      throw indeterminateChangePlanError();
    }

    if (isUpgrade) {
      return applyUpgrade(stripe, businessId, current, remote, targetPlan);
    }
    return scheduleDowngrade(stripe, businessId, current, remote, targetPlan);
  });
}

async function reconcileFromRemote(
  stripe: Stripe,
  businessId: string,
  stripeSubscriptionId: string
): Promise<subscription | null> {
  try {
    const remote = await stripe.subscriptions.retrieve(stripeSubscriptionId);
    await upsertSubscriptionFromStripe(
      remote as unknown as StripeSubscriptionLike,
      businessId
    );
    return prisma.subscription.findUnique({ where: { business_id: businessId } });
  } catch {
    return null;
  }
}

/**
 * Determina si la prorrata del upgrade quedó efectivamente pagada, con
 * evidencia del objeto `invoice` — nunca a partir de que la suscripción
 * haya quedado en `active`/`trialing`. Con `proration_behavior:
 * "always_invoice"`, Stripe puede aplicar el cambio de precio y responder
 * 200 aunque el cobro de esa factura falle o quede pendiente (ej. 3DS,
 * fondos insuficientes con reintento async) — el estado de la
 * SUSCRIPCIÓN no siempre refleja eso de inmediato. Si no hay evidencia
 * suficiente (no se pudo expandir/leer la factura), nunca se devuelve
 * `"immediate_paid"`.
 *
 * Esto NO cambia la política de acceso: `evaluateBusinessBillingAccess`
 * sigue derivando el acceso exclusivamente de `subscription.status` en la
 * base local (sincronizado desde el `status` que Stripe ya decidió para la
 * suscripción). Esta función solo decide qué es HONESTO informarle al
 * admin sobre el resultado del pago de la prorrata — no otorga ni quita
 * acceso.
 */
function resolveImmediateBilling(updated: Stripe.Subscription): ImmediateOutcome {
  const invoice = updated.latest_invoice;
  if (invoice && typeof invoice !== "string" && invoice.status === "paid") {
    return "immediate_paid";
  }
  return "immediate_payment_pending";
}

async function applyUpgrade(
  stripe: Stripe,
  businessId: string,
  current: subscription,
  remote: Stripe.Subscription,
  targetPlan: { code: string; stripe_price_id: string | null }
): Promise<ChangePlanOutcome> {
  const stripeSubscriptionId = current.stripe_subscription_id as string;

  // Un upgrade supera cualquier downgrade programado: liberar el schedule
  // (si existe) antes de modificar los items directamente. `release()`
  // deja la suscripción como estaba en la fase vigente (el plan actual,
  // todavía no el nuevo) — el `subscriptions.update` de abajo aplica
  // entonces el plan nuevo de forma inmediata, como corresponde a un
  // upgrade.
  const existingScheduleId = extractScheduleId(remote.schedule);
  if (existingScheduleId) {
    try {
      await stripe.subscriptionSchedules.release(existingScheduleId, undefined, {
        idempotencyKey: `release-for-upgrade:${existingScheduleId}`,
      });
    } catch (err) {
      if (!isTransientStripeError(err)) {
        // Si el schedule ya no existe/ya fue liberado por otra vía, seguimos
        // igual — no es un estado que deba bloquear el upgrade.
      } else {
        throw indeterminateChangePlanError();
      }
    }
  }

  const itemId = remote.items.data[0]?.id;
  if (!itemId) {
    throw Object.assign(
      new Error("No se pudo resolver el ítem de la suscripción en Stripe."),
      { status: 502 }
    );
  }

  let updated: Stripe.Subscription;
  try {
    updated = await stripe.subscriptions.update(
      stripeSubscriptionId,
      {
        items: [{ id: itemId, price: targetPlan.stripe_price_id as string, quantity: 1 }],
        // "always_invoice" es la opción que efectivamente intenta cobrar el
        // prorrateo ahora — `create_prorations` solo deja el crédito/débito
        // pendiente para la siguiente factura, no concreta un cobro
        // inmediato (documentado en el SDK instalado, Subscriptions.d.ts).
        // Deliberadamente NO se usa `pending_if_incomplete` acá (fuera de
        // alcance de esta tarea) — ver `resolveImmediateBilling` para cómo
        // se informa un pago no confirmado sin cambiar esta semántica.
        proration_behavior: "always_invoice",
        expand: ["latest_invoice.payment_intent"],
      },
      {
        idempotencyKey: `upgrade:${stripeSubscriptionId}:${targetPlan.code}:${current.updated_at?.getTime() ?? 0}`,
      }
    );
    await upsertSubscriptionFromStripe(
      updated as unknown as StripeSubscriptionLike,
      businessId
    );
  } catch (err) {
    if (isTransientStripeError(err)) {
      const reconciled = await reconcileFromRemote(stripe, businessId, stripeSubscriptionId);
      if (reconciled?.plan_id) {
        const plan = await prisma.plan.findUnique({ where: { id: reconciled.plan_id } });
        if (plan?.code === targetPlan.code) {
          // El plan sí cambió (confirmado por evidencia local tras
          // reconciliar) — pero esta rama no tiene el objeto `invoice`
          // expandido de la respuesta original, así que no hay evidencia
          // de pago disponible acá. Nunca se informa "immediate_paid" sin
          // esa evidencia.
          return { subscription: reconciled, billing: "immediate_payment_pending" };
        }
      }
      throw indeterminateChangePlanError();
    }
    throw Object.assign(
      new Error(err instanceof Error ? err.message : "Error aplicando el upgrade en Stripe"),
      { status: 502 }
    );
  }

  const finalSub = await prisma.subscription.findUnique({ where: { business_id: businessId } });
  if (!finalSub) throw indeterminateChangePlanError();
  return { subscription: finalSub, billing: resolveImmediateBilling(updated) };
}

async function scheduleDowngrade(
  stripe: Stripe,
  businessId: string,
  current: subscription,
  remote: Stripe.Subscription,
  targetPlan: { code: string; stripe_price_id: string | null }
): Promise<ChangePlanOutcome> {
  const stripeSubscriptionId = current.stripe_subscription_id as string;
  const existingScheduleId = extractScheduleId(remote.schedule);

  let schedule: Stripe.SubscriptionSchedule;
  if (existingScheduleId) {
    try {
      schedule = await stripe.subscriptionSchedules.retrieve(existingScheduleId);
    } catch {
      throw indeterminateChangePlanError();
    }
  } else {
    try {
      schedule = await stripe.subscriptionSchedules.create(
        { from_subscription: stripeSubscriptionId },
        { idempotencyKey: `schedule-create:${stripeSubscriptionId}` }
      );
    } catch (err) {
      // Carrera: otra solicitud ya creó el schedule entre que leímos
      // `remote.schedule` y que intentamos crear el nuestro. Stripe
      // rechaza `from_subscription` si la suscripción ya tiene uno — en
      // vez de fallar, releemos cuál es y lo usamos.
      const remote2 = await stripe.subscriptions.retrieve(stripeSubscriptionId).catch(() => null);
      const raceScheduleId = remote2 ? extractScheduleId(remote2.schedule) : null;
      if (!raceScheduleId) {
        if (isTransientStripeError(err)) throw indeterminateChangePlanError();
        throw Object.assign(
          new Error(err instanceof Error ? err.message : "Error creando el schedule en Stripe"),
          { status: 502 }
        );
      }
      try {
        schedule = await stripe.subscriptionSchedules.retrieve(raceScheduleId);
      } catch {
        throw indeterminateChangePlanError();
      }
    }
  }

  const now = Math.floor(Date.now() / 1000);
  const activePhase =
    schedule.phases.find((p) => p.start_date <= now && now < p.end_date) ?? schedule.phases[0];
  if (!activePhase) {
    throw Object.assign(
      new Error("No se pudo resolver la fase vigente del schedule en Stripe."),
      { status: 502 }
    );
  }

  // Ver `subscriptionSchedulePhase.ts`: si la fase vigente tiene
  // configuración que esa reconstrucción no sabe preservar con seguridad
  // (descuentos/impuestos/metadata SÍ se preservan; `add_invoice_items`,
  // `transfer_data`, etc. no), se rechaza el downgrade en vez de aplicarlo
  // perdiendo esa configuración en silencio.
  const unsupported = detectUnsupportedPhaseConfig(activePhase);
  if (unsupported.length > 0) {
    throw Object.assign(
      new Error(
        `Esta suscripción tiene configuración de facturación avanzada (${unsupported.join(", ")}) ` +
          "que todavía no podemos preservar al programar un downgrade. Contactá a soporte."
      ),
      { status: 409 }
    );
  }

  try {
    const updatedSchedule = await stripe.subscriptionSchedules.update(
      schedule.id,
      {
        // Reconstruye las fases desde cero: fase vigente preservada tal
        // cual (ver `buildPreservedActivePhase`) + la fase del plan nuevo
        // a partir del fin del período. Esto DESCARTA cualquier fase
        // pendiente anterior (un downgrade programado previamente queda
        // reemplazado, nunca duplicado ni dejado como schedule huérfano).
        phases: [
          buildPreservedActivePhase(activePhase),
          {
            items: [{ price: targetPlan.stripe_price_id as string, quantity: 1 }],
            start_date: activePhase.end_date,
            proration_behavior: "none",
          },
        ],
        end_behavior: "release",
      },
      {
        idempotencyKey: `schedule-update:${schedule.id}:${targetPlan.code}:${activePhase.end_date}`,
      }
    );

    const scheduledSub = updatedSchedule.subscription;
    const scheduledSubId =
      typeof scheduledSub === "string" ? scheduledSub : scheduledSub?.id ?? stripeSubscriptionId;
    const remoteSub = await stripe.subscriptions.retrieve(scheduledSubId);
    await upsertSubscriptionFromStripe(
      remoteSub as unknown as StripeSubscriptionLike,
      businessId
    );
  } catch (err) {
    if (isTransientStripeError(err)) {
      await reconcileFromRemote(stripe, businessId, stripeSubscriptionId);
      // El downgrade programado no se refleja en `subscription.plan_id`
      // hasta que la fase futura se active — no hay forma de confirmar por
      // evidencia LOCAL si la actualización del schedule se aplicó. Se
      // informa como indeterminado explícitamente, nunca como éxito.
      throw indeterminateChangePlanError();
    }
    throw Object.assign(
      new Error(err instanceof Error ? err.message : "Error programando el downgrade en Stripe"),
      { status: 502 }
    );
  }

  const finalSub = await prisma.subscription.findUnique({ where: { business_id: businessId } });
  if (!finalSub) throw indeterminateChangePlanError();
  return { subscription: finalSub, billing: "scheduled" };
}

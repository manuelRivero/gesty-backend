import type { checkout_attempt, subscription } from "@prisma/client";
import Stripe from "stripe";
import { prisma } from "../../lib/prisma";
import { env } from "../../config/env";
import { findActivePlanByCode } from "./planCatalog.service";
import { getStripe, isStripeConfigured } from "./stripe.client";
import { getOrCreateStripeCustomerId } from "./stripeCustomer.service";
import {
  markSubscriptionDeletedFromStripe,
  resolveBusinessIdFromStripeSub,
  upsertSubscriptionFromStripe,
} from "./stripeSubscriptionSync.service";
import type { StripeSubscriptionLike } from "./mapStripeSubscription";
import { classifySubscriptionLifecycle } from "./subscriptionLifecycle.service";
import {
  SUBSCRIPTION_LIFECYCLE_NAMESPACE,
  withBillingLock,
} from "./billingLock";
import { reconcileLiveSubscription } from "./subscriptionReconcile.service";

function adminBaseUrl(): string {
  const origin = (env.CORS_ORIGIN ?? "http://localhost:3000")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)[0];
  return origin || "http://localhost:3000";
}

/**
 * Mutex en memoria por `businessId`: evita que dos requests en EL MISMO
 * proceso pisen la reserva persistida entre leerla y actuar sobre ella
 * (reduce contención/round-trips a la DB en el caso común). NO es la
 * garantía de fondo — esa es `checkout_attempt` + el índice único parcial +
 * el advisory lock transaccional (ver `reserveOrGetActiveAttempt`), que
 * funcionan igual entre múltiples instancias del backend. Se mantiene
 * porque sigue siendo útil como optimización barata, no porque sea
 * necesario para la corrección.
 */
const businessCheckoutLocks = new Map<string, Promise<unknown>>();

function runExclusivePerBusiness<T>(
  businessId: string,
  fn: () => Promise<T>
): Promise<T> {
  const previous = businessCheckoutLocks.get(businessId) ?? Promise.resolve();
  const result = previous.then(fn, fn);
  businessCheckoutLocks.set(
    businessId,
    result.catch(() => undefined)
  );
  return result;
}

type CheckoutGuardResult =
  | { blocked: false }
  | { blocked: true; reason: "active" | "cancel_pending" | "recoverable" };

/**
 * Decide si ya existe una suscripción de Stripe que debe gestionarse antes
 * de permitir abrir una Checkout Session nueva. Nunca se basa en
 * `business.ai_plan` ni en el código del plan: solo en el estado persistido
 * de `subscription` (espejo de Stripe vía webhooks).
 *
 * Reimplementada sobre `classifySubscriptionLifecycle` (compartida con el
 * contrato de `GET /admin/billing/subscription` y con los guards de
 * cancelación/reactivación/cambio de plan) en vez de reimplementar la
 * clasificación — mismo comportamiento observable (bloquea exactamente los
 * mismos casos, mismo HTTP 409), con una diferencia menor y deliberada: una
 * suscripción `active` con cancelación programada vigente ahora devuelve
 * el mensaje de "cancel_pending" en vez de "active" (antes, el chequeo de
 * `isActiveSubscriptionStatus` cortaba primero y nunca llegaba a evaluar
 * `cancel_at_period_end`) — el texto es más preciso, el bloqueo (409) es
 * idéntico. Cobertura de tests existente no depende del mensaje para ese
 * caso puntual, así que no hay regresión.
 */
function evaluateCheckoutGuard(sub: subscription | null): CheckoutGuardResult {
  const state = classifySubscriptionLifecycle(sub);
  if (state === "active") return { blocked: true, reason: "active" };
  if (state === "active_canceling") return { blocked: true, reason: "cancel_pending" };
  if (state === "past_due") return { blocked: true, reason: "recoverable" };
  return { blocked: false };
}

function checkoutGuardError(reason: "active" | "cancel_pending" | "recoverable") {
  const message =
    reason === "active"
      ? "Ya existe una suscripción activa para este negocio. Gestionala desde el portal de facturación."
      : reason === "cancel_pending"
        ? "La suscripción actual tiene una cancelación programada pero sigue vigente hasta el fin del período. Gestionala desde el portal de facturación."
        : "La suscripción actual tiene un pago pendiente de regularizar. Resolvé ese pago antes de iniciar una nueva suscripción.";
  return Object.assign(new Error(message), { status: 409 });
}

/**
 * Margen conservador para reintentar `sessions.create` con la misma
 * `idempotencyKey`. Stripe documenta que las claves de idempotencia pueden
 * podarse a partir de ~24h (API v1); no hay garantía del instante exacto,
 * así que usamos un margen por debajo de eso. Pasada esta ventana, un
 * reintento con la misma clave ya NO está garantizado a devolver el mismo
 * objeto — Stripe podría tratarlo como una solicitud nueva y crear una
 * segunda Checkout Session. Por eso, pasada la ventana, no reintentamos:
 * transicionamos a `unresolved` (ver `recoverPendingAttempt`).
 *
 * Exportada para que los tests puedan fijar el reloj alrededor del límite
 * sin depender de un valor mágico duplicado.
 */
export const IDEMPOTENCY_SAFE_WINDOW_MS = 18 * 60 * 60 * 1000;

type ActiveAttemptStatus = "pending" | "created" | "unresolved";
const ACTIVE_ATTEMPT_STATUSES: ActiveAttemptStatus[] = [
  "pending",
  "created",
  "unresolved",
];

function checkoutAttemptLockKey(businessId: string): string {
  return `checkout_attempt:${businessId}`;
}

/**
 * Bajo un advisory lock transaccional (mismo patrón que
 * `acquireOrderCreateLock` en `checkout.service.ts`), releé si ya existe un
 * intento vigente (`pending`/`created`/`unresolved`) para el negocio; si no
 * existe, reserva uno nuevo en `pending`. Transacción corta, sin llamadas de
 * red — el lock se libera al cerrarla.
 *
 * La garantía real de "como máximo un intento vigente por negocio" la da el
 * índice único parcial `unique_business_pending_checkout_attempt` en la
 * base de datos, no este lock: el lock solo evita que dos transacciones
 * concurrentes choquen contra esa constraint en vez de resolver limpio
 * quién reserva. Por eso funciona igual con una o con N instancias del
 * backend — la autoridad es Postgres, no el proceso Node.
 */
export async function reserveOrGetActiveAttempt(
  businessId: string,
  planCode: string
): Promise<{ attempt: checkout_attempt; isNew: boolean }> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${checkoutAttemptLockKey(businessId)}))`;

    const active = await tx.checkout_attempt.findFirst({
      where: { business_id: businessId, status: { in: ACTIVE_ATTEMPT_STATUSES } },
      orderBy: { created_at: "desc" },
    });

    if (active) {
      return { attempt: active, isNew: false };
    }

    try {
      const created = await tx.checkout_attempt.create({
        data: { business_id: businessId, plan_code: planCode, status: "pending" },
      });
      return { attempt: created, isNew: true };
    } catch (err) {
      // Defensa en profundidad: si por cualquier motivo dos transacciones
      // llegaron a pisarse (el advisory lock debería impedirlo, pero no
      // confiamos ciegamente en eso), el índice único parcial de Postgres
      // rechaza el segundo `create` con una violación de constraint (P2002).
      //
      // `checkout_attempt` tiene DOS constraints únicas además de la PK:
      // `stripe_checkout_session_id` (no aplica acá — este `create` nunca
      // la setea, siempre es `null`) y la que nos interesa,
      // `unique_business_pending_checkout_attempt` sobre `business_id`. Un
      // P2002 en este `create` específico solo puede venir de esta última
      // (la PK es un UUID generado por la base, y la de session_id no
      // aplica), pero no lo asumimos a ciegas: Prisma incluye en
      // `meta.target` el nombre de la constraint o las columnas afectadas,
      // y solo tratamos como "alguien más ya reservó el slot" el caso que
      // efectivamente nombra esta constraint. Cualquier otro P2002 (o un
      // P2002 sin `existing` encontrado, lo que indicaría una
      // inconsistencia real) se propaga en vez de tratarse como resuelto.
      if (isActiveAttemptUniqueConflict(err)) {
        const existing = await tx.checkout_attempt.findFirst({
          where: { business_id: businessId, status: { in: ACTIVE_ATTEMPT_STATUSES } },
          orderBy: { created_at: "desc" },
        });
        if (existing) {
          return { attempt: existing, isNew: false };
        }
        console.warn(
          JSON.stringify({
            event: "[billing:checkout_attempt] unique_conflict_without_existing_row",
            businessId,
          })
        );
      }
      throw err;
    }
  });
}

type PrismaUniqueConstraintError = {
  code?: string;
  meta?: { target?: unknown };
};

/**
 * `true` únicamente si el P2002 corresponde a
 * `unique_business_pending_checkout_attempt` (por nombre de constraint, o
 * por incluir `business_id` en la lista de columnas) — nunca para
 * cualquier otra violación de unicidad de la tabla.
 */
function isActiveAttemptUniqueConflict(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as PrismaUniqueConstraintError;
  if (e.code !== "P2002") return false;
  const target = e.meta?.target;
  if (typeof target === "string") {
    return target.includes("unique_business_pending_checkout_attempt");
  }
  if (Array.isArray(target)) {
    return target.includes("business_id");
  }
  return false;
}

/**
 * Transición condicional: solo aplica si la fila sigue en uno de los
 * `expectedStatuses` al momento de la actualización. Si no (otra vía —
 * típicamente un webhook — ya la movió a un estado terminal), no hace
 * nada y lo señaliza devolviendo `null`. Esto es lo que impide que una
 * respuesta tardía de Stripe pise un estado que ya quedó resuelto por otra
 * vía, sin importar cuál llegó "primero" en tiempo real.
 */
async function transitionAttempt(
  attemptId: string,
  expectedStatuses: string[],
  data: Partial<{
    status: string;
    stripe_checkout_session_id: string | null;
    stripe_customer_id: string | null;
    session_url: string | null;
    session_expires_at: Date | null;
  }>
): Promise<checkout_attempt | null> {
  const result = await prisma.checkout_attempt.updateMany({
    where: { id: attemptId, status: { in: expectedStatuses } },
    data: { ...data, updated_at: new Date() },
  });
  if (result.count === 0) {
    console.warn(
      JSON.stringify({
        event: "[billing:checkout_attempt] stale_transition_ignored",
        attemptId,
        expectedStatuses,
        attemptedData: data,
      })
    );
    return null;
  }
  return prisma.checkout_attempt.findUnique({ where: { id: attemptId } });
}

/**
 * Errores de Stripe que NO deben marcar el intento como `failed`: no son un
 * rechazo determinístico del request, son "no pudimos confirmar el
 * resultado todavía, reintentá con la misma clave". Incluye explícitamente
 * `StripeIdempotencyError` (HTTP 409, `type: "idempotency_error"`) — la que
 * Stripe documenta para "the request conflicts with another request
 * that's executing concurrently" cuando dos llamadas usan la misma
 * `idempotencyKey` casi en simultáneo (docs.stripe.com/error-low-level:
 * "If a 409 indicates that another request with the same key is still
 * executing, wait and retry with that key and the same parameters"). Antes
 * de esta corrección, este caso caía en la rama determinística y marcaba
 * `failed` de inmediato — un escenario real (dos requests para el mismo
 * negocio llegando casi a la vez a `attemptStripeSessionCreate`) que
 * terminaba liberando el slot sin necesidad, en vez de simplemente esperar.
 */
function isTransientStripeError(err: unknown): boolean {
  return (
    err instanceof Stripe.errors.StripeConnectionError ||
    err instanceof Stripe.errors.StripeAPIError ||
    err instanceof Stripe.errors.StripeRateLimitError ||
    err instanceof Stripe.errors.StripeIdempotencyError
  );
}

function unresolvedAttemptError() {
  return Object.assign(
    new Error(
      "Hay un intento de suscripción anterior que no pudo confirmarse automáticamente. " +
        "Contactá a soporte para destrabarlo antes de intentar un checkout nuevo."
    ),
    { status: 409 }
  );
}

function checkoutInProgressError() {
  return Object.assign(
    new Error(
      "Ya hay un intento de suscripción en curso para este negocio. Reintentá en unos segundos."
    ),
    { status: 409 }
  );
}

type AttemptPlan = { code: string; stripe_price_id: string };

/**
 * Llama a `stripe.checkout.sessions.create` usando el `id` del intento
 * persistido como `idempotencyKey`. Esto es lo que hace segura la
 * recuperación de un `pending` cuya respuesta se perdió (caída antes de
 * llamar, durante la llamada, o después de que Stripe creó la sesión pero
 * antes de persistirla): los tres casos son indistinguibles desde acá, y
 * los tres se resuelven igual reintentando con la misma clave — si Stripe
 * ya había creado la sesión, la devuelve sin crear una segunda.
 */
async function attemptStripeSessionCreate(
  stripe: Stripe,
  attempt: checkout_attempt,
  plan: AttemptPlan,
  businessId: string
): Promise<{ url: string }> {
  const customerId = await getOrCreateStripeCustomerId(businessId);
  const base = adminBaseUrl();

  let session: Stripe.Checkout.Session;
  try {
    session = await stripe.checkout.sessions.create(
      {
        mode: "subscription",
        customer: customerId,
        line_items: [{ price: plan.stripe_price_id, quantity: 1 }],
        success_url: `${base}/billing?checkout=success`,
        cancel_url: `${base}/billing?checkout=cancel`,
        client_reference_id: businessId,
        metadata: {
          business_id: businessId,
          plan_code: plan.code,
          checkout_attempt_id: attempt.id,
        },
        subscription_data: {
          metadata: {
            business_id: businessId,
            plan_code: plan.code,
            checkout_attempt_id: attempt.id,
          },
        },
      },
      { idempotencyKey: attempt.id }
    );
  } catch (err) {
    if (isTransientStripeError(err)) {
      // No sabemos si Stripe llegó a crear la sesión (red/5xx/rate limit), o
      // Stripe nos dijo explícitamente que esperemos porque hay otra
      // llamada con la misma clave en curso (StripeIdempotencyError, 409).
      // En ningún caso tocamos el estado: la fila sigue en `pending` para
      // un reintento posterior dentro de la ventana segura de idempotencia.
      throw Object.assign(
        new Error("No se pudo confirmar el checkout todavía. Reintentá en unos segundos."),
        { status: 503 }
      );
    }
    // Error determinístico (parámetro inválido, price mal configurado,
    // etc.): reintentar con la misma clave daría el mismo resultado. Libera
    // el slot de inmediato en vez de esperar la ventana de idempotencia.
    await transitionAttempt(attempt.id, ["pending"], { status: "failed" });
    throw Object.assign(
      new Error(err instanceof Error ? err.message : "Error creando el Checkout en Stripe"),
      { status: 502 }
    );
  }

  const updated = await transitionAttempt(attempt.id, ["pending"], {
    status: "created",
    stripe_checkout_session_id: session.id,
    stripe_customer_id: customerId,
    session_url: session.url ?? null,
    session_expires_at: session.expires_at ? new Date(session.expires_at * 1000) : null,
  });

  if (!updated) {
    // Alguien más (típicamente un webhook que llegó primero con el mismo
    // `checkout_attempt_id` en metadata) ya resolvió este intento entre que
    // Stripe respondió y que intentamos persistir — ya quedó logueado por
    // `transitionAttempt`. Esta llamada perdió el derecho a decidir: NO
    // devolvemos la URL que acabamos de obtener de Stripe sin comprobar
    // antes qué estado quedó persistido. Si ya es un estado terminal
    // (completado/expirado/fallido/sin resolución), esa URL ya no
    // corresponde usarse. Si en cambio quedó `created` (otra vía la
    // persistió primero, con los mismos datos u otra sesión), recuperamos
    // desde ese estado real en vez de confiar en la respuesta local.
    const current = await prisma.checkout_attempt.findUnique({ where: { id: attempt.id } });
    if (current && current.status !== "pending") {
      if (current.status === "created") {
        return recoverCreatedAttempt(stripe, current);
      }
      throw attemptNoLongerActiveError(current.status);
    }
  }

  if (!session.url) {
    throw Object.assign(new Error("Stripe no devolvió URL de Checkout"), {
      status: 502,
    });
  }

  return { url: session.url };
}

function attemptNoLongerActiveError(status: string) {
  const message =
    status === "completed"
      ? "El checkout ya se completó por otra vía. Actualizá la página para ver tu plan vigente."
      : status === "expired"
        ? "El checkout expiró antes de poder confirmarse. Intentá de nuevo."
        : status === "failed"
          ? "El intento de checkout anterior falló. Intentá de nuevo."
          : "El intento de checkout ya no está disponible. Contactá a soporte si persiste.";
  return Object.assign(new Error(message), { status: 409 });
}

/**
 * Recupera un intento `created`: consulta la sesión real en Stripe y decide
 * según evidencia, nunca por antigüedad local.
 */
async function recoverCreatedAttempt(
  stripe: Stripe,
  attempt: checkout_attempt
): Promise<{ url: string }> {
  if (!attempt.stripe_checkout_session_id) {
    // Defensivo: no debería existir una fila `created` sin session id.
    throw Object.assign(new Error("Intento de checkout inconsistente"), {
      status: 500,
    });
  }

  let session: Stripe.Checkout.Session;
  try {
    session = await stripe.checkout.sessions.retrieve(attempt.stripe_checkout_session_id);
  } catch {
    // Si Stripe no responde, NO liberamos el slot a ciegas: la fila queda
    // `created` tal cual, para reintentar en la próxima solicitud.
    throw Object.assign(
      new Error("No se pudo verificar el checkout existente. Reintentá en unos segundos."),
      { status: 503 }
    );
  }

  if (session.status === "open") {
    if (!session.url) {
      throw Object.assign(new Error("Stripe no devolvió URL de Checkout"), {
        status: 502,
      });
    }
    return { url: session.url };
  }

  if (session.status === "complete") {
    await reconcileCompletedCheckoutSession(session);
    throw Object.assign(
      new Error(
        "El checkout anterior ya se completó. Actualizá la página para ver tu plan vigente."
      ),
      { status: 409 }
    );
  }

  if (session.status === "expired") {
    await reconcileExpiredCheckoutSession(session);
    throw Object.assign(
      new Error("El checkout anterior expiró. Podés iniciar uno nuevo."),
      { status: 409 }
    );
  }

  // Cualquier otro valor no documentado por el SDK: no lo interpretamos
  // como evidencia de nada. Error controlado, sin tocar el estado.
  throw Object.assign(
    new Error("No se pudo determinar el estado del checkout existente."),
    { status: 503 }
  );
}

/**
 * Recupera un intento `pending`: dentro de la ventana segura, reintenta la
 * creación con la misma idempotencyKey (cubre los tres puntos de caída:
 * antes de llamar, durante la llamada, después de crear pero antes de
 * persistir). Pasada la ventana, no reintenta — transiciona a `unresolved`.
 */
async function recoverPendingAttempt(
  stripe: Stripe,
  attempt: checkout_attempt,
  plan: AttemptPlan,
  businessId: string
): Promise<{ url: string }> {
  const ageMs = Date.now() - attempt.created_at.getTime();
  if (ageMs < IDEMPOTENCY_SAFE_WINDOW_MS) {
    return attemptStripeSessionCreate(stripe, attempt, plan, businessId);
  }

  await transitionAttempt(attempt.id, ["pending"], { status: "unresolved" });
  throw unresolvedAttemptError();
}

async function recoverExistingAttempt(
  stripe: Stripe,
  attempt: checkout_attempt,
  plan: AttemptPlan,
  businessId: string
): Promise<{ url: string }> {
  if (attempt.status === "created") {
    return recoverCreatedAttempt(stripe, attempt);
  }
  if (attempt.status === "pending") {
    return recoverPendingAttempt(stripe, attempt, plan, businessId);
  }
  if (attempt.status === "unresolved") {
    throw unresolvedAttemptError();
  }
  // No debería llegar acá: `reserveOrGetActiveAttempt` solo trae filas en
  // ACTIVE_ATTEMPT_STATUSES. Defensivo por si cambia esa lista sin tocar
  // este switch.
  throw checkoutInProgressError();
}

export async function createCheckoutSession(input: {
  businessId: string;
  planCode: string;
}): Promise<{ url: string }> {
  return runExclusivePerBusiness(input.businessId, () =>
    createCheckoutSessionUnlocked(input)
  );
}

async function createCheckoutSessionUnlocked(input: {
  businessId: string;
  planCode: string;
}): Promise<{ url: string }> {
  const stripe = getStripe();
  if (!stripe || !isStripeConfigured()) {
    throw Object.assign(new Error("Stripe no configurado"), { status: 503 });
  }

  const plan = await findActivePlanByCode(input.planCode);
  if (!plan?.stripe_price_id) {
    throw Object.assign(new Error("Plan no disponible para suscripción"), {
      status: 400,
    });
  }
  const attemptPlan: AttemptPlan = { code: plan.code, stripe_price_id: plan.stripe_price_id };

  let existingSub: subscription | null;
  try {
    existingSub = (await prisma.subscription.findUnique({
      where: { business_id: input.businessId },
    })) ?? null;
  } catch {
    throw Object.assign(
      new Error("No se pudo verificar el estado de la suscripción"),
      { status: 503 }
    );
  }

  const guard = evaluateCheckoutGuard(existingSub);
  if (guard.blocked) {
    throw checkoutGuardError(guard.reason);
  }

  let reservation: { attempt: checkout_attempt; isNew: boolean };
  try {
    reservation = await reserveOrGetActiveAttempt(input.businessId, attemptPlan.code);
  } catch {
    throw Object.assign(
      new Error("No se pudo reservar el intento de checkout"),
      { status: 503 }
    );
  }

  if (reservation.isNew) {
    return attemptStripeSessionCreate(stripe, reservation.attempt, attemptPlan, input.businessId);
  }

  return recoverExistingAttempt(stripe, reservation.attempt, attemptPlan, input.businessId);
}

export async function createBillingPortalSession(input: {
  businessId: string;
}): Promise<{ url: string }> {
  const stripe = getStripe();
  if (!stripe || !isStripeConfigured()) {
    throw Object.assign(new Error("Stripe no configurado"), { status: 503 });
  }

  const sub = await prisma.subscription.findUnique({
    where: { business_id: input.businessId },
  });
  if (!sub?.stripe_customer_id) {
    throw Object.assign(
      new Error("Suscribite primero para gestionar el plan"),
      { status: 400 }
    );
  }

  const base = adminBaseUrl();
  const session = await stripe.billingPortal.sessions.create({
    customer: sub.stripe_customer_id,
    return_url: `${base}/billing`,
  });

  return { url: session.url };
}

/**
 * Tras un error transitorio (red/5xx/rate limit/idempotencia) en una
 * mutación de Stripe sobre una suscripción existente, NO asumimos que no
 * se aplicó: releemos el estado real desde Stripe (lectura, siempre
 * segura) y lo sincronizamos con el mecanismo existente antes de decidir
 * qué responder. Si ni la reconciliación funciona, el resultado queda
 * genuinamente indeterminado — se informa así, nunca como éxito.
 */
async function reconcileAfterTransientMutationError(
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

function isTransientOrConflictStripeError(err: unknown): boolean {
  return (
    err instanceof Stripe.errors.StripeConnectionError ||
    err instanceof Stripe.errors.StripeAPIError ||
    err instanceof Stripe.errors.StripeRateLimitError ||
    err instanceof Stripe.errors.StripeIdempotencyError
  );
}

function indeterminateResultError() {
  return Object.assign(
    new Error(
      "No se pudo confirmar si la operación se aplicó en Stripe. Verificá el estado de tu suscripción en unos segundos antes de reintentar."
    ),
    { status: 503 }
  );
}

/**
 * Política de la sección 7 (Fase 2): si la suscripción remota tiene un
 * Subscription Schedule asociado (típicamente un downgrade programado por
 * `scheduleDowngrade`), cancelar o reactivar desde acá queda ambiguo —
 * ¿qué pasa con la fase futura ya programada? En vez de decidir eso de
 * forma implícita (liberar/truncar/reemplazar el schedule sin que el
 * usuario lo haya pedido), se rechaza con 409 y se pide resolver primero
 * el cambio de plan programado. Esta tarea NO agrega la operación para
 * cancelar ese cambio programado — solo el guard que impide pisarlo.
 *
 * Se comprueba sobre `remote.schedule` (el estado de Stripe recién
 * reconciliado por `reconcileLiveSubscription`), nunca sobre una copia
 * local — la fila `subscription` no guarda el id del schedule.
 */
function scheduleConflictError() {
  return Object.assign(
    new Error(
      "Esta suscripción tiene un cambio de plan programado. Resolvé ese cambio antes de cancelar o reactivar."
    ),
    { status: 409 }
  );
}

/**
 * Cancelación owner-facing: programa la cancelación al final del período
 * vigente. Reutiliza `cancelSubscriptionAtPeriodEnd` (ya usado por
 * super-admin) para la llamada a Stripe, pero valida autorización/estado
 * de forma propia — nunca pasa por el controller de super-admin.
 *
 * Todo el cuerpo corre bajo `withBillingLock` (mismo namespace que
 * `reactivateSubscription`, `changeSubscriptionPlan` y el handler de
 * webhooks de `customer.subscription.*`): el lock se sostiene durante la
 * relectura+reconciliación contra Stripe, la validación del estado, la
 * mutación remota y la persistencia local — nunca solo durante la lectura
 * inicial.
 */
export async function cancelOwnerSubscription(businessId: string): Promise<{
  subscription: subscription;
}> {
  const stripe = getStripe();
  if (!stripe) {
    throw Object.assign(new Error("Stripe no configurado"), { status: 503 });
  }

  return withBillingLock(SUBSCRIPTION_LIFECYCLE_NAMESPACE, businessId, async () => {
    const { local: sub, remote } = await reconcileLiveSubscription(stripe, businessId);
    const state = classifySubscriptionLifecycle(sub);

    if (state === "active_canceling") {
      // Repetición segura: ya está programada, no hace falta volver a tocar
      // Stripe. Devolvemos el estado actual (ya reconciliado) como éxito
      // idempotente.
      return { subscription: sub as subscription };
    }
    if (state !== "active") {
      throw Object.assign(
        new Error(
          "Esta suscripción no está en un estado que permita programar una cancelación."
        ),
        { status: 409 }
      );
    }
    if (remote?.schedule) {
      throw scheduleConflictError();
    }

    const stripeSubscriptionId = (sub as subscription).stripe_subscription_id as string;

    try {
      const updated = await stripe.subscriptions.update(
        stripeSubscriptionId,
        { cancel_at_period_end: true },
        { idempotencyKey: `cancel:${stripeSubscriptionId}:${(sub as subscription).updated_at?.getTime() ?? 0}` }
      );
      await upsertSubscriptionFromStripe(
        updated as unknown as StripeSubscriptionLike,
        businessId
      );
    } catch (err) {
      if (isTransientOrConflictStripeError(err)) {
        const reconciled = await reconcileAfterTransientMutationError(
          stripe,
          businessId,
          stripeSubscriptionId
        );
        if (reconciled && classifySubscriptionLifecycle(reconciled) === "active_canceling") {
          return { subscription: reconciled };
        }
        throw indeterminateResultError();
      }
      throw Object.assign(
        new Error(err instanceof Error ? err.message : "Error cancelando en Stripe"),
        { status: 502 }
      );
    }

    const finalSub = await prisma.subscription.findUnique({ where: { business_id: businessId } });
    if (!finalSub) {
      throw indeterminateResultError();
    }
    return { subscription: finalSub };
  });
}

/**
 * Reactivación owner-facing: deshace una cancelación programada mientras
 * la suscripción sigue vigente. Rechaza si no hay nada que reactivar
 * (idempotente si ya está `active` sin cancelación) o si la suscripción
 * ya terminó efectivamente (ahí corresponde un checkout nuevo, nunca se
 * crea una suscripción como alternativa acá). Mismo lock y mismo criterio
 * de conflicto con schedules que `cancelOwnerSubscription` — ver el
 * comentario de esa función.
 */
export async function reactivateSubscription(businessId: string): Promise<{
  subscription: subscription;
}> {
  const stripe = getStripe();
  if (!stripe) {
    throw Object.assign(new Error("Stripe no configurado"), { status: 503 });
  }

  return withBillingLock(SUBSCRIPTION_LIFECYCLE_NAMESPACE, businessId, async () => {
    const { local: sub, remote } = await reconcileLiveSubscription(stripe, businessId);
    const state = classifySubscriptionLifecycle(sub);

    if (state === "active") {
      // Idempotente: ya no hay cancelación pendiente, nada que hacer.
      return { subscription: sub as subscription };
    }
    if (state !== "active_canceling") {
      throw Object.assign(
        new Error(
          "Esta suscripción no tiene una cancelación programada vigente para revertir."
        ),
        { status: 409 }
      );
    }
    if (remote?.schedule) {
      throw scheduleConflictError();
    }

    const stripeSubscriptionId = (sub as subscription).stripe_subscription_id as string;

    try {
      const updated = await stripe.subscriptions.update(
        stripeSubscriptionId,
        { cancel_at_period_end: false },
        { idempotencyKey: `reactivate:${stripeSubscriptionId}:${(sub as subscription).updated_at?.getTime() ?? 0}` }
      );
      await upsertSubscriptionFromStripe(
        updated as unknown as StripeSubscriptionLike,
        businessId
      );
    } catch (err) {
      if (isTransientOrConflictStripeError(err)) {
        const reconciled = await reconcileAfterTransientMutationError(
          stripe,
          businessId,
          stripeSubscriptionId
        );
        if (reconciled && classifySubscriptionLifecycle(reconciled) === "active") {
          return { subscription: reconciled };
        }
        throw indeterminateResultError();
      }
      throw Object.assign(
        new Error(err instanceof Error ? err.message : "Error reactivando en Stripe"),
        { status: 502 }
      );
    }

    const finalSub = await prisma.subscription.findUnique({ where: { business_id: businessId } });
    if (!finalSub) {
      throw indeterminateResultError();
    }
    return { subscription: finalSub };
  });
}

export async function cancelSubscriptionAtPeriodEnd(
  businessId: string
): Promise<void> {
  const stripe = getStripe();
  if (!stripe) {
    throw Object.assign(new Error("Stripe no configurado"), { status: 503 });
  }

  const sub = await prisma.subscription.findUnique({
    where: { business_id: businessId },
  });
  if (!sub?.stripe_subscription_id) {
    throw Object.assign(new Error("Sin suscripción Stripe"), { status: 400 });
  }

  const updated = await stripe.subscriptions.update(sub.stripe_subscription_id, {
    cancel_at_period_end: true,
  });
  await upsertSubscriptionFromStripe(
    updated as unknown as StripeSubscriptionLike,
    businessId
  );
}

export async function syncSubscriptionFromStripeApi(
  businessId: string
): Promise<void> {
  const stripe = getStripe();
  if (!stripe) {
    throw Object.assign(new Error("Stripe no configurado"), { status: 503 });
  }

  const sub = await prisma.subscription.findUnique({
    where: { business_id: businessId },
  });
  if (!sub?.stripe_subscription_id) {
    throw Object.assign(new Error("Sin suscripción Stripe para sincronizar"), {
      status: 400,
    });
  }

  const remote = await stripe.subscriptions.retrieve(sub.stripe_subscription_id);
  await upsertSubscriptionFromStripe(
    remote as unknown as StripeSubscriptionLike,
    businessId
  );
}

async function alreadyProcessed(eventId: string): Promise<boolean> {
  const existing = await prisma.stripe_webhook_event.findUnique({
    where: { stripe_event_id: eventId },
  });
  return Boolean(existing);
}

async function markProcessed(event: Stripe.Event): Promise<void> {
  try {
    await prisma.stripe_webhook_event.create({
      data: {
        stripe_event_id: event.id,
        type: event.type,
        payload: event as unknown as object,
      },
    });
  } catch {
    // unique race — ok
  }
}

/**
 * Reconcilia `checkout_attempt` + `subscription` a partir de una Checkout
 * Session completada. Comparte lógica entre el webhook `checkout.session.
 * completed` y la recuperación activa de un intento `created` (cuando
 * `sessions.retrieve` ya muestra `status: "complete"`).
 *
 * Nunca es la fuente de verdad del acceso/entitlement del negocio — eso
 * sigue siendo exclusivamente `upsertSubscriptionFromStripe` sobre
 * `subscription`. El intento (`checkout_attempt`) es puramente contable
 * para la exclusión de duplicados.
 */
async function reconcileCompletedCheckoutSession(
  session: Stripe.Checkout.Session
): Promise<void> {
  const businessId =
    session.metadata?.business_id?.trim() ||
    session.client_reference_id?.trim() ||
    null;
  const subId =
    typeof session.subscription === "string"
      ? session.subscription
      : session.subscription?.id;

  if (businessId && subId) {
    const stripe = getStripe();
    if (stripe) {
      const remote = await stripe.subscriptions.retrieve(subId);
      await upsertSubscriptionFromStripe(
        remote as unknown as StripeSubscriptionLike,
        businessId
      );
    }
  }

  const attemptId = session.metadata?.checkout_attempt_id?.trim();
  if (!attemptId) return;

  // Validación de identidad: el intento debe pertenecer al mismo negocio que
  // indica la sesión antes de tocar sus datos.
  const where: { id: string; status: { in: string[] }; business_id?: string } = {
    id: attemptId,
    status: { in: ["pending", "created"] },
  };
  if (businessId) where.business_id = businessId;

  const result = await prisma.checkout_attempt.updateMany({
    where,
    data: {
      status: "completed",
      stripe_checkout_session_id: session.id,
      updated_at: new Date(),
    },
  });
  if (result.count === 0) {
    console.warn(
      JSON.stringify({
        event: "[billing:checkout_attempt] completed_webhook_no_match",
        attemptId,
        sessionId: session.id,
      })
    );
  }
}

/**
 * Reconcilia `checkout_attempt` a partir de una Checkout Session expirada.
 * Solo afecta al intento correspondiente a ESA sesión (por
 * `checkout_attempt_id` en metadata, o por `stripe_checkout_session_id`
 * como respaldo) — nunca a "el intento vigente del negocio", así que una
 * sesión vieja nunca puede expirar un intento nuevo y distinto.
 */
async function reconcileExpiredCheckoutSession(
  session: Stripe.Checkout.Session
): Promise<void> {
  const attemptId = session.metadata?.checkout_attempt_id?.trim();
  const businessId =
    session.metadata?.business_id?.trim() ||
    session.client_reference_id?.trim() ||
    null;

  if (attemptId) {
    const where: { id: string; status: { in: string[] }; business_id?: string } = {
      id: attemptId,
      status: { in: ["pending", "created"] },
    };
    if (businessId) where.business_id = businessId;

    const result = await prisma.checkout_attempt.updateMany({
      where,
      data: { status: "expired", updated_at: new Date() },
    });
    if (result.count === 0) {
      console.warn(
        JSON.stringify({
          event: "[billing:checkout_attempt] expired_webhook_no_match",
          attemptId,
          sessionId: session.id,
        })
      );
    }
    return;
  }

  // Sesiones creadas antes de este cambio (sin checkout_attempt_id en
  // metadata): reconciliar por stripe_checkout_session_id, que es único por
  // sesión — tampoco puede afectar a un intento distinto.
  await prisma.checkout_attempt.updateMany({
    where: { stripe_checkout_session_id: session.id, status: { in: ["pending", "created"] } },
    data: { status: "expired", updated_at: new Date() },
  });
}

/**
 * Sincroniza una suscripción a partir de una señal de webhook, bajo el
 * MISMO lock que usan las mutaciones owner-facing (`cancelOwnerSubscription`,
 * `reactivateSubscription`, `changeSubscriptionPlan`). Esto es lo que evita
 * que un webhook atrasado pise una mutación más reciente (o viceversa):
 * ambos caminos se serializan por negocio.
 *
 * El webhook es solo una SEÑAL de que algo cambió — nunca se usa
 * `event.data.object` como snapshot autoritativo. Siempre se vuelve a
 * pedir el estado remoto actual con `stripe.subscriptions.retrieve(subId)`
 * (ya dentro del lock) y se sincroniza con `upsertSubscriptionFromStripe`,
 * así que un evento viejo que llega después de uno nuevo termina
 * reconciliando el mismo estado actual, no el que traía su propio payload.
 *
 * Si el retrieve indica que la suscripción ya no existe en Stripe
 * (`resource_missing`), se trata igual que `customer.subscription.deleted`:
 * se marca cancelada localmente por id, sin necesitar el objeto remoto
 * (operación de identidad, segura incluso sin datos frescos). Cualquier
 * otro fallo (red, 5xx, rate limit) se propaga sin marcar nada — el
 * webhook debe reintentarse (Stripe reintenta automáticamente ante una
 * respuesta no-2xx del endpoint).
 */
async function syncSubscriptionFromWebhookSignal(
  stripe: Stripe,
  subId: string,
  fallbackBusinessId: string | null
): Promise<void> {
  const businessId =
    fallbackBusinessId ??
    (await resolveBusinessIdFromStripeSub({ id: subId } as StripeSubscriptionLike));
  if (!businessId) {
    console.warn(
      JSON.stringify({ event: "[billing:stripe] webhook_business_id_unresolved", subId })
    );
    return;
  }

  await withBillingLock(SUBSCRIPTION_LIFECYCLE_NAMESPACE, businessId, async () => {
    let remote: Stripe.Subscription;
    try {
      remote = await stripe.subscriptions.retrieve(subId);
    } catch (err) {
      if (
        err instanceof Stripe.errors.StripeInvalidRequestError &&
        err.code === "resource_missing"
      ) {
        await markSubscriptionDeletedFromStripe(subId);
        return;
      }
      throw err;
    }
    await upsertSubscriptionFromStripe(
      remote as unknown as StripeSubscriptionLike,
      businessId
    );
  });
}

export async function processStripeWebhookEvent(
  event: Stripe.Event
): Promise<void> {
  if (await alreadyProcessed(event.id)) {
    return;
  }

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      await reconcileCompletedCheckoutSession(session);
      break;
    }
    case "checkout.session.expired": {
      const session = event.data.object as Stripe.Checkout.Session;
      await reconcileExpiredCheckoutSession(session);
      break;
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      // El payload del evento solo se usa para IDENTIDAD (id de la
      // suscripción, business_id en metadata si está) — nunca para los
      // campos que pueden haber cambiado (status, cancel_at_period_end,
      // período). Esos se vuelven a pedir frescos dentro del lock, ver
      // `syncSubscriptionFromWebhookSignal`.
      const stripeSub = event.data.object as unknown as StripeSubscriptionLike;
      const stripe = getStripe();
      if (!stripe) {
        console.warn("[billing:stripe] webhook de suscripción sin Stripe configurado");
        break;
      }
      const fallbackBusinessId = await resolveBusinessIdFromStripeSub(stripeSub);
      await syncSubscriptionFromWebhookSignal(stripe, stripeSub.id, fallbackBusinessId);
      break;
    }
    case "invoice.payment_failed": {
      const invoice = event.data.object as Stripe.Invoice;
      const parentSub = invoice.parent?.subscription_details?.subscription;
      const subId =
        typeof parentSub === "string" ? parentSub : parentSub?.id ?? null;
      if (subId) {
        const stripe = getStripe();
        if (stripe) {
          await syncSubscriptionFromWebhookSignal(stripe, subId, null);
        }
      }
      break;
    }
    default:
      break;
  }

  await markProcessed(event);
}

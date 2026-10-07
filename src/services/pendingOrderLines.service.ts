/**
 * pendingOrderLines — cola de líneas de pedido cuando el cliente pide varios
 * platos en un mismo mensaje ("3 lomos, 2 ceviches y una bebida").
 *
 * Patrón alineado a tipables (pendingAddQuantity / pendingItemNote): NO es un
 * router regex. El alta la hace el ReAct con la tool `plan_order_lines`
 * (D2); la cola vive en metadata de sesión (no tabla de negocio, D1) y el
 * código (no el modelo) decide la línea activa y cuándo avanzar (D6).
 *
 * Ver PLAN-ACCION-PEDIDO-MULTI-LINEA.md.
 */

import { randomUUID } from 'node:crypto';
import {
  mutateConversationMetadata,
  omitConversationMetadataKeys,
  patchConversationMetadata,
} from '../repositories';
import { normalizeMetadata } from './productQuery/utils';
import type { ConversationMetadata } from './productQuery/types';
import type { ProductResolution } from './productResolution.service';

export const PENDING_ORDER_LINES_KEY = 'pendingOrderLines' as const;

export const ORDER_LINES_MAX = 8;

export type OrderLineStatus = 'queued' | 'active' | 'done' | 'cancelled';

export type OrderLine = {
  id: string;
  hint: string;
  requestedQuantity: number | null;
  status: OrderLineStatus;
  currentResolutionId: string | null;
};

export type FulfillmentTask = OrderLine;

export type PendingOrderLines = {
  lines: OrderLine[];
  sourceMessage: string;
  createdAt: string;
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null;

const parseLine = (raw: unknown): OrderLine | null => {
  if (!isRecord(raw)) return null;
  if (typeof raw.id !== 'string' || !raw.id.trim()) return null;
  if (typeof raw.hint !== 'string' || !raw.hint.trim()) return null;
  const requestedQuantity =
    typeof raw.requestedQuantity === 'number' && raw.requestedQuantity >= 1
      ? Math.min(99, Math.floor(raw.requestedQuantity))
      : null;
  const status: OrderLineStatus =
    raw.status === 'queued' ||
    raw.status === 'active' ||
    raw.status === 'done' ||
    raw.status === 'cancelled'
      ? raw.status
      : 'queued';
  const currentResolutionId =
    typeof raw.currentResolutionId === 'string'
      ? raw.currentResolutionId.trim() || null
      : raw.currentResolutionId === null
        ? null
        : null;
  return {
    id: raw.id.trim(),
    hint: raw.hint.trim(),
    requestedQuantity,
    status,
    currentResolutionId,
  };
};

export const parsePendingOrderLines = (raw: unknown): PendingOrderLines | null => {
  if (!isRecord(raw)) return null;
  if (!Array.isArray(raw.lines)) return null;
  const lines = raw.lines.map(parseLine).filter((l): l is OrderLine => l != null);
  if (lines.length === 0) return null;
  const sourceMessage = typeof raw.sourceMessage === 'string' ? raw.sourceMessage : '';
  const createdAt =
    typeof raw.createdAt === 'string' && raw.createdAt
      ? raw.createdAt
      : new Date().toISOString();
  return { lines, sourceMessage, createdAt };
};

export const getPendingOrderLines = (metadata: unknown): PendingOrderLines | null => {
  const meta = normalizeMetadata(metadata) as ConversationMetadata;
  return parsePendingOrderLines((meta as Record<string, unknown>).pendingOrderLines);
};

/** Línea activa (Constraint, D1): primera `active`, si no hay primera `queued`. */
export const getActiveOrderLine = (pending: PendingOrderLines | null): OrderLine | null => {
  if (!pending) return null;
  return (
    pending.lines.find((l) => l.status === 'active') ??
    pending.lines.find((l) => l.status === 'queued') ??
    null
  );
};

/** Quantity target: only product-bound tasks may advance to quantity resolution. */
export const validateCurrentProductResolutionForTask = (params: {
  task: Pick<OrderLine, 'currentResolutionId'>;
  businessId?: string;
  conversationId?: string;
  resolution?: Partial<ProductResolution> | null;
}): { ok: true; resolution: Partial<ProductResolution> } | { ok: false; reason: string } => {
  const candidate = typeof params.task.currentResolutionId === 'string'
    ? params.task.currentResolutionId.trim()
    : '';
  if (!candidate) {
    return { ok: false, reason: 'missing' };
  }

  const resolution = params.resolution ?? null;
  if (!resolution || typeof resolution !== 'object') {
    return { ok: false, reason: 'missing' };
  }

  if (
    typeof resolution.resolutionId === 'string' &&
    resolution.resolutionId.trim() !== candidate
  ) {
    return { ok: false, reason: 'missing' };
  }

  if (params.businessId && resolution.businessId && resolution.businessId !== params.businessId) {
    return { ok: false, reason: 'wrong_business' };
  }

  if (
    params.conversationId &&
    typeof resolution.conversationId === 'string' &&
    resolution.conversationId !== params.conversationId
  ) {
    return { ok: false, reason: 'wrong_conversation' };
  }

  if (resolution.status === 'consumed') return { ok: false, reason: 'consumed' };
  if (resolution.status === 'candidate') return { ok: false, reason: 'not_selected' };
  if (typeof resolution.expiresAt === 'string') {
    const expiresAt = Date.parse(resolution.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      return { ok: false, reason: 'expired' };
    }
  }

  return { ok: true, resolution };
};

export const getCurrentProductResolutionForTask = (params: {
  task: Pick<OrderLine, 'currentResolutionId'>;
  conversationId?: string;
  businessId?: string;
  metadata?: unknown;
}): { ok: true; resolution: Partial<ProductResolution> } | { ok: false; reason: string } => {
  const taskResolutionId = typeof params.task.currentResolutionId === 'string'
    ? params.task.currentResolutionId.trim()
    : '';
  if (!taskResolutionId) return { ok: false, reason: 'missing' };

  const meta = params.metadata && typeof params.metadata === 'object' ? params.metadata as Record<string, unknown> : {};
  const resolutions = Array.isArray(meta.productResolutions)
    ? (meta.productResolutions as Array<Partial<ProductResolution>>)
    : [];
  const match = resolutions.find(
    (resolution) => typeof resolution.resolutionId === 'string' && resolution.resolutionId === taskResolutionId
  );
  return validateCurrentProductResolutionForTask({
    task: params.task,
    businessId: params.businessId,
    conversationId: params.conversationId,
    resolution: match ?? null,
  });
};

export type TaskResolutionOwnershipFailure =
  | 'task_not_found'
  | 'task_not_open'
  | 'task_resolution_mismatch'
  | 'resolution_already_owned';

export const validateTaskResolutionOwnership = (params: {
  metadata: unknown;
  taskId: string;
  resolutionId: string;
}):
  | { ok: true; task: OrderLine }
  | { ok: false; reason: TaskResolutionOwnershipFailure } => {
  const pending = getPendingOrderLines(params.metadata);
  const task = pending?.lines.find((line) => line.id === params.taskId);
  if (!task) return { ok: false, reason: 'task_not_found' };
  if (task.status !== 'active' && task.status !== 'queued') {
    return { ok: false, reason: 'task_not_open' };
  }
  if (task.currentResolutionId !== params.resolutionId) {
    return { ok: false, reason: 'task_resolution_mismatch' };
  }
  if (pending!.lines.some((line) =>
    line.id !== params.taskId &&
    line.currentResolutionId === params.resolutionId
  )) {
    return { ok: false, reason: 'resolution_already_owned' };
  }
  return { ok: true, task };
};

type ProductResolutionAssociationResult =
  | { ok: true; pending: PendingOrderLines }
  | { ok: false; reason: 'task_not_found' | 'task_not_open' | 'task_not_active' | 'resolution_not_valid' | 'resolution_already_owned' | 'task_already_associated' };

export const associateProductResolutionToTask = async (params: {
  conversationId: string;
  businessId: string;
  taskId: string;
  resolutionId: string;
  turnId?: string;
  toolCallId?: string;
  traceId?: string;
}): Promise<ProductResolutionAssociationResult> => {
  return mutateConversationMetadata<ProductResolutionAssociationResult>(params.conversationId, (metadata) => {
    const pending = getPendingOrderLines(metadata);
    if (!pending) {
      console.log(JSON.stringify({
        event: '[TRACE-ORDERLINE]',
        stage: 'associateProductResolutionToTask.result',
        traceId: params.traceId ?? `${params.conversationId}:${params.turnId ?? 'no-turn'}`,
        conversationId: params.conversationId,
        turnId: params.turnId ?? null,
        toolCallId: params.toolCallId ?? null,
        taskId: params.taskId,
        resolutionId: params.resolutionId,
        previousCurrentResolutionId: null,
        newCurrentResolutionId: null,
        success: false,
        reason: 'task_not_found',
      }));
      return { metadata: null, result: { ok: false, reason: 'task_not_found' } };
    }
    const target = pending.lines.find((line) => line.id === params.taskId);
    if (!target) {
      console.log(JSON.stringify({
        event: '[TRACE-ORDERLINE]',
        stage: 'associateProductResolutionToTask.result',
        traceId: params.traceId ?? `${params.conversationId}:${params.turnId ?? 'no-turn'}`,
        conversationId: params.conversationId,
        turnId: params.turnId ?? null,
        toolCallId: params.toolCallId ?? null,
        taskId: params.taskId,
        resolutionId: params.resolutionId,
        previousCurrentResolutionId: null,
        newCurrentResolutionId: null,
        success: false,
        reason: 'task_not_found',
      }));
      return { metadata: null, result: { ok: false, reason: 'task_not_found' } };
    }
    const previousCurrentResolutionId = target.currentResolutionId;
    if (target.status !== 'active' && target.status !== 'queued') {
      console.log(JSON.stringify({
        event: '[TRACE-ORDERLINE]',
        stage: 'associateProductResolutionToTask.result',
        traceId: params.traceId ?? `${params.conversationId}:${params.turnId ?? 'no-turn'}`,
        conversationId: params.conversationId,
        turnId: params.turnId ?? null,
        toolCallId: params.toolCallId ?? null,
        taskId: params.taskId,
        resolutionId: params.resolutionId,
        previousCurrentResolutionId,
        newCurrentResolutionId: previousCurrentResolutionId,
        success: false,
        reason: 'task_not_open',
      }));
      return { metadata: null, result: { ok: false, reason: 'task_not_open' } };
    }
    // Invariante: solo una Task ACTIVE recibe ProductResolution. Una QUEUED se
    // activa con continue_order_line antes de resolverse.
    if (target.status !== 'active') {
      console.log(JSON.stringify({
        event: '[TRACE-ORDERLINE]',
        stage: 'associateProductResolutionToTask.result',
        traceId: params.traceId ?? `${params.conversationId}:${params.turnId ?? 'no-turn'}`,
        conversationId: params.conversationId,
        turnId: params.turnId ?? null,
        toolCallId: params.toolCallId ?? null,
        taskId: params.taskId,
        resolutionId: params.resolutionId,
        previousCurrentResolutionId,
        newCurrentResolutionId: previousCurrentResolutionId,
        success: false,
        reason: 'task_not_active',
      }));
      return { metadata: null, result: { ok: false, reason: 'task_not_active' } };
    }

    const resolutions = Array.isArray(metadata.productResolutions)
      ? (metadata.productResolutions as Array<Partial<ProductResolution>>)
      : [];
    const resolution = resolutions.find((item) => item.resolutionId === params.resolutionId);
    const validation = validateCurrentProductResolutionForTask({
      task: { currentResolutionId: params.resolutionId },
      businessId: params.businessId,
      conversationId: params.conversationId,
      resolution,
    });
    if (!validation.ok) {
      console.log(JSON.stringify({
        event: '[TRACE-ORDERLINE]',
        stage: 'associateProductResolutionToTask.result',
        traceId: params.traceId ?? `${params.conversationId}:${params.turnId ?? 'no-turn'}`,
        conversationId: params.conversationId,
        turnId: params.turnId ?? null,
        toolCallId: params.toolCallId ?? null,
        taskId: params.taskId,
        resolutionId: params.resolutionId,
        previousCurrentResolutionId,
        newCurrentResolutionId: previousCurrentResolutionId,
        success: false,
        reason: 'resolution_not_valid',
      }));
      return { metadata: null, result: { ok: false, reason: 'resolution_not_valid' } };
    }
    if (target.currentResolutionId && target.currentResolutionId !== params.resolutionId) {
      const previousResolution = resolutions.find(
        (item) => item.resolutionId === target.currentResolutionId
      );
      const previousValidation = validateCurrentProductResolutionForTask({
        task: target,
        businessId: params.businessId,
        conversationId: params.conversationId,
        resolution: previousResolution,
      });
      if (previousValidation.ok) {
        console.log(JSON.stringify({
          event: '[TRACE-ORDERLINE]',
          stage: 'associateProductResolutionToTask.result',
          traceId: params.traceId ?? `${params.conversationId}:${params.turnId ?? 'no-turn'}`,
          conversationId: params.conversationId,
          turnId: params.turnId ?? null,
          toolCallId: params.toolCallId ?? null,
          taskId: params.taskId,
          resolutionId: params.resolutionId,
          previousCurrentResolutionId,
          newCurrentResolutionId: previousCurrentResolutionId,
          success: false,
          reason: 'task_already_associated',
        }));
        return { metadata: null, result: { ok: false, reason: 'task_already_associated' } };
      }
    }
    if (pending.lines.some((line) =>
      line.id !== params.taskId &&
      line.currentResolutionId === params.resolutionId
    )) {
      console.log(JSON.stringify({
        event: '[TRACE-ORDERLINE]',
        stage: 'associateProductResolutionToTask.result',
        traceId: params.traceId ?? `${params.conversationId}:${params.turnId ?? 'no-turn'}`,
        conversationId: params.conversationId,
        turnId: params.turnId ?? null,
        toolCallId: params.toolCallId ?? null,
        taskId: params.taskId,
        resolutionId: params.resolutionId,
        previousCurrentResolutionId,
        newCurrentResolutionId: previousCurrentResolutionId,
        success: false,
        reason: 'resolution_already_owned',
      }));
      return { metadata: null, result: { ok: false, reason: 'resolution_already_owned' } };
    }

    const next: PendingOrderLines = {
      ...pending,
      lines: pending.lines.map((line) =>
        line.id === params.taskId ? { ...line, currentResolutionId: params.resolutionId } : line
      ),
    };
    const newCurrentResolutionId = next.lines.find((line) => line.id === params.taskId)?.currentResolutionId ?? null;
    console.log(JSON.stringify({
      event: '[TRACE-ORDERLINE]',
      stage: 'associateProductResolutionToTask.result',
      traceId: params.traceId ?? `${params.conversationId}:${params.turnId ?? 'no-turn'}`,
      conversationId: params.conversationId,
      turnId: params.turnId ?? null,
      toolCallId: params.toolCallId ?? null,
      taskId: params.taskId,
      resolutionId: params.resolutionId,
      previousCurrentResolutionId,
      newCurrentResolutionId,
      success: true,
      reason: null,
    }));
    return {
      metadata: { ...metadata, pendingOrderLines: next },
      result: { ok: true, pending: next },
    };
  });
};

export const getNextOrderLineRequiringQuantity = (
  pending: PendingOrderLines | null,
  validationContext?: { metadata?: unknown; businessId?: string; conversationId?: string }
): OrderLine | null => {
  if (!pending) return null;
  const open = pending.lines.filter((line) => line.status === 'active' || line.status === 'queued');
  const isProductBound = (line: OrderLine): boolean => {
    if (!line.currentResolutionId) return false;
    const resolution = validationContext?.metadata && typeof validationContext.metadata === 'object'
      ? (validationContext.metadata as Record<string, unknown>).productResolutions
      : undefined;
    const productResolutions = Array.isArray(resolution)
      ? (resolution as Array<Partial<ProductResolution>>)
      : [];
    const match = productResolutions.find(
      (candidate) =>
        candidate.resolutionId === line.currentResolutionId &&
        (candidate.businessId == null || !validationContext?.businessId || candidate.businessId === validationContext.businessId) &&
        (candidate.conversationId == null || !validationContext?.conversationId || candidate.conversationId === validationContext.conversationId)
    );
    if (match) {
      return validateCurrentProductResolutionForTask({
        task: line,
        businessId: validationContext?.businessId,
        conversationId: validationContext?.conversationId,
        resolution: match,
      }).ok;
    }
    return Boolean(line.currentResolutionId);
  };

  return (
    open.find((line) => line.status === 'active' && line.requestedQuantity == null && isProductBound(line)) ??
    open.find((line) => line.status === 'queued' && line.requestedQuantity == null && isProductBound(line)) ??
    null
  );
};

/** Persist a confirmed quantity without advancing the order-line lifecycle. */
export const setOrderLineRequestedQuantity = async (params: {
  conversationId: string;
  metadata: unknown;
  orderLineId: string;
  quantity: number;
}): Promise<PendingOrderLines | null> => {
  const pending = getPendingOrderLines(params.metadata);
  if (!pending || !Number.isInteger(params.quantity) || params.quantity < 1 || params.quantity > 99) {
    return null;
  }
  const target = pending.lines.find(
    (line) => line.id === params.orderLineId &&
      (line.status === 'active' || line.status === 'queued')
  );
  if (!target) return null;

  const validation = validateCurrentProductResolutionForTask({
    task: target,
    conversationId: params.conversationId,
    resolution:
      (typeof (params.metadata as Record<string, unknown>)?.productResolutions === 'object' &&
        Array.isArray((params.metadata as Record<string, unknown>).productResolutions))
        ? ((params.metadata as Record<string, unknown>).productResolutions as Array<Partial<ProductResolution>>).find(
            (candidate) => candidate.resolutionId === target.currentResolutionId
          ) ?? null
        : null,
  });
  if (!validation.ok) return null;

  const next: PendingOrderLines = {
    ...pending,
    lines: pending.lines.map((line) =>
      line.id === target.id ? { ...line, requestedQuantity: params.quantity } : line
    ),
  };
  await patchConversationMetadata(params.conversationId, { pendingOrderLines: next });
  return next;
};

const STOPWORDS = new Set([
  'de',
  'del',
  'la',
  'las',
  'el',
  'los',
  'un',
  'una',
  'unos',
  'unas',
  'con',
  'sin',
  'al',
  'a',
  'y',
  'e',
  'en',
  'para',
  'por',
]);

/**
 * Relleno de hints de sección ("algo de beber"): no cuentan como token de
 * plato al decidir si containsIngredient recortó un nombre. No van en
 * STOPWORDS global: eso afectaría el match línea ↔ catálogo.
 */
const HINT_SECTION_FILLERS = new Set([
  'algo',
  'algun',
  'alguna',
  'alguno',
  'algunos',
  'algunas',
  'poco',
  'poca',
  'tipo',
  'cosa',
  'cosas',
]);

/** Tokens comparables: sin acentos, sin stopwords, singular simple (papas → papa). */
const matchTokens = (value: string): Set<string> => {
  const tokens = value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length >= 3 && !STOPWORDS.has(token))
    .map((token) => (token.endsWith('s') ? token.slice(0, -1) : token));
  return new Set(tokens);
};

const dishTokens = (value: string): Set<string> => {
  const out = new Set<string>();
  for (const token of matchTokens(value)) {
    if (!HINT_SECTION_FILLERS.has(token)) out.add(token);
  }
  return out;
};
/**
 * `containsIngredient` está recortando un hint de plato ("papa" ⊂ "papas a
 * la huancaína"). Parsing de argumento de tool vs Fact de sesión — no del
 * mensaje del cliente.
 *
 * Si el hint no tiene tokens de más que el filtro (p. ej. "una bebida" /
 * "algo de beber"), no dispara: ahí el camino correcto es categoría, no
 * vectorial.
 */
export const ingredientFilterCarvesDishHint = (
  hint: string,
  containsIngredient: string | null | undefined
): boolean => {
  const ingredient = containsIngredient?.trim();
  if (!ingredient) return false;
  const hintTokens = dishTokens(hint);
  const ingredientTokens = dishTokens(ingredient);
  if (hintTokens.size === 0 || ingredientTokens.size === 0) return false;
  for (const t of ingredientTokens) {
    if (!hintTokens.has(t)) return false;
  }
  return hintTokens.size > ingredientTokens.size;
};

/** Cómo resolver la línea activa: plato → vectorial; sección → categoría. */
export const buildOrderLineSearchInstruction = (hint: string): string =>
  `Trabajá ahora "${hint}" según el tipo de hint: ` +
  `si nombra un plato (ej. "papas a la huancaína", "ceviche"), llamá search_products(keyword="${hint}") ` +
  `con el hint ENTERO — PROHIBIDO find_products_by_filter(containsIngredient) recortando el hint ` +
  `(ej. "papa" a partir de "papas a la huancaína": eso suma otro plato). ` +
  `Si el hint es sección o rol ("algo de beber", "una bebida", "postre", "entrada"), ` +
  `NO uses search_products de esa frase: get_categories + present_category, ` +
  `o find_products_by_filter(categoryTag=DRINK/DESSERT/STARTER/...).`;

/**
 * Qué línea abierta de la cola corresponde al producto que se está agregando.
 *
 * Determinístico y permitido por la norma: valida un **argumento de tool**
 * (`productId` → nombre del catálogo) contra el Fact de sesión; NO parsea el
 * mensaje del cliente. Se busca entre todas las líneas abiertas (no solo la
 * activa) porque el drenaje de unívocos (D5) puede cerrar varias en un turno.
 * Sin solapamiento de tokens devuelve null: mejor caer al flujo de hoy que
 * aplicar la cantidad de otra línea.
 */
/**
 * Línea abierta que esta búsqueda (count 0) ya agotó.
 *
 * Valida el keyword de `search_products` contra el hint de la cola: no mira
 * el mensaje del cliente. Cubre el plato entero (cada token del hint está en
 * el keyword). Un recorte ("papa" contra "papas a la huancaína") no cierra
 * la línea: esa búsqueda no fue del plato.
 */
export const resolveMissedSearchOrderLine = (
  pending: PendingOrderLines | null,
  keyword: string
): OrderLine | null => {
  if (!pending) return null;
  const keywordTokens = dishTokens(keyword);
  if (keywordTokens.size === 0) return null;

  const open = pending.lines.filter(
    (l) => l.status === 'queued' || l.status === 'active'
  );

  let best: { line: OrderLine; score: number } | null = null;
  for (const line of open) {
    if (ingredientFilterCarvesDishHint(line.hint, keyword)) continue;
    const hintTokens = dishTokens(line.hint);
    if (hintTokens.size === 0) continue;
    let covered = 0;
    for (const token of hintTokens) {
      if (keywordTokens.has(token)) covered += 1;
    }
    if (covered !== hintTokens.size) continue;
    const prefer =
      !best ||
      covered > best.score ||
      (covered === best.score &&
        line.status === 'active' &&
        best.line.status !== 'active');
    if (prefer) best = { line, score: covered };
  }
  return best?.line ?? null;
};

export const resolveOrderLineForProduct = (
  pending: PendingOrderLines | null,
  productName: string
): OrderLine | null => {
  if (!pending) return null;
  const productTokens = matchTokens(productName);
  if (productTokens.size === 0) return null;

  const open = pending.lines.filter(
    (l) => l.status === 'queued' || l.status === 'active'
  );

  let best: { line: OrderLine; score: number } | null = null;
  for (const line of open) {
    let score = 0;
    for (const token of matchTokens(line.hint)) {
      if (productTokens.has(token)) score += 1;
    }
    if (score === 0) continue;
    // Empate: gana la línea activa (o la primera abierta, por orden del pedido).
    if (!best || score > best.score) best = { line, score };
  }
  return best?.line ?? null;
};

/** Cualquier línea aún sin cerrar (D7): gate para COMPLETAR_PEDIDO / SUGERIR_COMPLEMENTO. */
export const hasOpenOrderLines = (metadata: unknown): boolean => {
  const pending = getPendingOrderLines(metadata);
  if (!pending) return false;
  return pending.lines.some((l) => l.status === 'queued' || l.status === 'active');
};

/**
 * Línea abierta sin cantidad ("una bebida"). El Goal de personas existe para
 * sugerir unidades, así que con la cola entera cuantificada no tiene nada que
 * aportar: sin esto el Goal se abría igual, gastaba una de sus 3 apariciones
 * por turno y le metía al prompt un "preguntá personas primero" que el gate de
 * `add_cart_item` ya iba a ignorar (D3).
 */
export const hasOpenOrderLineWithoutQuantity = (metadata: unknown): boolean => {
  const pending = getPendingOrderLines(metadata);
  if (!pending) return false;
  return pending.lines.some(
    (l) => (l.status === 'queued' || l.status === 'active') && l.requestedQuantity == null
  );
};

export const countOpenOrderLines = (pending: PendingOrderLines | null): number => {
  if (!pending) return 0;
  return pending.lines.filter((l) => l.status === 'queued' || l.status === 'active').length;
};

/**
 * Normaliza un argumento de `plan_order_lines`: el modelo tiende a dejar la
 * cantidad dentro del hint ("2 papas a la huancaína") y `requestedQuantity`
 * vacío. La línea queda entonces "sin cantidad" y D3 vuelve blocking el Goal de
 * personas, así que el bot pregunta personas por un pedido que ya venía con las
 * unidades dichas (evidencia: conversación del 20/8 19:20).
 *
 * Es parsing de un **argumento de tool**, no del mensaje del cliente: la norma
 * lo permite igual que `matchVariation` o `resolveOrderLineForProduct`.
 *
 * Solo dígitos: "una bebida" sigue siendo línea sin cantidad (D4 — el artículo
 * no es un número dicho). Riesgo conocido: un hint que empiece con número por
 * el nombre del plato ("3 quesos") se lee como cantidad; el modelo debería
 * mandar el plato completo ("pizza 3 quesos").
 */
export const normalizeOrderLineInput = (line: {
  hint: string;
  requestedQuantity?: number | null;
}): { hint: string; requestedQuantity: number | null } => {
  const explicit =
    line.requestedQuantity != null && line.requestedQuantity >= 1
      ? Math.min(99, Math.floor(line.requestedQuantity))
      : null;

  const trimmed = line.hint.trim();
  const match = /^(\d{1,2})\s*(?:[x×]\s*)?(.{3,})$/.exec(trimmed);
  if (!match) {
    return { hint: trimmed, requestedQuantity: explicit };
  }

  const parsed = Number(match[1]);
  const rest = match[2].trim();
  if (!Number.isFinite(parsed) || parsed < 1 || rest.length < 3) {
    return { hint: trimmed, requestedQuantity: explicit };
  }

  // El hint pierde el número siempre (mejora el search y el match de línea);
  // la cantidad explícita del modelo, si vino, manda sobre la del hint.
  return { hint: rest, requestedQuantity: explicit ?? Math.min(99, parsed) };
};

/**
 * Alta de la cola (D2). Con 1 sola línea no vale la pena persistir cola:
 * el llamador decide si igual quiere crearla (p. ej. para no reescribir la
 * tool); acá solo se valida y arma el objeto.
 */
export const setPendingOrderLines = async (params: {
  conversationId: string;
  lines: Array<{ hint: string; requestedQuantity?: number | null }>;
  sourceMessage: string;
}): Promise<PendingOrderLines> => {
  const cleaned = params.lines
    .map(normalizeOrderLineInput)
    .filter((l) => l.hint.length > 0)
    .slice(0, ORDER_LINES_MAX);

  const lines: OrderLine[] = cleaned.map((l, idx) => ({
    id: randomUUID().slice(0, 8),
    hint: l.hint,
    requestedQuantity: l.requestedQuantity,
    status: idx === 0 ? 'active' : 'queued',
    currentResolutionId: null,
  }));

  const pending: PendingOrderLines = {
    lines,
    sourceMessage: params.sourceMessage.slice(0, 500),
    createdAt: new Date().toISOString(),
  };

  await patchConversationMetadata(params.conversationId, {
    pendingOrderLines: pending,
  });
  return pending;
};

/** Materializes requested PEDIR products as lines only when no plan exists yet. */
export const ensurePendingOrderLinesFromRequest = async (params: {
  conversationId: string;
  request: Record<string, unknown>;
  sourceMessage: string;
  metadata: unknown;
}): Promise<PendingOrderLines | null> => {
  const existing = getPendingOrderLines(params.metadata);
  if (existing) return existing;
  const products = Array.isArray(params.request.products)
    ? params.request.products.flatMap((product) => {
        if (typeof product === 'string' && product.trim()) return [{ hint: product.trim() }];
        if (isRecord(product)) {
          const hint = [product.hint, product.name, product.product]
            .find((value): value is string => typeof value === 'string' && value.trim().length > 0);
          const requestedQuantity =
            typeof product.quantity === 'number' && Number.isInteger(product.quantity) &&
            product.quantity >= 1 && product.quantity <= 99
              ? product.quantity
              : null;
          if (hint) return [{ hint: hint.trim(), requestedQuantity }];
        }
        return [];
      })
    : [];
  if (products.length === 0) return null;
  return setPendingOrderLines({
    conversationId: params.conversationId,
    lines: products,
    sourceMessage: params.sourceMessage,
  });
};

export const clearPendingOrderLines = async (conversationId: string): Promise<void> => {
  await omitConversationMetadataKeys(conversationId, [PENDING_ORDER_LINES_KEY]);
};

/**
 * Cierra la línea activa (add exitoso o cancelación) y deja la siguiente en
 * `queued` — NO la activa todavía (D6): eso pasa recién cuando el cliente
 * dice que sigue.
 */
export type OrderLineCloseFailure =
  | 'order_line_id_required'
  | 'order_line_not_found'
  | 'order_line_not_open'
  | 'order_line_ambiguous';

export class OrderLineCloseError extends Error {
  constructor(readonly reason: OrderLineCloseFailure) {
    super(reason);
    this.name = 'OrderLineCloseError';
  }
}

/** Closes one exact Task; active-line fallback requires explicit generic-flow opt-in. */
export const advanceAfterLineClose = async (params: {
  conversationId: string;
  lineId?: string | null;
  allowActiveFallback?: boolean;
  closeStatus: 'done' | 'cancelled';
}): Promise<PendingOrderLines | null> => {
  const result = await mutateConversationMetadata<
    | { ok: true; pending: PendingOrderLines | null }
    | { ok: false; reason: OrderLineCloseFailure }
  >(params.conversationId, (metadata) => {
    const pending = getPendingOrderLines(metadata);
    if (!pending) {
      return params.lineId != null
        ? { metadata: null, result: { ok: false, reason: 'order_line_not_found' } }
        : { metadata: null, result: { ok: true, pending: null } };
    }

    let target: OrderLine | null;
    if (params.lineId != null) {
      target = pending.lines.find((line) => line.id === params.lineId) ?? null;
      if (!target) {
        return { metadata: null, result: { ok: false, reason: 'order_line_not_found' } };
      }
    } else if (params.allowActiveFallback) {
      target = getActiveOrderLine(pending);
    } else {
      return { metadata: null, result: { ok: false, reason: 'order_line_id_required' } };
    }

    if (!target) return { metadata: null, result: { ok: true, pending: null } };
    if (target.status !== 'active' && target.status !== 'queued') {
      return { metadata: null, result: { ok: false, reason: 'order_line_not_open' } };
    }

    const next: PendingOrderLines = {
      ...pending,
      lines: pending.lines.map((line) =>
        line.id === target.id ? { ...line, status: params.closeStatus } : line
      ),
    };
    const stillOpen = next.lines.some((line) => line.status === 'queued' || line.status === 'active');
    if (!stillOpen) {
      const nextMetadata = { ...metadata };
      delete nextMetadata[PENDING_ORDER_LINES_KEY];
      return { metadata: nextMetadata, result: { ok: true, pending: null } };
    }
    return {
      metadata: { ...metadata, pendingOrderLines: next },
      result: { ok: true, pending: next },
    };
  });

  if (!result.ok) throw new OrderLineCloseError(result.reason);
  return result.pending;
};

export type ActivateNextOrderLineResult =
  | { outcome: 'activated'; pending: PendingOrderLines; activatedLine: OrderLine }
  | { outcome: 'already_active'; pending: PendingOrderLines; activeLine: OrderLine }
  | { outcome: 'no_queued_lines'; pending: PendingOrderLines | null };

/**
 * El cliente confirma que sigue con la cola: activa la próxima `queued`.
 * `activated` es el único resultado con transición QUEUED → ACTIVE persistida.
 */
export const activateNextOrderLine = async (
  conversationId: string,
  metadata: unknown
): Promise<ActivateNextOrderLineResult> => {
  const pending = getPendingOrderLines(metadata);
  if (!pending) return { outcome: 'no_queued_lines', pending: null };
  const activeLine = pending.lines.find((l) => l.status === 'active');
  if (activeLine) return { outcome: 'already_active', pending, activeLine };
  const nextQueuedIdx = pending.lines.findIndex((l) => l.status === 'queued');
  if (nextQueuedIdx === -1) return { outcome: 'no_queued_lines', pending };
  const activatedLine: OrderLine = { ...pending.lines[nextQueuedIdx], status: 'active' };
  const nextLines = pending.lines.map((l, idx) => (idx === nextQueuedIdx ? activatedLine : l));
  const next: PendingOrderLines = { ...pending, lines: nextLines };
  await patchConversationMetadata(conversationId, { pendingOrderLines: next });
  return { outcome: 'activated', pending: next, activatedLine };
};

/** Cancela una línea puntual por id o por hint (match laxo, primera coincidencia). */
export const cancelOrderLine = async (params: {
  conversationId: string;
  metadata: unknown;
  lineId?: string | null;
  hint?: string | null;
}): Promise<PendingOrderLines | null> => {
  if (params.lineId != null) {
    return advanceAfterLineClose({
      conversationId: params.conversationId,
      lineId: params.lineId,
      closeStatus: 'cancelled',
    });
  }

  const hint = params.hint?.trim();
  if (params.hint != null && !hint) {
    throw new OrderLineCloseError('order_line_not_found');
  }
  const pending = getPendingOrderLines(params.metadata);
  if (!pending) {
    if (hint) throw new OrderLineCloseError('order_line_not_found');
    return null;
  }
  const matchingHintLines = hint
    ? pending.lines.filter(
        (line) =>
          (line.status === 'queued' || line.status === 'active') &&
          line.hint.toLowerCase().includes(hint.toLowerCase())
      )
    : [];
  if (hint && matchingHintLines.length === 0) {
    throw new OrderLineCloseError('order_line_not_found');
  }
  if (matchingHintLines.length > 1) {
    throw new OrderLineCloseError('order_line_ambiguous');
  }
  const target = hint ? matchingHintLines[0] : getActiveOrderLine(pending);
  if (!target) return null;
  return advanceAfterLineClose({
    conversationId: params.conversationId,
    lineId: target.id,
    closeStatus: 'cancelled',
  });
};

/**
 * D6 — tras cerrar una línea con cola restante: instrucción para que el
 * ÚLTIMO mensaje del turno ofrezca seguir con la próxima o cancelar el
 * resto, sin arrancar la siguiente búsqueda a ciegas en el mismo turno.
 */
export const buildOrderLinesContinueOrCancelHint = (
  pending: PendingOrderLines
): { nextHint: string; remaining: number; instruction: string } | null => {
  const nextQueued = pending.lines.find((l) => l.status === 'queued');
  if (!nextQueued) return null;
  const remaining = countOpenOrderLines(pending);
  const qtyLabel = nextQueued.requestedQuantity
    ? ` (${nextQueued.requestedQuantity}×)`
    : '';
  return {
    nextHint: nextQueued.hint,
    remaining,
    instruction:
      `Quedan ${remaining} línea(s) de la cola de pedido. En tu mensaje de cierre de este turno, ` +
      `ofrecé seguir con *${nextQueued.hint}*${qtyLabel} o cancelar el resto — NO arranques ` +
      `search_products/present_product_cta de esa línea en este mismo turno; esperá la respuesta. ` +
      `PROHIBIDO present_complement_suggestions y preguntar "¿algo más?" mientras la cola siga abierta.`,
  };
};

/**
 * Identificadores para add_cart_item de una Task que ya tiene ProductResolution
 * vigente y propia, y cantidad conocida. Solo expone lo persistido en la Task:
 * sin inferencia por nombre, posición ni última resolución.
 */
const getFulfillmentReadyOrderLine = (
  line: OrderLine,
  metadata: unknown
): { productId: string; resolutionId: string; quantity: number } | null => {
  if (line.requestedQuantity == null || !line.currentResolutionId) return null;
  const current = getCurrentProductResolutionForTask({ task: line, metadata });
  if (!current.ok || typeof current.resolution.productId !== 'string') return null;
  const ownership = validateTaskResolutionOwnership({
    metadata,
    taskId: line.id,
    resolutionId: line.currentResolutionId,
  });
  if (!ownership.ok) return null;
  return {
    productId: current.resolution.productId,
    resolutionId: line.currentResolutionId,
    quantity: line.requestedQuantity,
  };
};

/** Ledger para el híbrido (misma filosofía que pendingAddQuantity / pendingItemNote). */
export const buildPendingOrderLinesContextLines = (
  metadata: unknown,
  options: { quantityGoalActive?: boolean } = {}
): string[] => {
  const pending = getPendingOrderLines(metadata);
  if (!pending) return [];
  const quantityTarget = getNextOrderLineRequiringQuantity(pending);
  // Solo una línea ACTIVE es trabajo actual: una QUEUED se activa con
  // continue_order_line(), no se presenta como activa en el contexto.
  const active = pending.lines.find((l) => l.status === 'active') ?? null;
  const queued = pending.lines.filter(
    (l) => l.status === 'queued' && l.id !== active?.id
  );

  const activeLabel = active
    ? `*${active.hint}*${active.requestedQuantity ? ` (${active.requestedQuantity}×)` : ''} [orderLineId: ${active.id}]`
    : null;
  const queuedLabels = queued.map(
    (l) => `*${l.hint}*${l.requestedQuantity ? ` (${l.requestedQuantity}×)` : ''} [orderLineId: ${l.id}]`
  );

  if (!activeLabel && queuedLabels.length === 0) return [];

  if (quantityTarget && options.quantityGoalActive) {
    return [
      `- Cola de pedido: ${pending.lines
        .filter((line) => line.status === 'active' || line.status === 'queued')
        .map((line) => `${line.id}=${line.hint} (quantity=${line.requestedQuantity ?? 'UNKNOWN'}, status=${line.status})`)
        .join('; ')}. ` +
        `El Goal de cantidad determina el target: ${quantityTarget.id} (${quantityTarget.hint}). ` +
        'En este turno resolvé SOLO la cantidad que responde al Goal; no busques ni agregues líneas ' +
        'hasta que el Goal deje de estar abierto.',
    ];
  }

  if (!active && queuedLabels.length > 0) {
    return [
      `- Cola de pedido: no hay una línea activa actualmente. Existe una línea pendiente en la cola: ` +
        `${queuedLabels.join(', ')}. ` +
        `Continuá con la siguiente línea usando continue_order_line() cuando el cliente confirme que sigue ` +
        `("seguí", "dale", "sí"); la tool decide cuál activar. NO busques ni resuelvas productos de la cola ` +
        `(search_products / resolve_product) antes de que continue_order_line() la active. ` +
        `"cancelá el resto"/"nada más" → clear_pending_order_lines(). ` +
        `PROHIBIDO ofrecer complementos (present_complement_suggestions) o abrir COMPLETAR_PEDIDO mientras esta cola siga abierta.`,
    ];
  }

  const fulfillmentReady = active ? getFulfillmentReadyOrderLine(active, metadata) : null;
  if (active && fulfillmentReady) {
    return [
      `- Cola de pedido: la línea activa *${active.hint}* ya tiene producto resuelto y cantidad confirmada ` +
        `[orderLineId: ${active.id}, productId: ${fulfillmentReady.productId}, ` +
        `resolutionId: ${fulfillmentReady.resolutionId}, quantity: ${fulfillmentReady.quantity}]` +
        (queuedLabels.length > 0 ? `. Después faltan: ${queuedLabels.join(', ')}.` : '.') +
        ` NO vuelvas a buscar ni listar este producto. Si el cliente confirma el agregado, llamá ` +
        `add_cart_item(productId="${fulfillmentReady.productId}", resolutionId="${fulfillmentReady.resolutionId}", ` +
        `orderLineId="${active.id}", quantity=${fulfillmentReady.quantity}) con esos identificadores exactos ` +
        `(variación si el producto la requiere). ` +
        `Al cerrar la línea (add exitoso o el cliente cancela esa línea), el sistema avanza la cola solo; ` +
        `en tu último mensaje del turno ofrecé seguir con la próxima o cancelar el resto ` +
        `(NO preguntes "¿algo más?" genérico, nombrá el hint siguiente). ` +
        `"seguí"/"dale con..." → continuá con esa línea; "cancelá el resto"/"nada más" → clear_pending_order_lines(). ` +
        `PROHIBIDO ofrecer complementos (present_complement_suggestions) o abrir COMPLETAR_PEDIDO mientras esta cola siga abierta.`,
    ];
  }

  const parts: string[] = [];
  parts.push(
    `- Cola de pedido (varios platos en un mismo mensaje; NO es confirmación de cantidad): ` +
      `línea activa ahora → ${activeLabel ?? 'ninguna (activá la próxima con la tool que corresponda)'}` +
      (queuedLabels.length > 0 ? `. Después faltan: ${queuedLabels.join(', ')}.` : '.') +
      ` Trabajá SOLO la línea activa. ${buildOrderLineSearchInstruction(active?.hint ?? '')} ` +
      `Variación y cantidad de esa línea, como el flujo normal ` +
      `— NO relistes ni ofrezcas las demás como si fueran shortlist ahora. ` +
      `Si el requestedQuantity de la línea existe, PRIORIZALO sobre ceil(personas/porción) al sugerir/ask de cantidad. ` +
      `Al cerrar la línea (add exitoso o el cliente cancela esa línea), el sistema avanza la cola solo; ` +
      `en tu último mensaje del turno ofrecé seguir con la próxima o cancelar el resto ` +
      `(NO preguntes "¿algo más?" genérico, nombrá el hint siguiente). ` +
      `"seguí"/"dale con..." → continuá con esa línea; "cancelá el resto"/"nada más" → clear_pending_order_lines(). ` +
      `PROHIBIDO ofrecer complementos (present_complement_suggestions) o abrir COMPLETAR_PEDIDO mientras esta cola siga abierta.`
  );
  return parts;
};

import { AIMessage, BaseMessage, ToolMessage } from '@langchain/core/messages';
import type { ToolCall } from '@langchain/core/messages/tool';
import type { RunnableConfig } from '@langchain/core/runnables';
import { Command, isCommand, Send } from '@langchain/langgraph';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { getHumanIntentState, type HumanIntentRecord } from '../services/humanIntentState.service';
import { resolveProductForAdd } from '../services/productResolution.service';
import type { ProductResolution } from '../services/productResolution.service';
import {
  getFulfillmentReadyOrderLine,
  getPendingOrderLines,
  getTaskCanonicalResolution,
} from '../services/pendingOrderLines.service';
import { evaluateToolRequirement } from '../services/requirementEvaluator';
import {
  partySizeRequiredPayload,
  rememberPartySizeBlockedFood,
  summarizeBlockedAdd,
} from '../services/partySizeGoal.service';
import {
  DEFAULT_TOOL_CONTRACTS,
  findDeclaredProducer,
  PRODUCT_RESOLUTION,
  type ToolRequirementType,
} from './toolContracts';
import { ToolExecutor } from './toolExecutor';
import { planToolCalls } from './toolPlanner';
import { PostEffectToolNode } from './postEffectToolNode';

const uuidSchema = z.string().uuid();

const normalizeTarget = (value: string): string =>
  value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');

const matchesPhrase = (candidate: string, requestValue: string): boolean => {
  const target = normalizeTarget(candidate);
  const request = normalizeTarget(requestValue);
  if (!target || !request) return false;
  if (target === request) return true;
  return target.startsWith(`${request} `) || target.endsWith(` ${request}`);
};

const REQUEST_TARGET_KEY_RE =
  /product|plato|dish|category|categoria|tag|keyword|query|ingredient|producto|target/i;

export const collectRequestTargets = (value: unknown, key = ''): string[] => {
  if (Array.isArray(value)) {
    // Elemento enriquecido de un array ya identificado como "de productos"
    // (ej. request.products = [{name, note?, quantity?}]): el target es el
    // nombre del producto, no "note"/"quantity" — no ampliamos la regex a
    // "name" en general para no generar falsos positivos en otros campos.
    const isProductArray = REQUEST_TARGET_KEY_RE.test(key);
    return value.flatMap((item) => {
      if (isProductArray && typeof item === 'object' && item !== null && !Array.isArray(item)) {
        const name = [
          (item as Record<string, unknown>).name,
          (item as Record<string, unknown>).hint,
          (item as Record<string, unknown>).product,
        ].find((v): v is string => typeof v === 'string' && v.trim().length > 0);
        if (name) return [name];
      }
      return collectRequestTargets(item, key);
    });
  }
  if (typeof value === 'string') {
    return REQUEST_TARGET_KEY_RE.test(key) ? [value] : [];
  }
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([childKey, child]) =>
    collectRequestTargets(child, childKey)
  );
};

const resolveMenuItemName = async (businessId: string, productId: string): Promise<string | null> => {
  const row = await prisma.menu_item.findFirst({
    where: { id: productId, business_id: businessId },
    select: { name: true },
  });
  return row?.name ?? null;
};

const resolveCategoryName = async (businessId: string, categoryId: string): Promise<string | null> => {
  const row = await prisma.menu_category.findFirst({
    where: { id: categoryId, business_id: businessId },
    select: { name: true },
  });
  return row?.name ?? null;
};

const stringArray = (value: unknown): string[] => {
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  }
  return [];
};

const toolTargets = async (
  name: string,
  rawArgs: unknown,
  businessId: string
): Promise<string[] | null> => {
  if (typeof rawArgs !== 'object' || rawArgs === null || Array.isArray(rawArgs)) return null;
  const args = rawArgs as Record<string, unknown>;
  switch (name) {
    case 'search_products':
    case 'suggest_dishes_for_party_size':
      return stringArray(args.keyword);
    case 'find_products_by_filter':
      {
        const targets = [
        ...stringArray(args.categoryTag),
        ...stringArray(args.containsIngredient),
        ...stringArray(args.excludesIngredient),
        ];
        if (typeof args.categoryId === 'string') {
          const category = await resolveCategoryName(businessId, args.categoryId);
          if (category) targets.push(category);
        }
        return targets.length > 0 ? targets : null;
      }
    case 'present_category':
    case 'get_menu_by_category': {
      const id = typeof args.categoryId === 'string' ? args.categoryId : null;
      if (!id) return null;
      const nameValue = await resolveCategoryName(businessId, id);
      return nameValue ? [nameValue] : null;
    }
    case 'add_cart_item':
    case 'check_product_availability': {
      const nameValue = typeof args.productName === 'string' ? args.productName : null;
      if (nameValue) return [nameValue];
      const id = typeof args.productId === 'string' ? args.productId : null;
      if (!id || !uuidSchema.safeParse(id).success) return null;
      const productName = await resolveMenuItemName(businessId, id);
      return productName ? [productName] : null;
    }
    case 'cancel_order':
      return stringArray(args.target);
    case 'get_products_details_by_ids': {
      const ids = stringArray(args.productIds);
      if (ids.length === 0) return null;
      const rows = await prisma.menu_item.findMany({
        where: { id: { in: ids }, business_id: businessId },
        select: { name: true },
      });
      return rows.map((row) => row.name);
    }
    case 'present_product_cta': {
      const labels = [
        ...stringArray(args.productHint),
        ...stringArray(args.productHints),
      ];
      const ids = [
        ...stringArray(args.productId),
        ...stringArray(args.productIds),
      ];
      if (ids.length > 0) {
        const rows = await prisma.menu_item.findMany({
          where: { id: { in: ids }, business_id: businessId },
          select: { name: true },
        });
        labels.push(...rows.map((row) => row.name));
      }
      return labels.length > 0 ? labels : null;
    }
    default:
      return null;
  }
};

const matchesIntent = (intent: HumanIntentRecord, targets: string[]): boolean => {
  const requestTargets = collectRequestTargets(intent.request);
  return requestTargets.some((requestTarget) =>
    targets.some((target) => matchesPhrase(target, requestTarget))
  );
};

export const HUMAN_INTENT_TOOL_DENIED = 'human_intent_pending_tool_denied';
export const HUMAN_INTENT_STATE_STALE = 'human_intent_state_stale';
export const HUMAN_INTENT_STATE_UNAVAILABLE = 'human_intent_state_unavailable';

/**
 * `human_intent_incompatible` no es un conflicto con otra intención PENDING
 * (eso es HUMAN_INTENT_TOOL_DENIED, ver abajo): es que la intención ACTIVE no
 * autoriza comprometer un producto a una compra. La recuperación no es
 * "esperá a ACTIVE" (ACTIVE ya es lo que se está atendiendo) sino "no hay
 * ninguna otra tool equivalente para lograr lo mismo — respondé con lo que ya
 * sabés del producto". Sin esta instrucción explícita, el modelo reintenta la
 * misma acción prohibida vía present_product_cta(ADD_ITEM) (que antes no
 * tenía este guard) u otra tool de compra.
 */
const HUMAN_INTENT_INCOMPATIBLE_INSTRUCTION =
  'Esta operación compromete el producto a una compra, pero la intención activa no es PEDIR. ' +
  'No reintentes agregarlo ni mostrar un CTA de compra sobre él por ninguna otra tool en este turno ' +
  '(ni add_cart_item ni present_product_cta con primaryKind ADD_ITEM). Si ya tenés los datos del ' +
  'producto (de search_products, find_products_by_filter o get_products_details_by_ids en este turno), ' +
  'respondé la consulta activa con esos datos. Si te faltan, llamá get_products_details_by_ids con el ' +
  'productId, sin agregarlo al carrito.';

const internalToolError = (call: ToolCall, code: string, intentId?: string): ToolMessage =>
  new ToolMessage({
    name: call.name,
    tool_call_id: call.id ?? '',
    status: 'error',
    content: JSON.stringify({
      success: false,
      error: code,
      ...(intentId ? { pendingIntentId: intentId } : {}),
      instruction:
        code === 'human_intent_incompatible'
          ? HUMAN_INTENT_INCOMPATIBLE_INSTRUCTION
          : 'No ejecutes esta intención pendiente en este turno. Continuá exclusivamente con ACTIVE.',
    }),
  });

const PRODUCT_SEARCH_TOOLS = new Set(['search_products', 'find_products_by_filter']);

const productIdFrom = (call: ToolCall): string | null => {
  const args = call.args as Record<string, unknown>;
  return typeof args.productId === 'string' ? args.productId : null;
};

const validatedProductResolutionFor = (
  message: ToolMessage,
  call: ToolCall
): { productId: string; resolutionId?: string } | null => {
  if (message.status !== 'success' || typeof message.content !== 'string') return null;
  try {
    const result = JSON.parse(message.content) as Record<string, unknown>;
    const expectedResolutionId = (call.args as Record<string, unknown>).resolutionId;
    const valid =
      result.success === true &&
      result.productId === productIdFrom(call) &&
      (typeof expectedResolutionId !== 'string' || result.resolutionId === expectedResolutionId);
    if (!valid || typeof result.productId !== 'string') return null;
    return {
      productId: result.productId,
      ...(typeof result.resolutionId === 'string' ? { resolutionId: result.resolutionId } : {}),
    };
  } catch {
    return null;
  }
};

const matchingValidatedResolutionFromContext = (
  call: { name: string; args?: Record<string, unknown> },
  results: Array<{ callName: string; status?: string; result?: unknown }> = [],
  expected: { businessId?: string; conversationId?: string; turnId?: string } = {}
): ProductResolution | undefined => {
  const currentProductId = typeof call.args?.productId === 'string' ? call.args.productId : null;
  const currentResolutionId = typeof call.args?.resolutionId === 'string'
    ? call.args.resolutionId
    : undefined;

  const candidate = [...results].reverse().find((result) => {
    if (result.callName !== 'resolve_product' || result.status !== 'EXECUTED') return false;
    const payload = (() => {
      if (result.result == null) return undefined;
      if (typeof result.result === 'string') {
        try {
          const parsed = JSON.parse(result.result) as unknown;
          return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : undefined;
        } catch {
          return undefined;
        }
      }
      if (typeof result.result === 'object') {
        if ('content' in result.result && typeof (result.result as { content?: unknown }).content === 'string') {
          try {
            const parsed = JSON.parse((result.result as { content: string }).content) as unknown;
            return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : undefined;
          } catch {
            return undefined;
          }
        }
        return result.result as Record<string, unknown>;
      }
      return undefined;
    })();
    if (
      payload == null ||
      payload.success !== true ||
      typeof payload.productId !== 'string' ||
      typeof payload.resolutionId !== 'string' ||
      typeof payload.businessId !== 'string' ||
      typeof payload.conversationId !== 'string' ||
      payload.status !== 'selected' ||
      !['turn', 'conversation', 'pending'].includes(String(payload.scope)) ||
      typeof payload.createdAt !== 'string' ||
      !(payload.expiresAt === null || typeof payload.expiresAt === 'string')
    ) return false;
    if (currentProductId && payload.productId !== currentProductId) return false;
    if (currentResolutionId && payload.resolutionId !== currentResolutionId) {
      return false;
    }
    if (expected.businessId && payload.businessId !== expected.businessId) return false;
    if (expected.conversationId && payload.conversationId !== expected.conversationId) return false;
    if (payload.expiresAt && (!Number.isFinite(Date.parse(String(payload.expiresAt))) || Date.parse(String(payload.expiresAt)) <= Date.now())) return false;
    if (payload.scope === 'turn' && payload.turnId !== expected.turnId) return false;
    return true;
  });

  if (!candidate) return undefined;
  const payload = (() => {
    if (candidate.result == null) return undefined;
    if (typeof candidate.result === 'string') {
      try {
        const parsed = JSON.parse(candidate.result) as unknown;
        return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : undefined;
      } catch {
        return undefined;
      }
    }
    if (typeof candidate.result === 'object') {
      if ('content' in candidate.result && typeof (candidate.result as { content?: unknown }).content === 'string') {
        try {
          const parsed = JSON.parse((candidate.result as { content: string }).content) as unknown;
          return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : undefined;
        } catch {
          return undefined;
        }
      }
      return candidate.result as Record<string, unknown>;
    }
    return undefined;
  })();
  if (payload == null || typeof payload !== 'object') return undefined;
  return payload as ProductResolution;
};

const deferredProductAdd = (call: ToolCall): ToolMessage =>
  new ToolMessage({
    name: call.name,
    tool_call_id: call.id ?? '',
    status: 'success',
    content: JSON.stringify({
      success: false,
      error: 'product_resolution_required',
      reason: 'resolution_missing',
      message: 'El producto todavía no tiene una resolución vigente.',
      instruction: 'Esperá los resultados de búsqueda y replanteá en el siguiente paso antes de agregarlo.',
    }),
  });

// Fallas del RequirementEvaluator que pueden significar "la capability declarada
// en el contrato todavía no fue producida para esta Task" (task_resolution_mismatch).
const UNMET_CAPABILITY_BY_DEFER_REASON: Record<string, ToolRequirementType> = {
  task_resolution_mismatch: PRODUCT_RESOLUTION,
};

const TASK_RESOLUTION_ARG_KEYS = ['orderLineId', 'productId', 'resolutionId'] as const;
type TaskResolutionArgs = Record<(typeof TASK_RESOLUTION_ARG_KEYS)[number], string>;

/**
 * Recuperación posible para la Task del orderLineId exacto de la call:
 * - resolve: ACTIVE sin resolución → el productor declarado (resolve_product).
 * - canonical: ACTIVE con resolución canónica válida → reintentar la misma tool
 *   con los IDs persistidos de la Task (nunca los del modelo).
 * - null: QUEUED, cerrada o resolución inválida → fail closed.
 */
type TaskRecovery = { kind: 'resolve' } | { kind: 'canonical'; args: TaskResolutionArgs } | null;

const taskRecoveryFor = async (
  conversationId: string,
  businessId: string,
  call: ToolCall
): Promise<TaskRecovery> => {
  const orderLineId = (call.args as Record<string, unknown> | undefined)?.orderLineId;
  if (typeof orderLineId !== 'string') return null;
  const metadata = (await prisma.conversation_state.findUnique({
    where: { conversation_id: conversationId },
    select: { metadata: true },
  }))?.metadata;
  const task = getPendingOrderLines(metadata)?.lines.find((line) => line.id === orderLineId);
  if (!task || task.status !== 'active') return null;
  if (task.currentResolutionId == null) return { kind: 'resolve' };
  const canonical = getTaskCanonicalResolution(task, metadata, { businessId, conversationId });
  return canonical ? { kind: 'canonical', args: canonical } : null;
};

/**
 * `productId`/`resolutionId` canónicos de una Task lista para fulfillment
 * (mismo criterio que `fulfillmentTransitionFor` en postEffectToolNode.ts),
 * para que `add_cart_item` nunca dependa de que el modelo copie bien un
 * identificador largo recién ofrecido por `set_order_line_quantity`.
 * `quantity` no se toca acá: addCartItemTool ya descarta el valor del modelo
 * y usa el persistido (single source of truth, no se duplica esa lógica).
 * Sin Task lista (vencida, no ACTIVE, etc.) devuelve null — fail closed,
 * el llamador no sustituye nada y el flujo de rechazo/reintento sigue igual.
 */
const canonicalAddCartItemArgs = async (
  conversationId: string,
  businessId: string,
  orderLineId: string
): Promise<{ productId: string; resolutionId: string } | null> => {
  const metadata = (await prisma.conversation_state.findUnique({
    where: { conversation_id: conversationId },
    select: { metadata: true },
  }))?.metadata;
  const task = getPendingOrderLines(metadata)?.lines.find((line) => line.id === orderLineId);
  if (!task || task.status !== 'active') return null;
  const ready = getFulfillmentReadyOrderLine(task, metadata, { businessId, conversationId });
  return ready ? { productId: ready.productId, resolutionId: ready.resolutionId } : null;
};

const nextRequiredToolFor = (
  call: ToolCall,
  reason: string,
  recovery: TaskRecovery
): { kind: 'resolve' | 'canonical'; tool: string; args: TaskResolutionArgs } | null => {
  if (!recovery) return null;
  const capability = UNMET_CAPABILITY_BY_DEFER_REASON[reason];
  if (!capability) return null;
  // La Task ya tiene la capability (resolución propia): se reintenta la misma tool con los IDs canónicos.
  if (recovery.kind === 'canonical') return { kind: 'canonical', tool: call.name, args: recovery.args };
  // Sin resolución: productor declarado + IDs copiados tal cual de la call diferida.
  const tool = findDeclaredProducer(call.name, capability);
  if (!tool) return null;
  const callArgs = (call.args ?? {}) as Record<string, unknown>;
  if (!TASK_RESOLUTION_ARG_KEYS.every((key) => typeof callArgs[key] === 'string')) return null;
  return {
    kind: 'resolve',
    tool,
    args: {
      orderLineId: callArgs.orderLineId as string,
      productId: callArgs.productId as string,
      resolutionId: callArgs.resolutionId as string,
    },
  };
};

const TASK_RESOLUTION_REJECTIONS = new Set(['task_resolution_mismatch', 'task_already_associated']);

/**
 * Rechazo de resolución Task-bound sin recuperación (fail closed): el turno
 * termina con una respuesta segura en vez de reintentar hasta el recursionLimit.
 * Incluye operar una Task no ACTIVE (task_not_active): esa línea se activa recién
 * con continue_order_line en otro turno.
 */
export const isFailClosedTaskRejection = (payload: unknown): boolean => {
  if (typeof payload !== 'object' || payload === null) return false;
  const data = payload as Record<string, unknown>;
  if (data.success !== false) return false;
  if (data.reason === 'task_not_active' || data.error === 'task_not_active') return true;
  return (
    typeof data.reason === 'string' &&
    TASK_RESOLUTION_REJECTIONS.has(data.reason) &&
    data.nextRequiredTool === undefined
  );
};

/** orderLineId de una recuperación canónica (reintento con la resolución de la Task), o null. */
export const canonicalRecoveryOrderLineId = (payload: unknown): string | null => {
  if (typeof payload !== 'object' || payload === null) return null;
  const data = payload as Record<string, unknown>;
  const args = data.nextRequiredToolArgs as { orderLineId?: unknown } | undefined;
  return data.success === false &&
    typeof data.reason === 'string' &&
    TASK_RESOLUTION_REJECTIONS.has(data.reason) &&
    data.nextRequiredTool === 'add_cart_item' &&
    typeof args?.orderLineId === 'string'
    ? args.orderLineId
    : null;
};

/**
 * Única representación de "este turno necesita input humano": un resultado de
 * tool fallido que trae la pregunta para el cliente (askMessage) y ningún paso
 * de tool pendiente (nextRequiredTool). Un DEFER con nextRequiredTool sigue
 * siendo accionable por el modelo en el mismo turno.
 */
export const requiresUserInput = (payload: unknown): payload is { askMessage: string } => {
  if (typeof payload !== 'object' || payload === null) return false;
  const data = payload as Record<string, unknown>;
  return (
    data.success === false &&
    typeof data.askMessage === 'string' &&
    data.askMessage.trim().length > 0 &&
    data.nextRequiredTool === undefined
  );
};

/**
 * Fulfillment de una Task: add_cart_item persistió el ítem y cerró la OrderLine
 * exacta (DONE). Es límite de turno: la siguiente línea de la cola se trabaja
 * recién en otro turno, vía continue_order_line.
 */
export const completesTask = (payload: unknown): boolean => {
  if (typeof payload !== 'object' || payload === null) return false;
  const data = payload as Record<string, unknown>;
  const effect = data.effect as { kind?: unknown } | undefined;
  const closed = data.closedOrderLine as { id?: unknown; status?: unknown } | undefined;
  return (
    data.success === true &&
    effect?.kind === 'cart_item_persisted' &&
    typeof closed?.id === 'string' &&
    closed.status === 'done'
  );
};

const deferredRequirement = (
  call: ToolCall,
  reason: string,
  missingRequirements: string[] = [],
  askMessage?: string,
  recovery: TaskRecovery = null
): ToolMessage => {
  const normalizedReason = reason === 'quantity_required' || reason === 'order_line_quantity_required' || reason === 'variation_required' || reason === 'party_size_required'
    ? reason
    : 'product_resolution_required';

  const labels: Record<string, string> = {
    product_resolution_required: 'El producto todavía no tiene una resolución vigente.',
    quantity_required: 'Falta la cantidad del producto.',
    order_line_quantity_required: 'La línea del pedido todavía no tiene una cantidad confirmada.',
    variation_required: 'Falta la variación del producto.',
    party_size_required: 'Falta la cantidad de personas para el pedido.',
    product_id_required: 'Falta identificar el producto.',
    human_intent_incompatible: 'La operación no corresponde al HumanIntent activo.',
  };

  const nextRequired = nextRequiredToolFor(call, reason, recovery);
  return new ToolMessage({
    name: call.name,
    tool_call_id: call.id ?? '',
    status: 'success',
    content: JSON.stringify({
      success: false,
      error: normalizedReason,
      reason,
      missingRequirements,
      message: nextRequired?.kind === 'canonical'
        ? 'La línea ya tiene una resolución válida asociada.'
        : nextRequired
          ? 'La resolución del producto todavía no está asociada a esta línea del pedido.'
          : labels[normalizedReason] ?? 'La operación todavía no está autorizada.',
      ...(askMessage ? { askMessage } : {}),
      ...(nextRequired
        ? { nextRequiredTool: nextRequired.tool, nextRequiredToolArgs: nextRequired.args }
        : {}),
      instruction: nextRequired?.kind === 'canonical'
        ? `La línea ya tiene una resolución válida. Reintentá ${call.name} usando exactamente ` +
          'nextRequiredToolArgs (copiá el resolutionId sin modificarlo). No vuelvas a buscar ni resolver el producto.'
        : nextRequired
        ? `No reintentes ${call.name} todavía. Primero llamá ${nextRequired.tool} con exactamente ` +
          `nextRequiredToolArgs (copiá los valores sin modificarlos); después reintentá ${call.name} ` +
          'con los mismos identificadores.'
        : normalizedReason === 'order_line_quantity_required'
          ? 'No agregues el producto. Preguntá cuántas unidades quiere y esperá su respuesta; la cantidad se persiste con set_order_line_quantity.'
          : 'Esperá a que se satisfagan los requisitos del flujo antes de ejecutar esta tool.',
    }),
  });
};

/**
 * Mensaje para un `add_cart_item` diferido en la rama de batch (search/resolve
 * del mismo lote). Con recuperación canónica (Task ACTIVE con `currentResolutionId`
 * propio vigente — ver `associateKnownIdentityForActiveLine`), reutiliza el
 * mismo formato accionable que ya usa el camino solo-add vía `requirementEvaluator`
 * ('task_resolution_mismatch' + recovery), en vez del mensaje genérico sin
 * siguiente acción (`deferredProductAdd`). Sin recuperación determinable,
 * conserva el rechazo seguro existente — nunca inventa un `nextRequiredTool`.
 */
const deferredAddMessage = (call: ToolCall, recovery: TaskRecovery): ToolMessage =>
  recovery?.kind === 'canonical'
    ? deferredRequirement(call, 'task_resolution_mismatch', ['TASK_RESOLUTION_PAIR'], undefined, recovery)
    : deferredProductAdd(call);

const traceIdFor = (conversationId?: string, turnId?: string): string | null =>
  conversationId ? `${conversationId}:${turnId ?? 'no-turn'}` : null;

export class HumanIntentToolNode extends PostEffectToolNode {
  protected override async run(input: unknown, config: RunnableConfig) {
    const messages: BaseMessage[] = Array.isArray(input)
      ? input as BaseMessage[]
      : typeof input === 'object' && input !== null && 'messages' in input && Array.isArray(input.messages)
        ? input.messages as BaseMessage[]
        : [];
    const aiMessage = [...messages].reverse().find((message) => message.getType() === 'ai');
    const calls = aiMessage instanceof AIMessage ? aiMessage.tool_calls : undefined;
    if (!calls?.length) return super.run(input, config);

    const completedCallIds = new Set(
      messages
        .filter((message): message is ToolMessage => ToolMessage.isInstance(message))
        .map((message) => message.tool_call_id)
    );
    const pendingCalls = calls.filter((call) => call.id == null || !completedCallIds.has(call.id));
    if (pendingCalls.length === 0) return super.run(input, config);

    // Un turno que acepta una oferta de compra (add_cart_item / present_product_cta
    // ADD_ITEM) no debe arrastrar, como efecto incidental de la misma iteración, un
    // save_party_size cuyo count sea idéntico a serves_people del producto que se
    // está comprometiendo — esa coincidencia es la firma exacta de confundir "rinde
    // para N personas" (dato del plato) con comensales (dato que solo el cliente
    // puede dar). No se toca activeBlockingGoal (el Goal de personas está
    // deshabilitado como bloqueante, ver dispatch/index.ts) ni se exige evidencia
    // textual: solo se rechaza la coincidencia exacta y trazable con el catálogo.
    const commitToCartCalls = pendingCalls.filter(
      (call) =>
        call.name === 'add_cart_item' ||
        (call.name === 'present_product_cta' &&
          (call.args as Record<string, unknown>)?.primaryKind === 'ADD_ITEM')
    );
    const savePartySizeCall = pendingCalls.find((call) => call.name === 'save_party_size');
    let partySizeServesPeopleCollisionCallId: string | null = null;
    if (savePartySizeCall && commitToCartCalls.length > 0) {
      const count = (savePartySizeCall.args as Record<string, unknown>)?.count;
      const productIds = [
        ...new Set(
          commitToCartCalls
            .map((call) => (call.args as Record<string, unknown>)?.productId)
            .filter((id): id is string => typeof id === 'string')
        ),
      ];
      if (typeof count === 'number' && productIds.length > 0) {
        const servedRows = await prisma.menu_item.findMany({
          where: { id: { in: productIds } },
          select: { serves_people: true },
        });
        if (servedRows.some((row) => row.serves_people === count)) {
          partySizeServesPeopleCollisionCallId = savePartySizeCall.id ?? null;
        }
      }
    }
    if (partySizeServesPeopleCollisionCallId) {
      config = {
        ...config,
        configurable: {
          ...config.configurable,
          partySizeServesPeopleCollisionCallId,
        },
      };
    }

    const goalConfig = config.configurable as {
      activeBlockingGoal?: unknown;
      goalFulfillmentCandidate?: {
        goalType?: unknown;
        target?: { orderLineId?: unknown; hint?: unknown };
      };
    } | undefined;
    const quantityGoalActive =
      goalConfig?.activeBlockingGoal === 'OBTENER_CANTIDAD_DEL_PRODUCTO' &&
      goalConfig.goalFulfillmentCandidate?.goalType === 'OBTENER_CANTIDAD_DEL_PRODUCTO';
    const targetOrderLineId = typeof goalConfig?.goalFulfillmentCandidate?.target?.orderLineId === 'string'
      ? goalConfig.goalFulfillmentCandidate.target.orderLineId
      : undefined;
    const mismatchedQuantityCall = quantityGoalActive
      ? pendingCalls.find((call) => {
          if (call.name !== 'set_order_line_quantity') return false;
          const suppliedId = (call.args as Record<string, unknown>).orderLineId;
          return typeof suppliedId === 'string' && suppliedId !== targetOrderLineId;
        })
      : undefined;
    const missingQuantityTarget = quantityGoalActive && !targetOrderLineId &&
      pendingCalls.some((call) => call.name === 'set_order_line_quantity');
    if (mismatchedQuantityCall || missingQuantityTarget) {
      const receivedOrderLineId = (mismatchedQuantityCall?.args as Record<string, unknown> | undefined)
        ?.orderLineId;
      const reason = mismatchedQuantityCall ? 'goal_target_mismatch' : 'goal_target_missing';
      const outputs = pendingCalls.map((call) => new ToolMessage({
        name: call.name,
        tool_call_id: call.id ?? '',
        status: 'error',
        content: JSON.stringify({
          success: false,
          error: reason,
          ...(targetOrderLineId ? { expectedOrderLineId: targetOrderLineId } : {}),
          ...(call === mismatchedQuantityCall && typeof receivedOrderLineId === 'string'
            ? { receivedOrderLineId }
            : {}),
          instruction: 'No ejecutes otras tools en este turno. Conservá el target explícito del Quantity Goal.',
        }),
      }));
      const hint = typeof goalConfig?.goalFulfillmentCandidate?.target?.hint === 'string'
        ? goalConfig.goalFulfillmentCandidate.target.hint
        : 'el producto pendiente';
      const finalResponse = new AIMessage({
        content: `No pude registrar la cantidad de ${hint}. La cantidad sigue pendiente; indicá nuevamente cuántas unidades querés.`,
      });
      return Array.isArray(input)
        ? [...outputs, finalResponse]
        : { messages: [...outputs, finalResponse] };
    }

    const hasSearchResolutionChain =
      pendingCalls.some((call) => PRODUCT_SEARCH_TOOLS.has(call.name)) &&
      pendingCalls.some((call) => call.name === 'resolve_product');
    if (hasSearchResolutionChain) {
      const configurable = config.configurable as
        | {
            businessId?: unknown;
            conversationId?: unknown;
            turnId?: unknown;
            orderLineId?: unknown;
            humanIntentGateRevision?: unknown;
            turnStartedAt?: unknown;
          }
        | undefined;
      const traceConversationId = typeof configurable?.conversationId === 'string' ? configurable.conversationId : undefined;
      const traceTurnId = typeof configurable?.turnId === 'string' ? configurable.turnId : undefined;
      const traceId = traceIdFor(traceConversationId, traceTurnId) ?? undefined;
      const plannerPlan = planToolCalls(pendingCalls, {
        contracts: DEFAULT_TOOL_CONTRACTS,
        traceContext: {
          traceId,
          conversationId: traceConversationId,
          turnId: traceTurnId,
        },
      });

      const businessId = typeof configurable?.businessId === 'string' ? configurable.businessId : undefined;
      const conversationId = typeof configurable?.conversationId === 'string' ? configurable.conversationId : undefined;
      const turnId = typeof configurable?.turnId === 'string' ? configurable.turnId : undefined;
      const configuredOrderLineId = typeof configurable?.orderLineId === 'string' ? configurable.orderLineId.trim() || undefined : undefined;

      const executor = new ToolExecutor({
        runner: async (call, context) => {
          const resolution = matchingValidatedResolutionFromContext(
            call,
            context.results ?? [],
            { businessId, conversationId, turnId }
          );
          return this.runTool(
            call as ToolCall,
            config,
            resolution ? { productId: resolution.productId, resolutionId: resolution.resolutionId } : undefined,
            false,
            resolution
          );
        },
        evaluator: async ({
          toolName,
          callArgs,
          businessId: execBusinessId,
          conversationId: execConversationId,
          turnId: execTurnId,
          validatedProductResolution,
        }) => {
          const state = conversationId && execConversationId === conversationId
            ? await getHumanIntentState(execConversationId).catch(() => null)
            : null;
          const activeIntent = state?.records.find((record) => record.status === 'ACTIVE') ?? null;
          return evaluateToolRequirement({
            toolName,
            callArgs,
            businessId: execBusinessId,
            conversationId: execConversationId,
            turnId: execTurnId,
            humanIntent: activeIntent,
            state,
            validatedProductResolution,
          });
        },
      });

      const executionResults = await executor.execute(plannerPlan, {
        businessId,
        conversationId,
        turnId,
        traceId,
        orderLineId: configuredOrderLineId,
        humanIntent: (await (conversationId ? getHumanIntentState(conversationId).catch(() => null) : null))?.records.find((record) => record.status === 'ACTIVE') ?? null,
        state: conversationId ? await getHumanIntentState(conversationId).catch(() => null) : null,
      });

      const outputs = executionResults.map((result) => {
        if (result.status === 'REJECTED' || result.status === 'DEFERRED' || result.status === 'BLOCKED') {
          if (typeof result.call.id !== 'string' || result.call.id.length === 0) return undefined;
          return new ToolMessage({
            name: result.callName,
            tool_call_id: result.call.id,
            status: 'success',
            content: JSON.stringify({
              success: false,
              error: result.reason ?? 'tool_blocked',
              missingRequirements: result.missingRequirements ?? [],
              message: result.reason ?? 'La operación todavía no está autorizada.',
            }),
          });
        }
        return result.result as ToolMessage | Command | undefined;
      }).filter((output): output is NonNullable<typeof output> => output !== undefined);

      if (!outputs.some(isCommand)) return Array.isArray(input) ? outputs : { messages: outputs };

      const combinedOutputs: unknown[] = [];
      let parentSends: Send[] | null = null;
      for (const output of outputs) {
        if (isCommand(output)) {
          if (
            output.graph === Command.PARENT &&
            Array.isArray(output.goto) &&
            output.goto.every((send) => send instanceof Send)
          ) {
            if (parentSends) parentSends.push(...output.goto);
            else parentSends = [...output.goto];
          } else {
            combinedOutputs.push(output);
          }
        } else {
          combinedOutputs.push(Array.isArray(input) ? [output] : { messages: [output] });
        }
      }
      if (parentSends) combinedOutputs.push(new Command({ graph: Command.PARENT, goto: parentSends }));
      return combinedOutputs;
    }

    const addCalls = pendingCalls.filter((call) => call.name === 'add_cart_item');
    const resolutionCalls = pendingCalls.filter((call) => call.name === 'resolve_product');
    const hasProductSearch = pendingCalls.some((call) => PRODUCT_SEARCH_TOOLS.has(call.name));
    const hasSearchResolutionDependency = hasProductSearch && resolutionCalls.length > 0;
    const hasAddDependency = addCalls.length > 0 && (hasProductSearch || resolutionCalls.length > 0);
    if (!hasSearchResolutionDependency && !hasAddDependency) {
      return super.run(input, config);
    }

    const configurable = config.configurable as
      | {
          businessId?: unknown;
          conversationId?: unknown;
          turnId?: unknown;
          orderLineId?: unknown;
          humanIntentGateRevision?: unknown;
          turnStartedAt?: unknown;
        }
      | undefined;
    const orderMetadata = typeof configurable?.conversationId === 'string'
      ? (await prisma.conversation_state.findUnique({
          where: { conversation_id: configurable.conversationId },
          select: { metadata: true },
        }))?.metadata
      : null;
    const hasOpenTaskQueue = Boolean(
      getPendingOrderLines(orderMetadata)?.lines.some(
        (line) => line.status === 'active' || line.status === 'queued'
      )
    );

    const resolutionByAdd = new Map<ToolCall, ToolCall | undefined>();
    for (const addCall of addCalls) {
      const addArgs = addCall.args as Record<string, unknown>;
      const resolutionCall = resolutionCalls.find((call) => {
        const resolutionArgs = call.args as Record<string, unknown>;
        return (
          resolutionArgs.productId === addArgs.productId &&
          (typeof addArgs.resolutionId !== 'string' || resolutionArgs.resolutionId === addArgs.resolutionId)
        );
      });
      if (resolutionCall) {
        resolutionByAdd.set(addCall, resolutionCall);
      }
    }

    const hasMissingResolutionContext =
      typeof configurable?.businessId !== 'string' ||
      typeof configurable?.conversationId !== 'string';
    // Recuperación accionable (TaskRecovery | null) por cada add diferido, en
    // vez de un Set: una Task ACTIVE que YA tiene currentResolutionId propio
    // (ver `associateKnownIdentityForActiveLine` en pendingOrderLines.service.ts)
    // tiene una resolución canónica aunque esta llamada concreta no haya
    // pasado resolutionId — un search_products de OTRO producto en el mismo
    // batch no debe dejarla en un mensaje sin siguiente acción (ver auditoría
    // "bypass de resolución en pedidos auto-creados" / "ciclo de reintentos").
    const deferredAdds = new Map<ToolCall, TaskRecovery>();
    const validatedResolutionByAdd = new Map<
      ToolCall,
      { productId: string; resolutionId?: string }
    >();
    await Promise.all(addCalls.map(async (call) => {
      if (resolutionByAdd.has(call)) return;
      const args = call.args as Record<string, unknown>;
      const explicitTaskId = typeof args.orderLineId === 'string'
        ? args.orderLineId.trim()
        : typeof configurable?.orderLineId === 'string'
          ? configurable.orderLineId.trim()
          : '';
      if (hasOpenTaskQueue || explicitTaskId) {
        if (!explicitTaskId || typeof args.resolutionId !== 'string') {
          const recovery =
            explicitTaskId &&
            typeof configurable?.conversationId === 'string' &&
            typeof configurable?.businessId === 'string'
              ? await taskRecoveryFor(configurable.conversationId, configurable.businessId, call)
              : null;
          deferredAdds.set(call, recovery);
        }
        return;
      }
      if (hasMissingResolutionContext) {
        deferredAdds.set(call, null);
        return;
      }
      const productId = productIdFrom(call);
      if (!productId) {
        deferredAdds.set(call, null);
        return;
      }
      try {
        const resolution = await resolveProductForAdd({
          productId,
          businessId: configurable.businessId as string,
          conversationId: configurable.conversationId as string,
          resolutionId: typeof args.resolutionId === 'string' ? args.resolutionId : undefined,
          turnId: typeof configurable.turnId === 'string' ? configurable.turnId : undefined,
        });
        if (!resolution.ok) {
          deferredAdds.set(call, null);
        } else {
          validatedResolutionByAdd.set(call, {
            productId: resolution.resolution.productId,
            resolutionId: resolution.resolution.resolutionId,
          });
        }
      } catch {
        deferredAdds.set(call, null);
      }
    }));

    const independentCalls = pendingCalls.filter(
      (call) => !resolutionCalls.includes(call) && !addCalls.includes(call)
    );
    const independentResults = await Promise.all(
      independentCalls.map((call) => this.runTool(call, config))
    );
    const resolutionResults = await Promise.all(
      resolutionCalls.map((call) => this.runTool(call, config))
    );
    const resolutionMessages = new Map(
      resolutionCalls.map((call, index) => [call, resolutionResults[index]])
    );
    const addResults = await Promise.all(addCalls.map(async (call) => {
      if (deferredAdds.has(call)) return deferredAddMessage(call, deferredAdds.get(call) ?? null);
      const resolutionCall = resolutionByAdd.get(call);
      let validatedResolution = validatedResolutionByAdd.get(call);
      if (resolutionCall) {
        const result = resolutionMessages.get(resolutionCall);
        if (!(result instanceof ToolMessage)) {
          return deferredProductAdd(call);
        }
        validatedResolution = validatedProductResolutionFor(result, call) ?? undefined;
        if (!validatedResolution) return deferredProductAdd(call);
      }
      return this.runTool(call, config, validatedResolution);
    }));

    const resultByCall = new Map<ToolCall, unknown>();
    independentCalls.forEach((call, index) => resultByCall.set(call, independentResults[index]));
    resolutionCalls.forEach((call, index) => resultByCall.set(call, resolutionResults[index]));
    addCalls.forEach((call, index) => resultByCall.set(call, addResults[index]));
    const outputs = pendingCalls.map((call) => resultByCall.get(call) ?? deferredProductAdd(call));

    if (!outputs.some(isCommand)) return Array.isArray(input) ? outputs : { messages: outputs };

    const combinedOutputs: unknown[] = [];
    let parentSends: Send[] | null = null;
    for (const output of outputs) {
      if (isCommand(output)) {
        if (
          output.graph === Command.PARENT &&
          Array.isArray(output.goto) &&
          output.goto.every((send) => send instanceof Send)
        ) {
          if (parentSends) parentSends.push(...output.goto);
          else parentSends = [...output.goto];
        } else {
          combinedOutputs.push(output);
        }
      } else {
        combinedOutputs.push(Array.isArray(input) ? [output] : { messages: [output] });
      }
    }
    if (parentSends) combinedOutputs.push(new Command({ graph: Command.PARENT, goto: parentSends }));
    return combinedOutputs;
  }

  protected override async runTool(
    call: ToolCall,
    config: RunnableConfig,
    validatedProductResolution?: { productId: string; resolutionId?: string },
    skipRequirementEvaluation = false,
    validatedResolutionFromExecutionContext?: ProductResolution
  ) {
    const configurable = config.configurable as
      | {
          conversationId?: unknown;
          businessId?: unknown;
          orderLineId?: unknown;
          humanIntentGateRevision?: unknown;
          turnId?: unknown;
          turnStartedAt?: unknown;
        }
      | undefined;
    const conversationId = configurable?.conversationId;
    const businessId = configurable?.businessId;
    const expectedRevision = configurable?.humanIntentGateRevision;
    const turnId = configurable?.turnId;
    const turnStartedAt = configurable?.turnStartedAt;
    const traceConversationId = typeof conversationId === 'string' ? conversationId : undefined;
    const traceTurnId = typeof turnId === 'string' ? turnId : undefined;
    const traceId = traceIdFor(traceConversationId, traceTurnId);
    const explicitOrderLineId =
      typeof (call.args as Record<string, unknown>)?.orderLineId === 'string'
        ? String((call.args as Record<string, unknown>).orderLineId).trim() || undefined
        : typeof configurable?.orderLineId === 'string'
          ? String(configurable.orderLineId).trim() || undefined
          : undefined;
    const toolConfig =
      (call.name === 'add_cart_item' &&
      validatedResolutionFromExecutionContext?.productId === productIdFrom(call) &&
      validatedResolutionFromExecutionContext.resolutionId ===
        (typeof (call.args as Record<string, unknown>).resolutionId === 'string'
          ? (call.args as Record<string, unknown>).resolutionId
          : validatedResolutionFromExecutionContext.resolutionId)) ||
      (call.name === 'add_cart_item' && explicitOrderLineId) ||
      (call.name === 'resolve_product' && explicitOrderLineId)
        ? {
            ...config,
            configurable: {
              ...config.configurable,
              ...(call.name === 'add_cart_item'
                ? { validatedProductResolutionFromExecutionContext: validatedResolutionFromExecutionContext }
                : {}),
              ...(explicitOrderLineId ? { orderLineId: explicitOrderLineId } : {}),
              ...(call.id ? { toolCallId: call.id } : {}),
              ...(traceId ? { traceId } : {}),
            },
          }
        : config;
    const tracedToolConfig: RunnableConfig = {
      ...toolConfig,
      configurable: {
        ...(toolConfig.configurable as Record<string, unknown> | undefined),
        ...(call.id ? { toolCallId: call.id } : {}),
        ...(traceId ? { traceId } : {}),
      },
    };

    const modelArgs = (call.args ?? {}) as Record<string, unknown>;
    const configurableOrderLineId =
      typeof configurable?.orderLineId === 'string'
        ? String(configurable.orderLineId).trim() || null
        : null;
    const effectiveOrderLineId = explicitOrderLineId ?? null;
    const source =
      typeof modelArgs.orderLineId === 'string'
        ? 'call.args'
        : configurableOrderLineId
          ? 'configurable'
          : 'none';
    console.log(JSON.stringify({
      event: '[TRACE-ORDERLINE]',
      stage: 'HumanIntentToolNode.before_runTool',
      traceId,
      conversationId: traceConversationId ?? null,
      turnId: traceTurnId ?? null,
      toolCallId: call.id ?? null,
      toolName: call.name,
      modelArgs,
      configurableOrderLineId,
      effectiveOrderLineId,
      source,
    }));

    // Handoffs and legacy direct invocations do not carry a preflight revision.
    if (
      typeof conversationId !== 'string' ||
      typeof businessId !== 'string' ||
      typeof expectedRevision !== 'number'
    ) {
      return super.runTool(call, tracedToolConfig);
    }

    let state;
    try {
      state = await getHumanIntentState(conversationId);
    } catch {
      return internalToolError(call, HUMAN_INTENT_STATE_UNAVAILABLE);
    }

    if (state.revision !== expectedRevision) {
      return internalToolError(call, HUMAN_INTENT_STATE_STALE);
    }

    const active = state.records.find((intent) => intent.status === 'ACTIVE');
    const pending = state.records.filter((intent) => intent.status === 'PENDING');
    if (!active) {
      return super.runTool(call, tracedToolConfig);
    }

    if (call.name === 'save_party_size' && !skipRequirementEvaluation) {
      const collisionCallId = (
        config.configurable as { partySizeServesPeopleCollisionCallId?: unknown } | undefined
      )?.partySizeServesPeopleCollisionCallId;
      if (typeof collisionCallId === 'string' && collisionCallId === call.id) {
        return new ToolMessage({
          name: call.name,
          tool_call_id: call.id ?? '',
          status: 'success',
          content: JSON.stringify({
            success: false,
            error: 'party_size_matches_serves_people',
            instruction:
              'Ese count es igual a serves_people (cuántas personas rinde el plato) del producto que ' +
              'estás agregando en este mismo turno, no un dato que el cliente haya dicho sobre comensales. ' +
              'No llames save_party_size con ese número salvo que el cliente lo haya dicho él mismo como ' +
              'cantidad de personas que van a comer. Si hay otra operación pendiente en este turno (agregar ' +
              'el producto), continuá con ella normalmente.',
          }),
        });
      }
    }

    if (call.name === 'present_product_cta' && !skipRequirementEvaluation) {
      // Mismo guard de compromiso-de-compra que add_cart_item (ver
      // COMMIT_TO_CART_TOOLS en requirementEvaluator): un CTA con
      // primaryKind ADD_ITEM compromete el producto igual que add_cart_item,
      // así que no puede quedar como vía libre cuando ACTIVE no es PEDIR.
      let ctaRequirementDecision;
      try {
        ctaRequirementDecision = await evaluateToolRequirement({
          toolName: call.name,
          callArgs: call.args as Record<string, unknown>,
          businessId,
          conversationId,
          turnId: typeof turnId === 'string' ? turnId : undefined,
          humanIntent: active,
          state,
        });
      } catch {
        return internalToolError(call, 'requirement_evaluation_failed');
      }
      if (ctaRequirementDecision.type === 'REJECT') {
        return internalToolError(call, ctaRequirementDecision.reason);
      }
    }

    if (call.name === 'add_cart_item') {
      // Si la Task ya está lista para fulfillment (cantidad persistida,
      // resolución propia vigente), el runtime reemplaza productId/resolutionId
      // por los canónicos ANTES de evaluar requisitos o ejecutar la tool — el
      // modelo ya no tiene que copiar sin error un identificador largo recién
      // ofrecido por set_order_line_quantity. Sin Task lista, no se toca nada
      // (fail closed): el flujo de rechazo/reintento existente sigue igual.
      let effectiveCall = call;
      if (explicitOrderLineId) {
        const canonical = await canonicalAddCartItemArgs(conversationId, businessId, explicitOrderLineId);
        if (canonical) {
          effectiveCall = {
            ...call,
            args: {
              ...(call.args as Record<string, unknown>),
              productId: canonical.productId,
              resolutionId: canonical.resolutionId,
              orderLineId: explicitOrderLineId,
            },
          };
        }
      }

      let addProductName: string | null = null;
      try {
        const targets = await toolTargets(effectiveCall.name, effectiveCall.args, businessId);
        if (targets?.length) {
          addProductName = targets[0];
          const pendingMatch = pending.find((intent) => matchesIntent(intent, targets));
          if (pendingMatch && !matchesIntent(active, targets)) {
            return internalToolError(effectiveCall, HUMAN_INTENT_TOOL_DENIED, pendingMatch.id);
          }
        }
      } catch {
        // Requirement evaluation remains authoritative if a display target cannot be loaded.
      }

      if (!skipRequirementEvaluation) {
        let requirementDecision;
        try {
          requirementDecision = await evaluateToolRequirement({
            toolName: effectiveCall.name,
            callArgs: effectiveCall.args as Record<string, unknown>,
            businessId,
            conversationId,
            turnId: typeof turnId === 'string' ? turnId : undefined,
            humanIntent: active,
            state,
            validatedProductResolution,
          });
        } catch {
          return internalToolError(effectiveCall, 'requirement_evaluation_failed');
        }

        if (requirementDecision.type === 'DEFER') {
          if (requirementDecision.reason === 'party_size_required') {
            const args = effectiveCall.args as Record<string, unknown>;
            const heldOrder = await rememberPartySizeBlockedFood(
              conversationId,
              {
                source: 'lookup',
                summary: summarizeBlockedAdd({
                  name: addProductName ?? '',
                  quantity: typeof args.quantity === 'number' ? args.quantity : null,
                  variation: typeof args.variation === 'string' ? args.variation : null,
                }),
              },
              typeof turnStartedAt === 'string' ? turnStartedAt : undefined
            );
            const payload = {
              ...partySizeRequiredPayload(heldOrder),
              missingRequirements: requirementDecision.missingRequirements,
            };
            return new ToolMessage({
              name: effectiveCall.name,
              tool_call_id: effectiveCall.id ?? '',
              status: 'success',
              content: JSON.stringify(payload),
            });
          }
          return deferredRequirement(
            effectiveCall,
            requirementDecision.reason,
            requirementDecision.missingRequirements,
            requirementDecision.reason === 'order_line_quantity_required'
              ? `¿Cuántas unidades${addProductName ? ` de ${addProductName}` : ''} querés agregar?`
              : undefined,
            requirementDecision.reason in UNMET_CAPABILITY_BY_DEFER_REASON
              ? await taskRecoveryFor(conversationId, businessId, effectiveCall)
              : null
          );
        }
        if (requirementDecision.type === 'REJECT') {
          return internalToolError(effectiveCall, requirementDecision.reason);
        }
      }
      return super.runTool(effectiveCall, tracedToolConfig);
    }

    if (pending.length === 0) return super.runTool(call, tracedToolConfig);

    try {
      const targets = await toolTargets(call.name, call.args, businessId);
      if (!targets || targets.length === 0) {
        return super.runTool(call, tracedToolConfig);
      }

      const pendingMatch = pending.find((intent) => matchesIntent(intent, targets));
      if (!pendingMatch || matchesIntent(active, targets)) {
        return super.runTool(call, tracedToolConfig);
      }
      return internalToolError(call, HUMAN_INTENT_TOOL_DENIED, pendingMatch.id);
    } catch {
      // A target that cannot be resolved is not clearly attributable to PENDING.
      return super.runTool(call, tracedToolConfig);
    }
  }
}

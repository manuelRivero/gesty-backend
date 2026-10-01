export const PRODUCT_CANDIDATE = 'PRODUCT_CANDIDATE' as const;
export const PRODUCT_RESOLUTION = 'PRODUCT_RESOLUTION' as const;
export const CART_ITEM_PERSISTED = 'CART_ITEM_PERSISTED' as const;
export const ORDER_LINE_QUANTITY_PERSISTED = 'ORDER_LINE_QUANTITY_PERSISTED' as const;

export type ToolRequirementType =
  | typeof PRODUCT_CANDIDATE
  | typeof PRODUCT_RESOLUTION
  | typeof CART_ITEM_PERSISTED
  | typeof ORDER_LINE_QUANTITY_PERSISTED
  | string;

export type ToolScope = Record<string, string | undefined>;

export type ToolRequirement = {
  type: ToolRequirementType;
  scope?: ToolScope;
};

export type ToolCapability = {
  type: ToolRequirementType;
  scope?: ToolScope;
};

export type ToolContract = {
  name: string;
  requires?: ToolRequirement[];
  produces?: ToolCapability[];
};

export type ToolCallLike = {
  id?: string;
  name: string;
  args?: Record<string, unknown>;
};

export const DEFAULT_TOOL_CONTRACTS: ToolContract[] = [
  {
    name: 'search_products',
    produces: [{ type: PRODUCT_CANDIDATE }],
  },
  {
    name: 'find_products_by_filter',
    produces: [{ type: PRODUCT_CANDIDATE }],
  },
  {
    name: 'resolve_product',
    requires: [{ type: PRODUCT_CANDIDATE }],
    produces: [{ type: PRODUCT_RESOLUTION }],
  },
  {
    name: 'add_cart_item',
    requires: [{ type: PRODUCT_RESOLUTION }],
    produces: [{ type: CART_ITEM_PERSISTED }],
  },
  {
    name: 'set_order_line_quantity',
    produces: [{ type: ORDER_LINE_QUANTITY_PERSISTED }],
  },
];

export const scopeMatches = (left?: ToolScope, right?: ToolScope): boolean => {
  const entries = new Set<string>([
    ...Object.keys(left ?? {}),
    ...Object.keys(right ?? {}),
  ]);

  for (const key of entries) {
    const leftValue = left?.[key];
    const rightValue = right?.[key];
    if (leftValue == null || rightValue == null) continue;
    if (leftValue !== rightValue) return false;
  }

  return true;
};

export const requirementMatchesCapability = (
  requirement: ToolRequirement,
  capability: ToolCapability
): boolean => {
  if (requirement.type !== capability.type) return false;
  return scopeMatches(requirement.scope, capability.scope);
};

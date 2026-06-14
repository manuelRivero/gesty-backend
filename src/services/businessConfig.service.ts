import { prisma } from "../lib/prisma";

export type BusinessConfig = {
  bot_enabled: boolean;
  allow_human_handoff: boolean;
  human_handoff_auto_timeout_minutes: number | null;
  send_idle_reminders: boolean;
  idle_reminder_minutes: number;
  idle_close_minutes: number;
  send_order_reminders: boolean;
  draft_order_reminder_minutes: number;
  draft_order_expire_minutes: number;
  reservations_enabled: boolean;
  reservation_min_lead_minutes: number;
  reservation_max_days_ahead: number;
  reservation_default_duration_minutes: number;
  reservation_require_confirmation: boolean;
  reservation_allow_same_day: boolean;
  orders_enabled: boolean;
  checkout_enabled: boolean;
  delivery_enabled: boolean;
  takeaway_enabled: boolean;
  pickup_instructions: string | null;
  humanize_messages: boolean;
  operate_when_closed: boolean;
  orders_when_closed: boolean;
};

const DEFAULT_CONFIG: BusinessConfig = {
  bot_enabled: true,
  allow_human_handoff: true,
  human_handoff_auto_timeout_minutes: null,
  send_idle_reminders: true,
  idle_reminder_minutes: 1,
  idle_close_minutes: 2,
  send_order_reminders: true,
  draft_order_reminder_minutes: 1,
  draft_order_expire_minutes: 2,
  reservations_enabled: true,
  reservation_min_lead_minutes: 60,
  reservation_max_days_ahead: 30,
  reservation_default_duration_minutes: 90,
  reservation_require_confirmation: true,
  reservation_allow_same_day: true,
  orders_enabled: true,
  checkout_enabled: true,
  delivery_enabled: true,
  takeaway_enabled: false,
  pickup_instructions: null,
  humanize_messages: false,
  operate_when_closed: false,
  orders_when_closed: false
};

export type BusinessConfigPatch = Partial<BusinessConfig>;

export class BusinessConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BusinessConfigValidationError";
  }
}

function normalizePickupInstructions(
  value: string | null | undefined
): string | null | undefined {
  if (typeof value !== "string") {
    return value;
  }
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function applyBusinessConfigRules(config: BusinessConfig): BusinessConfig {
  const next: BusinessConfig = {
    ...config,
    pickup_instructions: normalizePickupInstructions(config.pickup_instructions) ?? null
  };

  if (!next.operate_when_closed) {
    next.orders_when_closed = false;
  }

  if (!next.delivery_enabled && !next.takeaway_enabled) {
    throw new BusinessConfigValidationError(
      "Al menos uno de delivery_enabled o takeaway_enabled debe ser true"
    );
  }

  return next;
}

async function fetchBusinessConfigRow(
  businessId: string
): Promise<BusinessConfig | null> {
  const rows = await prisma.$queryRaw<
    Array<BusinessConfig>
  >`
    SELECT
      bot_enabled,
      allow_human_handoff,
      human_handoff_auto_timeout_minutes,
      send_idle_reminders,
      idle_reminder_minutes,
      idle_close_minutes,
      send_order_reminders,
      draft_order_reminder_minutes,
      draft_order_expire_minutes,
      reservations_enabled,
      reservation_min_lead_minutes,
      reservation_max_days_ahead,
      reservation_default_duration_minutes,
      reservation_require_confirmation,
      reservation_allow_same_day,
      orders_enabled,
      checkout_enabled,
      delivery_enabled,
      takeaway_enabled,
      pickup_instructions,
      humanize_messages,
      operate_when_closed,
      orders_when_closed
    FROM business_config
    WHERE business_id = ${businessId}::uuid
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function getBusinessConfig(businessId: string): Promise<BusinessConfig> {
  const row = await fetchBusinessConfigRow(businessId);
  return row ? { ...DEFAULT_CONFIG, ...row } : { ...DEFAULT_CONFIG };
}

export async function upsertBusinessConfig(
  businessId: string,
  patch: BusinessConfigPatch
): Promise<BusinessConfig> {
  const current = await getBusinessConfig(businessId);
  const next = applyBusinessConfigRules({
    ...current,
    ...patch
  });

  await prisma.$executeRaw`
    INSERT INTO business_config (
      business_id,
      bot_enabled,
      allow_human_handoff,
      human_handoff_auto_timeout_minutes,
      send_idle_reminders,
      idle_reminder_minutes,
      idle_close_minutes,
      send_order_reminders,
      draft_order_reminder_minutes,
      draft_order_expire_minutes,
      reservations_enabled,
      reservation_min_lead_minutes,
      reservation_max_days_ahead,
      reservation_default_duration_minutes,
      reservation_require_confirmation,
      reservation_allow_same_day,
      orders_enabled,
      checkout_enabled,
      delivery_enabled,
      takeaway_enabled,
      pickup_instructions,
      humanize_messages,
      operate_when_closed,
      orders_when_closed
    ) VALUES (
      ${businessId}::uuid,
      ${next.bot_enabled},
      ${next.allow_human_handoff},
      ${next.human_handoff_auto_timeout_minutes},
      ${next.send_idle_reminders},
      ${next.idle_reminder_minutes},
      ${next.idle_close_minutes},
      ${next.send_order_reminders},
      ${next.draft_order_reminder_minutes},
      ${next.draft_order_expire_minutes},
      ${next.reservations_enabled},
      ${next.reservation_min_lead_minutes},
      ${next.reservation_max_days_ahead},
      ${next.reservation_default_duration_minutes},
      ${next.reservation_require_confirmation},
      ${next.reservation_allow_same_day},
      ${next.orders_enabled},
      ${next.checkout_enabled},
      ${next.delivery_enabled},
      ${next.takeaway_enabled},
      ${next.pickup_instructions},
      ${next.humanize_messages},
      ${next.operate_when_closed},
      ${next.orders_when_closed}
    )
    ON CONFLICT (business_id)
    DO UPDATE SET
      bot_enabled = EXCLUDED.bot_enabled,
      allow_human_handoff = EXCLUDED.allow_human_handoff,
      human_handoff_auto_timeout_minutes = EXCLUDED.human_handoff_auto_timeout_minutes,
      send_idle_reminders = EXCLUDED.send_idle_reminders,
      idle_reminder_minutes = EXCLUDED.idle_reminder_minutes,
      idle_close_minutes = EXCLUDED.idle_close_minutes,
      send_order_reminders = EXCLUDED.send_order_reminders,
      draft_order_reminder_minutes = EXCLUDED.draft_order_reminder_minutes,
      draft_order_expire_minutes = EXCLUDED.draft_order_expire_minutes,
      reservations_enabled = EXCLUDED.reservations_enabled,
      reservation_min_lead_minutes = EXCLUDED.reservation_min_lead_minutes,
      reservation_max_days_ahead = EXCLUDED.reservation_max_days_ahead,
      reservation_default_duration_minutes = EXCLUDED.reservation_default_duration_minutes,
      reservation_require_confirmation = EXCLUDED.reservation_require_confirmation,
      reservation_allow_same_day = EXCLUDED.reservation_allow_same_day,
      orders_enabled = EXCLUDED.orders_enabled,
      checkout_enabled = EXCLUDED.checkout_enabled,
      delivery_enabled = EXCLUDED.delivery_enabled,
      takeaway_enabled = EXCLUDED.takeaway_enabled,
      pickup_instructions = EXCLUDED.pickup_instructions,
      humanize_messages = EXCLUDED.humanize_messages,
      operate_when_closed = EXCLUDED.operate_when_closed,
      orders_when_closed = EXCLUDED.orders_when_closed
  `;

  return next;
}

export async function deleteBusinessConfig(businessId: string): Promise<BusinessConfig> {
  return upsertBusinessConfig(businessId, { ...DEFAULT_CONFIG });
}

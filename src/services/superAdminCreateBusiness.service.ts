import { prisma } from "../lib/prisma";
import { hashPassword } from "./auth.service";
import { grantTrialToBusiness } from "./billing/grantTrial.service";
import { DEFAULT_TRIAL_DAYS, DEFAULT_TRIAL_PLAN_CODE } from "../constants/billing";
import { toBusinessWithSubscriptionDto } from "./superAdminBusinesses.service";
import type { SuperAdminCreateBusinessResponse } from "../types/superAdminBusiness.dto";

export type SuperAdminCreateBusinessCode =
  | "SLUG_TAKEN"
  | "CURRENCY_INVALID"
  | "PASSWORD_REQUIRED"
  | "EMAIL_INVALID";

export class SuperAdminCreateBusinessError extends Error {
  readonly code: SuperAdminCreateBusinessCode;
  readonly status: number;

  constructor(
    code: SuperAdminCreateBusinessCode,
    message: string,
    status = 400
  ) {
    super(message);
    this.name = "SuperAdminCreateBusinessError";
    this.code = code;
    this.status = status;
  }
}

export type CreateBusinessInput = {
  name: string;
  timezone?: string;
  slug?: string | null;
  currency_code?: string | null;
  street_address?: string | null;
  description?: string | null;
  owner: {
    email: string;
    name: string;
    password?: string;
  };
  trial_days?: number;
};

const DEFAULT_TIMEZONE = "America/Argentina/Buenos_Aires";
const DEFAULT_CURRENCY = "ARS";

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function normalizeName(name: string): string {
  return name.trim().replace(/\s+/g, " ");
}

export function slugifyBusinessName(name: string): string {
  const slug = name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "local";
}

async function resolveUniqueSlug(preferred: string): Promise<string> {
  const base = slugifyBusinessName(preferred);
  const existing = await prisma.business.findUnique({
    where: { slug: base },
    select: { id: true },
  });
  if (!existing) return base;

  for (let i = 2; i <= 20; i++) {
    const candidate = `${base}-${i}`.slice(0, 60);
    const taken = await prisma.business.findUnique({
      where: { slug: candidate },
      select: { id: true },
    });
    if (!taken) return candidate;
  }

  throw new SuperAdminCreateBusinessError(
    "SLUG_TAKEN",
    "No se pudo generar un slug único para este nombre"
  );
}

export async function createBusinessForSuperAdmin(
  input: CreateBusinessInput
): Promise<SuperAdminCreateBusinessResponse> {
  const name = normalizeName(input.name);
  const ownerEmail = normalizeEmail(input.owner.email);
  const ownerName = normalizeName(input.owner.name);

  if (!ownerEmail.includes("@")) {
    throw new SuperAdminCreateBusinessError(
      "EMAIL_INVALID",
      "Email del dueño inválido"
    );
  }

  const currencyCode = (
    input.currency_code?.trim() || DEFAULT_CURRENCY
  ).toUpperCase();
  const currency = await prisma.currency.findUnique({
    where: { code: currencyCode },
    select: { code: true, is_active: true },
  });
  if (!currency?.is_active) {
    throw new SuperAdminCreateBusinessError(
      "CURRENCY_INVALID",
      `Moneda inválida o inactiva: ${currencyCode}`
    );
  }

  const requestedSlug = input.slug?.trim()
    ? slugifyBusinessName(input.slug)
    : await resolveUniqueSlug(name);

  if (input.slug?.trim()) {
    const taken = await prisma.business.findUnique({
      where: { slug: requestedSlug },
      select: { id: true },
    });
    if (taken) {
      throw new SuperAdminCreateBusinessError(
        "SLUG_TAKEN",
        "Ese slug ya está en uso"
      );
    }
  }

  const existingUser = await prisma.appUser.findUnique({
    where: { email: ownerEmail },
  });

  if (!existingUser) {
    const password = input.owner.password?.trim() ?? "";
    if (password.length < 8) {
      throw new SuperAdminCreateBusinessError(
        "PASSWORD_REQUIRED",
        "La contraseña es obligatoria (mínimo 8 caracteres) para un usuario nuevo"
      );
    }
  }

  const passwordHash = existingUser
    ? null
    : await hashPassword(input.owner.password!.trim());

  const created = await prisma.$transaction(async (tx) => {
    const business = await tx.business.create({
      data: {
        name,
        description: input.description?.trim() || null,
        timezone: input.timezone?.trim() || DEFAULT_TIMEZONE,
        slug: requestedSlug,
        currency_code: currencyCode,
        street_address: input.street_address?.trim() || null,
        billing_mode: "subscription",
        ai_plan: DEFAULT_TRIAL_PLAN_CODE,
        ai_blocked: false,
      },
    });

    await tx.business_config.create({
      data: { business_id: business.id },
    });

    let userId: string;
    let ownerCreated = false;

    if (existingUser) {
      userId = existingUser.id;
      await tx.appUser.update({
        where: { id: existingUser.id },
        data: { name: ownerName },
      });
    } else {
      const user = await tx.appUser.create({
        data: {
          email: ownerEmail,
          name: ownerName,
          password_hash: passwordHash!,
        },
      });
      userId = user.id;
      ownerCreated = true;
    }

    await tx.business_user.create({
      data: {
        user_id: userId,
        business_id: business.id,
        role: "OWNER",
      },
    });

    return { businessId: business.id, userId, ownerCreated };
  });

  await grantTrialToBusiness({
    businessId: created.businessId,
    days: input.trial_days ?? DEFAULT_TRIAL_DAYS,
  });

  const row = await prisma.business.findUnique({
    where: { id: created.businessId },
    include: { subscription: true },
  });
  if (!row) {
    throw new Error("Negocio creado no encontrado");
  }

  return {
    ...toBusinessWithSubscriptionDto(row),
    owner: {
      user_id: created.userId,
      email: ownerEmail,
      name: ownerName,
      created: created.ownerCreated,
    },
  };
}

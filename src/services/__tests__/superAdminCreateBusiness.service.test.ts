import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/prisma", () => ({
  prisma: {
    currency: { findUnique: vi.fn() },
    business: {
      findUnique: vi.fn(),
      create: vi.fn()
    },
    business_config: { create: vi.fn() },
    appUser: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn()
    },
    business_user: { create: vi.fn() },
    $transaction: vi.fn()
  }
}));

vi.mock("../auth.service", () => ({
  hashPassword: vi.fn().mockResolvedValue("hashed-password")
}));

vi.mock("../billing/grantTrial.service", () => ({
  grantTrialToBusiness: vi.fn().mockResolvedValue({})
}));

import { prisma } from "../../lib/prisma";
import { hashPassword } from "../auth.service";
import { grantTrialToBusiness } from "../billing/grantTrial.service";
import {
  SuperAdminCreateBusinessError,
  createBusinessForSuperAdmin,
  slugifyBusinessName
} from "../superAdminCreateBusiness.service";

const mockedCurrency = prisma.currency.findUnique as unknown as ReturnType<
  typeof vi.fn
>;
const mockedFindBusiness = prisma.business.findUnique as unknown as ReturnType<
  typeof vi.fn
>;
const mockedFindUser = prisma.appUser.findUnique as unknown as ReturnType<
  typeof vi.fn
>;
const mockedTx = prisma.$transaction as unknown as ReturnType<typeof vi.fn>;
const mockedHash = hashPassword as unknown as ReturnType<typeof vi.fn>;
const mockedGrant = grantTrialToBusiness as unknown as ReturnType<typeof vi.fn>;

function createdRow() {
  const now = new Date();
  const trialEnd = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
  return {
    id: "biz-new",
    name: "Nuevo Local",
    ai_blocked: false,
    ai_monthly_tokens_used: 0,
    ai_monthly_token_limit: 100000,
    ai_plan: "basic",
    ai_reset_at: now,
    created_at: now,
    subscription: {
      status: "trialing",
      is_trial: true,
      trial_end: trialEnd,
      current_period_start: now,
      current_period_end: trialEnd,
      cancel_at_period_end: false
    }
  };
}

describe("slugifyBusinessName", () => {
  it("normaliza acentos y espacios", () => {
    expect(slugifyBusinessName("Sabrosón Palermo")).toBe("sabroson-palermo");
  });
});

describe("createBusinessForSuperAdmin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedCurrency.mockResolvedValue({ code: "ARS", is_active: true });
    mockedFindUser.mockResolvedValue(null);
    mockedFindBusiness.mockResolvedValue(null);
    mockedTx.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        business: {
          create: vi.fn().mockResolvedValue({ id: "biz-new", name: "Nuevo Local" })
        },
        business_config: { create: vi.fn() },
        appUser: {
          create: vi.fn().mockResolvedValue({ id: "user-new" }),
          update: vi.fn()
        },
        business_user: { create: vi.fn() }
      };
      return fn(tx);
    });
  });

  it("crea negocio, owner nuevo y trial", async () => {
    mockedFindBusiness
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(createdRow());

    const configCreate = vi.fn();
    mockedTx.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        business: {
          create: vi.fn().mockResolvedValue({ id: "biz-new", name: "Nuevo Local" })
        },
        business_config: { create: configCreate },
        appUser: {
          create: vi.fn().mockResolvedValue({ id: "user-new" }),
          update: vi.fn()
        },
        business_user: { create: vi.fn() }
      };
      return fn(tx);
    });

    const result = await createBusinessForSuperAdmin({
      name: "Nuevo Local",
      owner: {
        email: "dueno@example.com",
        name: "Ana Dueña",
        password: "Secret123"
      }
    });

    expect(mockedHash).toHaveBeenCalled();
    expect(mockedGrant).toHaveBeenCalledWith({
      businessId: "biz-new",
      days: 7,
    });
    expect(configCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        business_id: "biz-new",
        bot_enabled: true,
        storefront_enabled: true,
        orders_enabled: false,
        checkout_enabled: false,
        reservations_enabled: false,
        delivery_enabled: false,
        takeaway_enabled: false,
        external_delivery_enabled: false,
      }),
    });
    expect(result.id).toBe("biz-new");
    expect(result.owner).toEqual({
      user_id: "user-new",
      email: "dueno@example.com",
      name: "Ana Dueña",
      created: true
    });
    expect(result.is_trial).toBe(true);
    expect(result.access_ok).toBe(true);
  });

  it("adjunta usuario existente sin exigir password", async () => {
    mockedFindUser.mockResolvedValue({ id: "user-old", email: "dueno@example.com" });
    mockedFindBusiness
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(createdRow());

    mockedTx.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        business: {
          create: vi.fn().mockResolvedValue({ id: "biz-new" })
        },
        business_config: { create: vi.fn() },
        appUser: {
          create: vi.fn(),
          update: vi.fn()
        },
        business_user: { create: vi.fn() }
      };
      return fn(tx);
    });

    const result = await createBusinessForSuperAdmin({
      name: "Nuevo Local",
      owner: { email: "dueno@example.com", name: "Ana" }
    });

    expect(mockedHash).not.toHaveBeenCalled();
    expect(result.owner.created).toBe(false);
    expect(result.owner.user_id).toBe("user-old");
  });

  it("exige password si el usuario no existe", async () => {
    await expect(
      createBusinessForSuperAdmin({
        name: "Nuevo Local",
        owner: { email: "nuevo@example.com", name: "Ana" }
      })
    ).rejects.toMatchObject({ code: "PASSWORD_REQUIRED" });
  });

  it("rechaza slug tomado", async () => {
    mockedFindBusiness.mockResolvedValue({ id: "other" });
    await expect(
      createBusinessForSuperAdmin({
        name: "Nuevo",
        slug: "sabroson",
        owner: {
          email: "a@b.com",
          name: "A",
          password: "Secret123"
        }
      })
    ).rejects.toBeInstanceOf(SuperAdminCreateBusinessError);
  });

  it("rechaza moneda inválida", async () => {
    mockedCurrency.mockResolvedValue(null);
    await expect(
      createBusinessForSuperAdmin({
        name: "Nuevo",
        currency_code: "XXX",
        owner: {
          email: "a@b.com",
          name: "A",
          password: "Secret123"
        }
      })
    ).rejects.toMatchObject({ code: "CURRENCY_INVALID" });
  });
});

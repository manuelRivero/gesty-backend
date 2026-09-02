import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BusinessUserRole } from "../../types/auth";

vi.mock("../../lib/prisma", () => ({
  prisma: {
    appUser: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn()
    },
    business_user: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      count: vi.fn()
    },
    $transaction: vi.fn()
  }
}));

vi.mock("../auth.service", () => ({
  hashPassword: vi.fn().mockResolvedValue("hashed-password")
}));

import { prisma } from "../../lib/prisma";
import { hashPassword } from "../auth.service";
import {
  BusinessUserManagementError,
  createAdminBusinessUser,
  deleteAdminBusinessUser,
  listAdminBusinessUsers,
  updateAdminBusinessUser
} from "../adminBusinessUsers.service";

const mockedFindMany = prisma.business_user.findMany as unknown as ReturnType<
  typeof vi.fn
>;
const mockedFindFirst = prisma.business_user.findFirst as unknown as ReturnType<
  typeof vi.fn
>;
const mockedCreateMembership = prisma.business_user
  .create as unknown as ReturnType<typeof vi.fn>;
const mockedCount = prisma.business_user.count as unknown as ReturnType<
  typeof vi.fn
>;
const mockedDelete = prisma.business_user.delete as unknown as ReturnType<
  typeof vi.fn
>;
const mockedFindUser = prisma.appUser.findUnique as unknown as ReturnType<
  typeof vi.fn
>;
const mockedUpdateUser = prisma.appUser.update as unknown as ReturnType<
  typeof vi.fn
>;
const mockedTx = prisma.$transaction as unknown as ReturnType<typeof vi.fn>;
const mockedHash = hashPassword as unknown as ReturnType<typeof vi.fn>;

const ownerActor = { userId: "actor-owner", role: "OWNER" as BusinessUserRole };
const adminActor = { userId: "actor-admin", role: "ADMIN" as BusinessUserRole };

function membershipRow(overrides: {
  id?: string;
  user_id?: string;
  role?: string;
  email?: string;
  name?: string | null;
}) {
  return {
    id: overrides.id ?? "mem-1",
    user_id: overrides.user_id ?? "user-1",
    business_id: "biz-1",
    role: overrides.role ?? "STAFF",
    created_at: new Date("2026-01-01"),
    app_user: {
      id: overrides.user_id ?? "user-1",
      email: overrides.email ?? "staff@example.com",
      name: overrides.name ?? "María García",
      created_at: new Date("2025-12-01")
    }
  };
}

describe("adminBusinessUsers.service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedTx.mockImplementation(async (fn: (tx: typeof prisma) => unknown) =>
      fn(prisma)
    );
  });

  it("lista membresías del tenant en camelCase", async () => {
    mockedFindMany.mockResolvedValueOnce([
      membershipRow({ id: "mem-1", role: "OWNER", email: "owner@ex.com" })
    ]);

    const items = await listAdminBusinessUsers({ businessId: "biz-1" });

    expect(mockedFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { business_id: "biz-1" } })
    );
    expect(items[0]).toMatchObject({
      id: "mem-1",
      email: "owner@ex.com",
      name: "María García",
      role: "OWNER"
    });
  });

  it("crea un usuario nuevo con password hasheado y nombre", async () => {
    mockedFindUser.mockResolvedValueOnce(null);
    const createdUser = { id: "user-new", email: "nuevo@ex.com" };
    (prisma.appUser.create as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      createdUser
    );
    mockedCreateMembership.mockResolvedValueOnce(
      membershipRow({
        id: "mem-new",
        user_id: "user-new",
        role: "STAFF",
        email: "nuevo@ex.com",
        name: "Juan Pérez"
      })
    );

    const row = await createAdminBusinessUser({
      businessId: "biz-1",
      actor: ownerActor,
      email: " Nuevo@ex.com ",
      name: "  Juan   Pérez ",
      role: "STAFF",
      password: "secret123"
    });

    expect(mockedHash).toHaveBeenCalledWith("secret123");
    expect(prisma.appUser.create).toHaveBeenCalledWith({
      data: {
        email: "nuevo@ex.com",
        name: "Juan Pérez",
        password_hash: "hashed-password"
      }
    });
    expect(row.email).toBe("nuevo@ex.com");
    expect(row.name).toBe("Juan Pérez");
    expect(row.role).toBe("STAFF");
  });

  it("adjunta membresía a un usuario existente y actualiza el nombre", async () => {
    mockedFindUser.mockResolvedValueOnce({ id: "user-2", email: "ya@ex.com" });
    mockedFindFirst.mockResolvedValueOnce(null);
    mockedUpdateUser.mockResolvedValueOnce({ id: "user-2" });
    mockedCreateMembership.mockResolvedValueOnce(
      membershipRow({
        id: "mem-2",
        user_id: "user-2",
        role: "ADMIN",
        email: "ya@ex.com",
        name: "Ana López"
      })
    );

    await createAdminBusinessUser({
      businessId: "biz-1",
      actor: ownerActor,
      email: "ya@ex.com",
      name: "Ana López",
      role: "ADMIN",
      password: "ignored-here"
    });

    expect(prisma.appUser.create).not.toHaveBeenCalled();
    expect(mockedHash).not.toHaveBeenCalled();
    expect(mockedUpdateUser).toHaveBeenCalledWith({
      where: { id: "user-2" },
      data: { name: "Ana López" }
    });
    expect(mockedCreateMembership).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          user_id: "user-2",
          business_id: "biz-1",
          role: "ADMIN"
        }
      })
    );
  });

  it("rechaza membresía duplicada", async () => {
    mockedFindUser.mockResolvedValueOnce({ id: "user-2", email: "ya@ex.com" });
    mockedFindFirst.mockResolvedValueOnce({ id: "mem-dup" });

    await expect(
      createAdminBusinessUser({
        businessId: "biz-1",
        actor: ownerActor,
        email: "ya@ex.com",
        name: "Staff",
        role: "STAFF"
      })
    ).rejects.toMatchObject({ code: "ALREADY_MEMBER" });
  });

  it("un ADMIN no puede crear un OWNER", async () => {
    await expect(
      createAdminBusinessUser({
        businessId: "biz-1",
        actor: adminActor,
        email: "dueño@ex.com",
        name: "Dueño",
        role: "OWNER",
        password: "secret123"
      })
    ).rejects.toBeInstanceOf(BusinessUserManagementError);
  });

  it("no permite asignar SUPER_ADMIN", async () => {
    await expect(
      createAdminBusinessUser({
        businessId: "biz-1",
        actor: ownerActor,
        email: "x@ex.com",
        name: "X",
        role: "SUPER_ADMIN",
        password: "secret123"
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN_ROLE" });
  });

  it("exige password al crear un usuario nuevo", async () => {
    mockedFindUser.mockResolvedValueOnce(null);

    await expect(
      createAdminBusinessUser({
        businessId: "biz-1",
        actor: ownerActor,
        email: "nuevo@ex.com",
        name: "Nuevo",
        role: "STAFF"
      })
    ).rejects.toMatchObject({ code: "PASSWORD_REQUIRED" });
  });

  it("actualiza el nombre de la cuenta", async () => {
    mockedFindFirst.mockResolvedValueOnce(
      membershipRow({
        id: "mem-staff",
        user_id: "user-staff",
        role: "STAFF",
        name: "Nombre viejo"
      })
    );
    mockedUpdateUser.mockResolvedValueOnce({ id: "user-staff" });
    (prisma.business_user.update as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      membershipRow({
        id: "mem-staff",
        user_id: "user-staff",
        role: "STAFF",
        name: "Nombre nuevo"
      })
    );

    const row = await updateAdminBusinessUser({
      businessId: "biz-1",
      actor: ownerActor,
      id: "mem-staff",
      name: "  Nombre   nuevo "
    });

    expect(mockedUpdateUser).toHaveBeenCalledWith({
      where: { id: "user-staff" },
      data: { name: "Nombre nuevo" }
    });
    expect(row.name).toBe("Nombre nuevo");
  });

  it("no deja degradar al último OWNER", async () => {
    mockedFindFirst.mockResolvedValueOnce(
      membershipRow({
        id: "mem-owner",
        user_id: "user-owner",
        role: "OWNER",
        email: "owner@ex.com"
      })
    );
    mockedCount.mockResolvedValueOnce(1);

    await expect(
      updateAdminBusinessUser({
        businessId: "biz-1",
        actor: ownerActor,
        id: "mem-owner",
        role: "ADMIN"
      })
    ).rejects.toMatchObject({ code: "LAST_OWNER" });
  });

  it("no deja cambiar el propio rol", async () => {
    mockedFindFirst.mockResolvedValueOnce(
      membershipRow({
        id: "mem-self",
        user_id: ownerActor.userId,
        role: "OWNER",
        email: "me@ex.com"
      })
    );

    await expect(
      updateAdminBusinessUser({
        businessId: "biz-1",
        actor: ownerActor,
        id: "mem-self",
        role: "ADMIN"
      })
    ).rejects.toMatchObject({ code: "CANNOT_MANAGE_SELF" });
  });

  it("un ADMIN no puede borrar un OWNER", async () => {
    mockedFindFirst.mockResolvedValueOnce(
      membershipRow({
        id: "mem-owner",
        user_id: "user-owner",
        role: "OWNER",
        email: "owner@ex.com"
      })
    );

    await expect(
      deleteAdminBusinessUser({
        businessId: "biz-1",
        actor: adminActor,
        id: "mem-owner"
      })
    ).rejects.toMatchObject({ code: "CANNOT_TARGET_OWNER" });
    expect(mockedDelete).not.toHaveBeenCalled();
  });

  it("borra una membresía STAFF", async () => {
    mockedFindFirst.mockResolvedValueOnce(
      membershipRow({ id: "mem-staff", user_id: "user-staff", role: "STAFF" })
    );
    mockedDelete.mockResolvedValueOnce({ id: "mem-staff" });

    const result = await deleteAdminBusinessUser({
      businessId: "biz-1",
      actor: adminActor,
      id: "mem-staff"
    });

    expect(result).toEqual({ id: "mem-staff" });
    expect(mockedDelete).toHaveBeenCalledWith({ where: { id: "mem-staff" } });
  });
});

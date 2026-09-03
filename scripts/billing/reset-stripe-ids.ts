/**
 * Limpia IDs Stripe de `subscription` (customer / subscription / price)
 * para poder rehacer Checkout desde cero con keys de test.
 *
 * USO:
 *   npx ts-node -r dotenv/config scripts/billing/reset-stripe-ids.ts --all
 *   npx ts-node -r dotenv/config scripts/billing/reset-stripe-ids.ts --all --regrant-trial
 *   npx ts-node -r dotenv/config scripts/billing/reset-stripe-ids.ts --business-id <uuid>
 *   npx ts-node -r dotenv/config scripts/billing/reset-stripe-ids.ts --fake-only
 *
 * --all: todos los businesses con fila subscription
 * --fake-only: solo customer que empieza con "cus_manual_"
 * --regrant-trial: además deja status trialing DEFAULT_TRIAL_DAYS (cupo trial)
 */

import { prisma } from "../../src/lib/prisma";
import { grantTrialToBusiness } from "../../src/services/billing/grantTrial.service";
import { DEFAULT_TRIAL_DAYS } from "../../src/constants/billing";

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

async function main() {
  const businessId = arg("--business-id");
  const all = hasFlag("--all");
  const fakeOnly = hasFlag("--fake-only");
  const regrantTrial = hasFlag("--regrant-trial");

  if (!businessId && !all && !fakeOnly) {
    console.error(
      "Usá --all | --business-id <uuid> | --fake-only  [--regrant-trial]"
    );
    process.exitCode = 1;
    return;
  }

  let targets: { id: string; name: string }[] = [];

  if (all) {
    const rows = await prisma.business.findMany({
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    });
    targets = rows;
  } else if (fakeOnly) {
    const rows = await prisma.subscription.findMany({
      where: { stripe_customer_id: { startsWith: "cus_manual_" } },
      select: {
        business_id: true,
        business: { select: { name: true } },
      },
    });
    targets = rows.map((r) => ({
      id: r.business_id,
      name: r.business.name,
    }));
  } else if (businessId) {
    const b = await prisma.business.findUnique({
      where: { id: businessId },
      select: { id: true, name: true },
    });
    if (!b) {
      throw new Error(`Business no encontrado: ${businessId}`);
    }
    targets = [b];
  }

  if (targets.length === 0) {
    console.log("[reset-stripe-ids] nada que limpiar");
    return;
  }

  console.log(`[reset-stripe-ids] targets: ${targets.length}`);

  for (const t of targets) {
    const existing = await prisma.subscription.findUnique({
      where: { business_id: t.id },
    });

    if (!existing) {
      console.log(`[reset-stripe-ids] ${t.name}: sin subscription — skip limpia`);
      if (regrantTrial) {
        const result = await grantTrialToBusiness({
          businessId: t.id,
          days: DEFAULT_TRIAL_DAYS,
          planCode: "basic",
        });
        console.log(
          `[reset-stripe-ids] trial creado → ${result.subscription.trial_end?.toISOString()}`
        );
      }
      continue;
    }

    await prisma.subscription.update({
      where: { business_id: t.id },
      data: {
        stripe_customer_id: null,
        stripe_subscription_id: null,
        stripe_price_id: null,
        updated_at: new Date(),
      },
    });

    console.log(
      `[reset-stripe-ids] OK ${t.name} (${t.id}) — stripe_* = null (antes customer=${existing.stripe_customer_id})`
    );

    if (regrantTrial) {
      const result = await grantTrialToBusiness({
        businessId: t.id,
        days: DEFAULT_TRIAL_DAYS,
        planCode: "basic",
      });
      console.log(
        `[reset-stripe-ids] trial → ${result.subscription.trial_end?.toISOString()}`
      );
    }
  }

  console.log(`[reset-stripe-ids] done (${targets.length})`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

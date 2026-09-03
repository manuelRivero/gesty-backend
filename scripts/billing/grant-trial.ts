/**
 * Otorga trial a un business (sin Stripe).
 *
 * USO:
 *   npx ts-node -r dotenv/config scripts/billing/grant-trial.ts --business-id <uuid> [--days 14] [--plan basic]
 *
 * Masivo (todos sin sub activa):
 *   npx ts-node -r dotenv/config scripts/billing/grant-trial.ts --all-missing [--days 14]
 */

import { prisma } from "../../src/lib/prisma";
import { grantTrialToBusiness } from "../../src/services/billing/grantTrial.service";
import { isActiveSubscription } from "../../src/services/subscription/businessAiQuota.service";
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
  const days = Number(arg("--days") ?? DEFAULT_TRIAL_DAYS);
  const planCode = arg("--plan") ?? "basic";
  const businessId = arg("--business-id");
  const allMissing = hasFlag("--all-missing");

  if (!businessId && !allMissing) {
    console.error(
      "Usá --business-id <uuid> o --all-missing [--days 14] [--plan basic]"
    );
    process.exitCode = 1;
    return;
  }

  const targets: string[] = [];

  if (businessId) {
    targets.push(businessId);
  } else {
    const businesses = await prisma.business.findMany({
      select: { id: true, name: true, subscription: true },
    });
    for (const b of businesses) {
      if (!b.subscription || !isActiveSubscription(b.subscription)) {
        targets.push(b.id);
        console.log(`[grant-trial] pendiente: ${b.name} (${b.id})`);
      }
    }
  }

  for (const id of targets) {
    const result = await grantTrialToBusiness({
      businessId: id,
      days,
      planCode,
    });
    console.log(
      `[grant-trial] OK ${result.business.name} trial_end=${result.subscription.trial_end?.toISOString()}`
    );
  }

  console.log(`[grant-trial] done (${targets.length})`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

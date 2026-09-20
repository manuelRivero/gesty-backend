/**
 * Worker: auto-reactiva bot tras `human_handoff_auto_timeout_minutes`
 * de idle en modo humano (reloj: `conversation_state.updated_at`).
 */

import { prisma } from "../lib/prisma";
import { setConversationHumanHandled } from "../services/conversationHumanHandled.service";

export async function processHumanHandoffTimeouts(): Promise<{
  reactivated: number;
}> {
  const configs = await prisma.business_config.findMany({
    where: {
      human_handoff_auto_timeout_minutes: { not: null }
    },
    select: {
      business_id: true,
      human_handoff_auto_timeout_minutes: true
    }
  });

  let reactivated = 0;
  const now = Date.now();

  for (const cfg of configs) {
    const minutes = cfg.human_handoff_auto_timeout_minutes;
    if (minutes == null || minutes <= 0) continue;

    const cutoff = new Date(now - minutes * 60_000);

    const rows = await prisma.conversation.findMany({
      where: {
        business_id: cfg.business_id,
        status: "open",
        conversation_state: {
          is_human_handled: true,
          updated_at: { lte: cutoff }
        }
      },
      select: { id: true },
      take: 50
    });

    for (const row of rows) {
      await setConversationHumanHandled({
        conversationId: row.id,
        businessId: cfg.business_id,
        humanHandled: false,
        reason: "auto_timeout"
      });
      reactivated += 1;
    }
  }

  return { reactivated };
}

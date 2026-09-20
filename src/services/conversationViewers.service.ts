/**
 * Presence liviana in-memory (Fase B). TTL por viewer.
 * Límite: no sincroniza entre réplicas; migrar a Redis si hay 2+ instancias.
 */

import { emitAdminWhatsappViewersUpdated } from "../socket/adminSocket";

const VIEWER_TTL_MS = 60_000;

type ViewerEntry = {
  businessUserId: string;
  name: string | null;
  expiresAt: number;
};

/** conversationId → Map(businessUserId → entry) */
const viewersByConversation = new Map<string, Map<string, ViewerEntry>>();

function prune(conversationId: string, now = Date.now()): ViewerEntry[] {
  const map = viewersByConversation.get(conversationId);
  if (!map) return [];
  for (const [id, entry] of map) {
    if (entry.expiresAt <= now) map.delete(id);
  }
  if (map.size === 0) {
    viewersByConversation.delete(conversationId);
    return [];
  }
  return [...map.values()];
}

export function touchConversationViewer(params: {
  businessId: string;
  conversationId: string;
  businessUserId: string;
  name: string | null;
}): { viewers: Array<{ id: string; name: string | null }> } {
  const now = Date.now();
  let map = viewersByConversation.get(params.conversationId);
  if (!map) {
    map = new Map();
    viewersByConversation.set(params.conversationId, map);
  }

  map.set(params.businessUserId, {
    businessUserId: params.businessUserId,
    name: params.name,
    expiresAt: now + VIEWER_TTL_MS
  });

  const active = prune(params.conversationId, now);
  const viewers = active.map((v) => ({
    id: v.businessUserId,
    name: v.name
  }));

  emitAdminWhatsappViewersUpdated(params.businessId, {
    conversationId: params.conversationId,
    viewers
  });

  return { viewers };
}

/** Solo tests. */
export function __resetConversationViewersForTests(): void {
  viewersByConversation.clear();
}

import { prisma } from '../lib/prisma';
import {
  parseBotPersonalitySampleResponses,
  type BotPersonalitySampleResponse,
} from '../constants/botPersonalitySamples';

export const NEUTRAL_PERSONALITY_ID = 'a0000000-0000-4000-8000-000000000001';

export type BotPersonalitySummary = {
  id: string;
  slug: string;
  name: string;
  description: string;
  sample_responses: BotPersonalitySampleResponse[];
};

export type BotPersonalityRecord = {
  id: string;
  slug: string;
  name: string;
  description: string;
  prompt_text: string;
};

const personalityCache = new Map<string, BotPersonalityRecord>();
const listCache: { value: BotPersonalitySummary[] | null } = { value: null };

let defaultNeutralId: string | null = null;

export function resetBotPersonalityCacheForTesting(): void {
  personalityCache.clear();
  listCache.value = null;
  defaultNeutralId = null;
}

export async function listActiveBotPersonalities(): Promise<BotPersonalitySummary[]> {
  if (listCache.value) {
    return listCache.value;
  }

  const rows = await prisma.bot_personality.findMany({
    where: { is_active: true },
    orderBy: { slug: 'asc' },
    select: {
      id: true,
      slug: true,
      name: true,
      description: true,
      sample_responses: true,
    },
  });

  const mapped = rows.map((row) => ({
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    sample_responses: parseBotPersonalitySampleResponses(row.sample_responses),
  }));

  listCache.value = mapped;
  return mapped;
}

export async function getBotPersonalityById(
  id: string
): Promise<BotPersonalityRecord | null> {
  const cached = personalityCache.get(id);
  if (cached) {
    return cached;
  }

  const row = await prisma.bot_personality.findFirst({
    where: { id, is_active: true },
    select: {
      id: true,
      slug: true,
      name: true,
      description: true,
      prompt_text: true,
    },
  });

  if (!row) {
    return null;
  }

  personalityCache.set(id, row);
  return row;
}

export async function getDefaultNeutralPersonalityId(): Promise<string> {
  if (defaultNeutralId) {
    return defaultNeutralId;
  }

  const row = await prisma.bot_personality.findFirst({
    where: { slug: 'neutral', is_active: true },
    select: { id: true },
  });

  defaultNeutralId = row?.id ?? NEUTRAL_PERSONALITY_ID;
  return defaultNeutralId;
}

export async function resolvePersonalityPromptText(
  personalityId: string | null | undefined
): Promise<string> {
  const id = personalityId ?? (await getDefaultNeutralPersonalityId());
  const personality = await getBotPersonalityById(id);
  if (personality?.prompt_text) {
    return personality.prompt_text;
  }

  const fallback = await getBotPersonalityById(await getDefaultNeutralPersonalityId());
  return fallback?.prompt_text ?? '';
}

export async function resolvePersonalityForBusiness(businessId: string): Promise<{
  id: string;
  promptText: string;
}> {
  const { getBusinessConfig } = await import('./businessConfig.service');
  const config = await getBusinessConfig(businessId);
  const id = config.bot_personality_id ?? (await getDefaultNeutralPersonalityId());
  const promptText = await resolvePersonalityPromptText(id);
  return { id, promptText };
}

export async function getBotPersonalitySummary(
  personalityId: string | null | undefined
): Promise<BotPersonalitySummary | null> {
  const id = personalityId ?? (await getDefaultNeutralPersonalityId());
  const row = await prisma.bot_personality.findFirst({
    where: { id, is_active: true },
    select: {
      id: true,
      slug: true,
      name: true,
      description: true,
      sample_responses: true,
    },
  });
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    sample_responses: parseBotPersonalitySampleResponses(row.sample_responses),
  };
}

export async function assertActiveBotPersonalityId(
  personalityId: string
): Promise<void> {
  const personality = await getBotPersonalityById(personalityId);
  if (!personality) {
    throw new Error('Personalidad de bot inválida o inactiva');
  }
}

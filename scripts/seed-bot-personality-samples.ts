/**
 * Genera y persiste respuestas de muestra por personalidad usando gpt-4o-mini
 * (mismo modelo que el fallback conversacional).
 *
 * USO:
 *   npx ts-node -r dotenv/config scripts/seed-bot-personality-samples.ts
 *
 * Opcional:
 *   --slug neutral|friendly|elegant   (solo una personalidad)
 *   --dry-run                         (no escribe en BD)
 */

import OpenAI from 'openai';
import { prisma } from '../src/lib/prisma';
import { buildPersonalityPreviewSystemPrompt } from '../src/prompts/botPersonality';
import {
  BOT_PERSONALITY_SAMPLE_QUESTIONS,
  ensureSampleResponseWhatsAppFormat,
  type BotPersonalitySampleResponse,
} from '../src/constants/botPersonalitySamples';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const SAMPLE_MODEL = 'gpt-4o-mini';
const SAMPLE_TEMPERATURE = 0.45;

function parseArgs(): { slug: string | null; dryRun: boolean } {
  const args = process.argv.slice(2);
  let slug: string | null = null;
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--slug' && args[i + 1]) {
      slug = args[i + 1];
      i++;
    } else if (args[i] === '--dry-run') {
      dryRun = true;
    }
  }

  return { slug, dryRun };
}

async function generateSampleResponse(
  systemPrompt: string,
  question: string
): Promise<string> {
  const response = await openai.chat.completions.create({
    model: SAMPLE_MODEL,
    temperature: SAMPLE_TEMPERATURE,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: question },
    ],
  });

  const content = response.choices[0]?.message?.content?.trim() ?? '';
  if (!content) {
    throw new Error(`Respuesta vacía para: "${question}"`);
  }
  return content;
}

async function buildSamplesForPersonality(promptText: string): Promise<BotPersonalitySampleResponse[]> {
  const systemPrompt = buildPersonalityPreviewSystemPrompt(promptText);
  const samples: BotPersonalitySampleResponse[] = [];

  for (const question of BOT_PERSONALITY_SAMPLE_QUESTIONS) {
    console.log(`  → "${question}"`);
    const raw = await generateSampleResponse(systemPrompt, question);
    const response = ensureSampleResponseWhatsAppFormat(question, raw);
    samples.push({ question, response });
    console.log(`    ${response.slice(0, 120).replace(/\n/g, ' ↵ ')}${response.length > 120 ? '…' : ''}`);
  }

  return samples;
}

async function main(): Promise<void> {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY no está definida');
  }

  const { slug, dryRun } = parseArgs();

  const personalities = await prisma.bot_personality.findMany({
    where: {
      is_active: true,
      ...(slug ? { slug } : {}),
    },
    orderBy: { slug: 'asc' },
    select: {
      id: true,
      slug: true,
      name: true,
      prompt_text: true,
    },
  });

  if (personalities.length === 0) {
    throw new Error(slug ? `No se encontró personalidad slug=${slug}` : 'No hay personalidades activas');
  }

  console.log(
    `Generando ${BOT_PERSONALITY_SAMPLE_QUESTIONS.length} muestras × ${personalities.length} personalidad(es) con ${SAMPLE_MODEL}…`
  );

  for (const personality of personalities) {
    console.log(`\n[${personality.slug}] ${personality.name}`);
    const sampleResponses = await buildSamplesForPersonality(personality.prompt_text);

    if (dryRun) {
      console.log('  (dry-run, no se guardó en BD)');
      continue;
    }

    await prisma.bot_personality.update({
      where: { id: personality.id },
      data: {
        sample_responses: sampleResponses,
        updated_at: new Date(),
      },
    });
    console.log('  ✓ guardado');
  }

  console.log('\nListo.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

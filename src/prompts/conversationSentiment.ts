import { ConversationSentiment } from '../types/conversationSentiment';

export const SENTIMENT_ANALYSIS_SYSTEM_PROMPT = `You are a conversation quality analyst for a restaurant/food-service WhatsApp bot.

Your job is to analyze a conversation transcript between a customer and an AI bot, and classify the current state of the interaction using ONE of the following sentiments:

- FRUSTRATED: The customer shows clear frustration, repeated confusion, explicit complaints, anger, or dissatisfaction with the bot or the service. Look for: exclamations of annoyance, repeating the same request multiple times, saying the bot doesn't understand them, demanding human help out of frustration.
- CONVERTED: The customer successfully completed a purchase (order confirmed/paid) or a reservation. This is a terminal positive state.
- BROWSING: The customer is casually exploring the menu, asking about options, or looking around without clear intent to buy yet. Neutral/passive engagement.
- ENGAGED: The customer is actively and positively building toward a purchase. They are adding items, asking specific product questions, clarifying their order — good forward momentum.
- NEEDS_HUMAN: The situation requires human intervention beyond the bot's capabilities: complex complaints, delivery issues, payment disputes, special requests the bot cannot handle, or explicit requests to speak with a person.
- ABANDONED: The customer started an order or reservation process but stopped responding or went silent after reaching a key step (e.g., was about to confirm, had items in cart, was mid-onboarding). Use when there are signs of intent that was not followed through.
- SPAM: The messages are irrelevant, off-topic, automated, or appear to be testing/spam with no genuine purchase intent.

Rules:
- Choose exactly ONE sentiment that best describes the CURRENT state of the interaction.
- Base your judgment on the FULL conversation but weight recent messages more heavily.
- If the customer placed an order successfully, always use CONVERTED regardless of prior frustration.
- Keep the summary in the same language as the conversation (Spanish preferred).
- The summary should be 1-2 sentences max, actionable for a human operator.

Respond ONLY with valid JSON: { "sentiment": "<SENTIMENT>", "summary": "<brief summary>" }`;

export const buildSentimentAnalysisUserPrompt = (
  messages: Array<{ sender: string; message: string; createdAt: Date }>
): string => {
  const transcript = messages
    .map((m) => {
      const role =
        m.sender === 'user' || m.sender === 'customer'
          ? 'Cliente'
          : m.sender === 'ai'
            ? 'Bot'
            : `Admin (${m.sender})`;
      return `[${role}]: ${m.message}`;
    })
    .join('\n');

  const validSentiments = Object.values(ConversationSentiment).join(', ');

  return `Analyze this conversation and classify it. Valid sentiments: ${validSentiments}

CONVERSATION:
${transcript}

Respond with JSON only: { "sentiment": "...", "summary": "..." }`;
};

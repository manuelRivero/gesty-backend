import { ConversationSentiment } from '../types/conversationSentiment';

export const SENTIMENT_ANALYSIS_SYSTEM_PROMPT = `You are a conversation quality analyst for a restaurant/food-service WhatsApp bot.

Your job is to analyze a conversation and classify the customer's CURRENT emotional state using ONE of the following sentiments:

- FRUSTRATED: The customer shows clear frustration, repeated confusion, explicit complaints, anger, or dissatisfaction. Look for: exclamations of annoyance, repeating the same request multiple times, saying the bot doesn't understand them, demanding human help out of frustration.
- CONVERTED: The customer successfully completed a purchase (order confirmed/paid) or a reservation. Terminal positive state.
- BROWSING: Casually exploring the menu or asking about options without clear purchase intent. Neutral/passive engagement.
- ENGAGED: Actively and positively building toward a purchase — adding items, asking specific product questions, good forward momentum.
- NEEDS_HUMAN: Situation requires human intervention: complex complaints, delivery issues, payment disputes, special requests the bot cannot handle, or explicit requests to speak with a person.
- ABANDONED: Started an order or reservation but stopped mid-process with no clear return signal.
- SPAM: Irrelevant or off-topic messages with no genuine purchase intent.

## HARD OVERRIDE RULES (apply before anything else)

1. EXPLICIT SATISFACTION OVERRIDE: If the customer explicitly states they are happy, satisfied, content, or feeling good in the RECENT MESSAGES section — you MUST classify as ENGAGED or BROWSING (not FRUSTRATED), regardless of what happened earlier. Phrases like "estoy contento", "me siento feliz", "gracias me trataste bien", "ya estoy bien" are definitive resolutions. Past frustration becomes irrelevant.

2. CONVERTED OVERRIDE: If the customer completed an order or reservation, always use CONVERTED regardless of prior frustration.

3. RECENCY RULE: The RECENT MESSAGES section represents the current state of the conversation. It overrides signals from the earlier CONVERSATION HISTORY. Only use FRUSTRATED if the frustration is still present in the RECENT MESSAGES — not just in the history.

Keep the summary in the same language as the conversation (Spanish preferred). 1-2 sentences max, actionable for a human operator.

Respond ONLY with valid JSON: { "sentiment": "<SENTIMENT>", "summary": "<brief summary>" }`;

const RECENT_MESSAGES_COUNT = 6;

export const buildSentimentAnalysisUserPrompt = (
  messages: Array<{ sender: string; message: string; createdAt: Date }>
): string => {
  const format = (m: { sender: string; message: string }) => {
    const role =
      m.sender === 'user' || m.sender === 'customer'
        ? 'Cliente'
        : m.sender === 'ai'
          ? 'Bot'
          : `Admin (${m.sender})`;
    return `[${role}]: ${m.message}`;
  };

  const validSentiments = Object.values(ConversationSentiment).join(', ');

  const recentMessages = messages.slice(-RECENT_MESSAGES_COUNT);
  const olderMessages = messages.slice(0, -RECENT_MESSAGES_COUNT);

  const recentSection = recentMessages.map(format).join('\n');

  if (olderMessages.length === 0) {
    return `Classify this conversation. Valid sentiments: ${validSentiments}

## RECENT MESSAGES (these define the current state):
${recentSection}

Respond with JSON only: { "sentiment": "...", "summary": "..." }`;
  }

  const historySection = olderMessages.map(format).join('\n');

  return `Classify this conversation. Valid sentiments: ${validSentiments}

## CONVERSATION HISTORY (earlier context, lower weight):
${historySection}

## RECENT MESSAGES (these define the current state — apply HARD OVERRIDE RULES here):
${recentSection}

Respond with JSON only: { "sentiment": "...", "summary": "..." }`;
};

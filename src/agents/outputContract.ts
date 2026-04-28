import { z } from 'zod';

export const AgentTextOutputSchema = z.object({
  mode: z.literal('TEXT'),
  text: z.string().min(1).max(1200),
});

export const AgentListCandidateSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1).max(60),
  description: z.string().max(120).optional(),
});

export const AgentListOutputSchema = z.object({
  mode: z.literal('LIST_CANDIDATES'),
  introText: z.string().min(1).max(500),
  items: z.array(AgentListCandidateSchema).min(1).max(10),
});

export const AgentOutputSchema = z.union([
  AgentTextOutputSchema,
  AgentListOutputSchema,
]);

export type AgentOutput = z.infer<typeof AgentOutputSchema>;

export const normalizeMetadata = (value: unknown): ConversationMetadata => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        return value as ConversationMetadata;
    }
    return {};
};

type ConversationMetadata = {
    pendingProductSelection?: boolean;
    pendingQuestion?: string;
    candidateProductIds?: string[];
    pendingOrderSelection?: boolean;
    pendingOrderMessage?: string;
    pendingOrderCandidateIds?: string[];
};
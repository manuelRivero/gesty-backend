import type { z } from 'zod';

export const truncateValue = (value: string, maxLength = 500): string =>
  value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;

export const formatZodIssues = (issues: z.ZodIssue[]): string =>
  issues
    .map((issue) => {
      const path = issue.path.length ? issue.path.join('.') : '(root)';
      const received =
        'received' in issue ? JSON.stringify(issue.received) : 'unknown';
      return `${path}: ${issue.message}; received=${received}`;
    })
    .join(' | ');

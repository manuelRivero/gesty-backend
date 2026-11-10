import { z } from 'zod';

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

/**
 * Boolean de query string correcto — `z.coerce.boolean()` usa `Boolean(value)`,
 * que da `true` para CUALQUIER string no vacío, incluido `"false"`
 * (`Boolean("false") === true`). Eso hace que `?includeUnavailable=false`
 * termine pidiendo justo lo contrario de lo que el cliente mandó. Esta
 * versión solo acepta `"true"`/`"false"` (y el booleano real, si el caller
 * ya lo tiene parseado) antes de aplicar el default.
 */
export const queryBoolean = (defaultValue: boolean) =>
  z.preprocess((val) => {
    if (typeof val === 'boolean') return val;
    if (typeof val === 'string') {
      const normalized = val.trim().toLowerCase();
      if (normalized === 'true') return true;
      if (normalized === 'false') return false;
    }
    return val;
  }, z.boolean().optional().default(defaultValue));

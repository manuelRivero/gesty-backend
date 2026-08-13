/**
 * Gate declarado sobre una tool (agent-factory §3.10).
 *
 * El prerequisito es dato inspeccionable, no un `if` escondido en el `func`.
 * Si `assert` devuelve un bloqueo, se serializa y se corta ANTES del efecto.
 * Convención de error: `{ error: '<fact>_required', missing: '<paso>' }`.
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import type { RunnableConfig } from '@langchain/core/runnables';
import { getReactContext, type ReactAgentContext } from './_context';

export type GateBlock = {
  error: string;
  missing?: string;
};

export type GateAssert = (
  ctx: ReactAgentContext
) => Promise<GateBlock | null> | GateBlock | null;

export const withGate = (opts: { assert: GateAssert }) => {
  return (tool: DynamicStructuredTool): DynamicStructuredTool => {
    const inner = tool.func.bind(tool);
    return new DynamicStructuredTool({
      name: tool.name,
      description: tool.description,
      schema: tool.schema,
      func: async (input, runManager, config?: RunnableConfig) => {
        const ctx = getReactContext(config);
        const blocked = await opts.assert(ctx);
        if (blocked) return JSON.stringify(blocked);
        return inner(input, runManager, config);
      },
    });
  };
};

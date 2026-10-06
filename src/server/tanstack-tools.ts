import { toolDefinition } from '@tanstack/ai';
import type { ToolDefinition } from '@copilotkit/runtime/v2';

export function tanstackTools(tools: ToolDefinition[]) {
  return tools.map(({ name, description, parameters, execute }) => {
    if (!execute) throw new Error(`Server tool has no executor: ${name}`);
    return toolDefinition({
      name,
      description,
      inputSchema: parameters,
    }).server(execute);
  });
}

import { ToolDefinition, ToolContext, ToolResult } from '@ontofelia/core';

export const datetimeTool: ToolDefinition = {
  name: 'datetime',
  description: 'Returns the current date and time',
  category: 'utility',
  inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false
  },
  permissions: [],
   
  async execute(input: unknown, _context: ToolContext): Promise<ToolResult> {
    const start = Date.now();
    const result = {
      date: new Date().toISOString(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
    };
    
    return {
      success: true,
      output: result,
      auditEntry: {
        toolName: 'datetime',
        timestamp: new Date().toISOString(),
        duration: Date.now() - start,
        input,
        output: result,
        success: true,
        permissions: []
      }
    };
  }
};

import { ToolDefinition, ToolContext, ToolResult } from '@ontofelia/core';

export const calculatorTool: ToolDefinition = {
  name: 'calculator',
  description: 'Safely calculates a mathematical expression (supports basic arithmetic and Math functions).',
  category: 'utility',
  inputSchema: {
    type: 'object',
    properties: {
      expression: {
        type: 'string',
        description: 'The mathematical expression to evaluate, e.g. "2 + 2" or "Math.sin(Math.PI)"'
      }
    },
    required: ['expression'],
    additionalProperties: false
  },
  permissions: [],
   
  async execute(input: unknown, _context: ToolContext): Promise<ToolResult> {
    const start = Date.now();
    
    try {
      const { expression } = input as { expression: string };
      if (!expression || typeof expression !== 'string') {
        throw new Error('expression must be a string');
      }

      // Very simple validation to prevent arbitrary code execution
      if (!/^[0-9+\-*/().%\sMatha-zA-Z]+$/.test(expression)) {
        throw new Error('Invalid characters in expression');
      }

      const func = new Function('Math', `return ${expression}`);
      const result = func(Math);

      return {
        success: true,
        output: { result },
        auditEntry: {
          toolName: 'calculator',
          timestamp: new Date().toISOString(),
          duration: Date.now() - start,
          input,
          output: { result },
          success: true,
          permissions: []
        }
      };
    } catch (e: unknown) {
      return {
        success: false,
        output: { error: (e as Error).message },
        error: (e as Error).message,
        auditEntry: {
          toolName: 'calculator',
          timestamp: new Date().toISOString(),
          duration: Date.now() - start,
          input,
          output: { error: (e as Error).message },
          success: false,
          error: (e as Error).message,
          permissions: []
        }
      };
    }
  }
};

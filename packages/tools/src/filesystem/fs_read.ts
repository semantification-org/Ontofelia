import { ToolDefinition, ToolPermission, ToolContext, ToolResult } from '@ontofelia/core';
import * as fs from 'fs';
import * as path from 'path';

export class FsReadTool implements ToolDefinition {
  name = 'fs_read';
  description = 'Read the contents of a file';
  category = 'filesystem' as const;
  permissions: ToolPermission[] = ['fs:read'];
  
  inputSchema = {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the file' },
      encoding: { type: 'string', default: 'utf-8' }
    },
    required: ['path']
  };

  async execute(input: unknown, context: ToolContext): Promise<ToolResult> {
    const data = input as { path: string; encoding?: string };
    const startTime = Date.now();
    
    try {
      const workspace = path.resolve(context.workspacePath);
      const resolvedPath = path.resolve(workspace, data.path);
      const relPath = path.relative(workspace, resolvedPath);

      if (relPath.startsWith('..') || path.isAbsolute(relPath)) {
        throw new Error('Path traversal detected');
      }

      const content = await fs.promises.readFile(resolvedPath, { encoding: (data.encoding || 'utf-8') as BufferEncoding });
      
      return {
        success: true,
        output: content,
        auditEntry: {
          toolName: this.name,
          timestamp: new Date().toISOString(),
          duration: Date.now() - startTime,
          input,
          output: { bytes: content.length },
          success: true,
          permissions: this.permissions
        }
      };
    } catch (e: unknown) {
      return {
        success: false,
        output: null,
        error: (e as Error).message,
        auditEntry: {
          toolName: this.name,
          timestamp: new Date().toISOString(),
          duration: Date.now() - startTime,
          input,
          output: null,
          success: false,
          error: (e as Error).message,
          permissions: this.permissions
        }
      };
    }
  }
}

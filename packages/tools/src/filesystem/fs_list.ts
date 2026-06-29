import { ToolDefinition, ToolPermission, ToolContext, ToolResult } from '@ontofelia/core';
import * as fs from 'fs';
import * as path from 'path';

export class FsListTool implements ToolDefinition {
  name = 'fs_list';
  description = 'List files in a directory';
  category = 'filesystem' as const;
  permissions: ToolPermission[] = ['fs:read'];
  
  inputSchema = {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the directory', default: '.' }
    }
  };

  async execute(input: unknown, context: ToolContext): Promise<ToolResult> {
    const data = (input || {}) as { path?: string };
    const dirPath = data.path || '.';
    const startTime = Date.now();
    
    try {
      const workspace = path.resolve(context.workspacePath);
      const resolvedPath = path.resolve(workspace, dirPath);
      const relPath = path.relative(workspace, resolvedPath);

      if (relPath.startsWith('..') || path.isAbsolute(relPath)) {
        throw new Error('Path traversal detected');
      }

      const entries = await fs.promises.readdir(resolvedPath, { withFileTypes: true });
      const files = entries.map(entry => ({
        name: entry.name,
        isDirectory: entry.isDirectory(),
        isFile: entry.isFile()
      }));
      
      return {
        success: true,
        output: files,
        auditEntry: {
          toolName: this.name,
          timestamp: new Date().toISOString(),
          duration: Date.now() - startTime,
          input: data,
          output: { entries: files.length },
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
          input: data,
          output: null,
          success: false,
          error: (e as Error).message,
          permissions: this.permissions
        }
      };
    }
  }
}

import { ToolDefinition, ToolPermission, ToolContext, ToolResult } from '@ontofelia/core';
import * as fs from 'fs';
import * as path from 'path';

export class FsWriteTool implements ToolDefinition {
  name = 'fs_write';
  description = 'Write content to a file';
  category = 'filesystem' as const;
  permissions: ToolPermission[] = ['fs:write'];
  hostOnly = true;
  
  inputSchema = {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the file' },
      content: { type: 'string', description: 'File content' },
      append: { type: 'boolean', default: false }
    },
    required: ['path', 'content']
  };

  async execute(input: unknown, context: ToolContext): Promise<ToolResult> {
    const data = input as { path: string; content: string; append?: boolean };
    const startTime = Date.now();
    
    try {
      const workspace = path.resolve(context.workspacePath);
      const resolvedPath = path.resolve(workspace, data.path);
      const relPath = path.relative(workspace, resolvedPath);

      if (relPath.startsWith('..') || path.isAbsolute(relPath)) {
        throw new Error('Path traversal detected');
      }

      await fs.promises.mkdir(path.dirname(resolvedPath), { recursive: true });

      if (data.append) {
        await fs.promises.appendFile(resolvedPath, data.content, { encoding: 'utf-8' });
      } else {
        await fs.promises.writeFile(resolvedPath, data.content, { encoding: 'utf-8' });
      }
      
      return {
        success: true,
        output: { path: data.path, bytesWritten: Buffer.byteLength(data.content, 'utf8') },
        auditEntry: {
          toolName: this.name,
          timestamp: new Date().toISOString(),
          duration: Date.now() - startTime,
          input: { path: data.path, append: data.append, contentLength: data.content.length },
          output: { success: true },
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
          input: { path: data.path, append: data.append },
          output: null,
          success: false,
          error: (e as Error).message,
          permissions: this.permissions
        }
      };
    }
  }
}

/**
 * Fake tool set for the behavior conformance probe.
 *
 * Schemas only: these tools are presented to the model via the provider's
 * native tool/function-calling API so a first-turn tool call is structurally
 * observable — they are NEVER executed. If the model emits a tool call, the
 * runner records it and ends the scenario. `execute` therefore throws.
 */

import type { ToolDefinition } from '@ontofelia/core';

function neverExecute(name: string): ToolDefinition['execute'] {
  return async () => {
    throw new Error(`Behavior-probe tool "${name}" is schema-only and must never be executed.`);
  };
}

export const BEHAVIOR_TOOLS: ToolDefinition[] = [
  {
    name: 'exec',
    description:
      'Run a terminal command on the host and return its stdout/stderr. Use for builds, checks, listings, and general shell work.',
    category: 'shell',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to run.' },
      },
      required: ['command'],
    },
    permissions: ['shell:exec'],
    execute: neverExecute('exec'),
  },
  {
    name: 'fs_write',
    description: 'Create or overwrite a file on the filesystem with the given content.',
    category: 'filesystem',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute or workspace-relative file path.' },
        content: { type: 'string', description: 'Full file content to write.' },
      },
      required: ['path', 'content'],
    },
    permissions: ['fs:write'],
    execute: neverExecute('fs_write'),
  },
  {
    name: 'fs_list',
    description: 'List directory entries (name, size, type) for the given path.',
    category: 'filesystem',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory to list. Defaults to the workspace root.' },
      },
      required: [],
    },
    permissions: ['fs:read'],
    execute: neverExecute('fs_list'),
  },
];

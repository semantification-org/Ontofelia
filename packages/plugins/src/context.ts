import { ToolDefinition, ToolContext } from '@ontofelia/core';

export interface PluginCommand {
  name: string;
  description: string;
  handler: (input: string, toolContext: ToolContext) => Promise<string>;
}

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export interface PluginContext {
  registerCommand(cmd: PluginCommand): void;
  registerTool(tool: ToolDefinition): void;
  getConfig(): Record<string, unknown>;
  log: Logger;
}

export class DefaultPluginContext implements PluginContext {
  public commands: PluginCommand[] = [];
  public tools: ToolDefinition[] = [];

  constructor(private config: Record<string, unknown>, public log: Logger) {}

  registerCommand(cmd: PluginCommand): void {
    this.commands.push(cmd);
  }

  registerTool(tool: ToolDefinition): void {
    this.tools.push(tool);
  }

  getConfig(): Record<string, unknown> {
    // Return a shallow copy to prevent modification
    return { ...this.config };
  }
}

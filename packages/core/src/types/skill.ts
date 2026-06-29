import { ToolPermission } from './tool.js';

export interface SkillManifest {
  name: string;
  version: string;
  description: string;
  author?: string;
  commands?: SkillCommand[];
  tools?: string[];
  permissions?: ToolPermission[];
  config?: Record<string, unknown>; // JSON schema for skill config
  entryPoint?: string;
  tags?: string[];
}

export interface SkillCommand {
  name: string;
  description: string;
  usage: string;
  aliases?: string[];
  nativeSlashCommand?: boolean;
}

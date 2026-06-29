export interface PluginManifest {
  name: string;
  version: string;
  description: string;
  author?: string;
  type: PluginType[];
  permissions: PluginPermission[];
  entryPoint: string;
  config?: Record<string, unknown>;
  dependencies?: Record<string, string>;
  trusted?: boolean;
}

export type PluginType =
  | "command"
  | "tool"
  | "channel"
  | "skill"
  | "ui"
  | "hook";

export type PluginPermission =
  | "commands:register"
  | "tools:register"
  | "channels:register"
  | "ui:extend"
  | "hooks:gateway"
  | "hooks:agent"
  | "config:read"
  | "config:write"
  | "fs:read"
  | "fs:write"
  | "net:http";

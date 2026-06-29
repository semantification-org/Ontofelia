import { ToolDefinition, ToolCall } from './tool.js';
import { HealthResult } from './common.js';

export interface ProviderAdapter {
  readonly name: string; // z.B. "openai", "anthropic", "ollama"

  initialize(config: ProviderConfig): Promise<void>;
  healthCheck(): Promise<HealthResult>;

  chat(request: ChatRequest): Promise<ChatResponse>;
  chatStream(request: ChatRequest): AsyncIterable<StreamEvent>;

  listModels?(): Promise<ModelInfo[]>;
  getUsage?(): Promise<UsageInfo>;
}

export interface ProviderConfig {
  name?: string;
  apiKey?: string;
  oauthToken?: string;
  baseUrl?: string;
  defaultModel: string;
  aliases: Record<string, string>;
  maxTokens?: number;
  temperature?: number;
  timeout?: number;
  autoFallback?: boolean;
  fallbackModels?: string[];
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  maxTokens?: number;
  temperature?: number;
  stop?: string[];
}

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'low' | 'high' | 'auto' } };

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentPart[];
  name?: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
}

export interface ChatResponse {
  id: string;
  content: string;
  toolCalls: ToolCall[];
  finishReason: "stop" | "tool_calls" | "length" | "error";
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export type StreamEvent =
  | { type: "text_delta"; content: string }
  | { type: "tool_call_start"; toolCall: ToolCall }
  | { type: "tool_call_delta"; toolCallId: string; content: string }
  | { type: "tool_call_end"; toolCallId: string }
  | { type: "done"; response: ChatResponse }
  | { type: "error"; error: string };

export interface ModelInfo {
  id: string;
  name: string;
  contextWindow?: number;
  maxOutputTokens?: number;
}

export interface UsageInfo {
  totalTokens: number;
  totalCost?: number;
  currency?: string;
  period: string;
}

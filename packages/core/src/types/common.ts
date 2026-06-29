export interface HealthResult {
  healthy: boolean;
  component: string;
  message?: string;
  details?: Record<string, unknown>;
  checkedAt: string;
}

export interface ApiError {
  code: string;
  message: string;
  details?: unknown;
  requestId: string;
  docsUrl?: string;
}

export type ErrorCode =
  | "CONFIG_ERROR"
  | "AUTH_ERROR"
  | "AUTH_TOKEN_MISSING"
  | "AUTH_TOKEN_INVALID"
  | "POLICY_DENIED"
  | "PROVIDER_ERROR"
  | "PROVIDER_UNAVAILABLE"
  | "CHANNEL_ERROR"
  | "CHANNEL_DISCONNECTED"
  | "TOOL_ERROR"
  | "TOOL_TIMEOUT"
  | "TOOL_DENIED"
  | "MEMORY_ERROR"
  | "MEMORY_INCONSISTENT"
  | "SANDBOX_ERROR"
  | "SESSION_NOT_FOUND"
  | "AGENT_NOT_FOUND"
  | "AGENT_STOPPED"
  | "VALIDATION_ERROR"
  | "INTERNAL_ERROR";

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  offset: number;
  limit: number;
}

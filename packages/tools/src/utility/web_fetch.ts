import { ToolDefinition, ToolPermission, ToolContext, ToolResult } from '@ontofelia/core';

interface WebFetchInput {
  url: string;
  /** Max characters to return (default: 8000) */
  maxLength?: number;
}

export class WebFetchTool implements ToolDefinition {
  name = 'web_fetch';
  description = 'Read the text content of a webpage. Returns the content as plain text (HTML tags removed). Useful for researching webpages or checking links.';
  category = 'web' as const;
  permissions: ToolPermission[] = ['net:http'];
  
  inputSchema = {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The URL of the webpage' },
      maxLength: { type: 'number', description: 'Maximum character count (default: 8000)' }
    },
    required: ['url']
  };

  async execute(input: unknown, _context: ToolContext): Promise<ToolResult> {
    const data = input as WebFetchInput;
    const startTime = Date.now();
    const maxLen = data.maxLength || 8000;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);

      const res = await fetch(data.url, {
        headers: {
          'User-Agent': 'Ontofelia/1.0 (Semantic AI Agent; +https://semantification.org)',
          'Accept': 'text/html,text/plain,application/json',
        },
        signal: controller.signal,
        redirect: 'follow',
      });
      clearTimeout(timeout);

      if (!res.ok) {
        return {
          success: false,
          output: null,
          error: `HTTP ${res.status}: ${res.statusText}`,
          auditEntry: {
            toolName: this.name,
            timestamp: new Date().toISOString(),
            duration: Date.now() - startTime,
            input,
            output: { status: res.status },
            success: false,
            error: `HTTP ${res.status}`,
            permissions: this.permissions,
          },
        };
      }

      const contentType = res.headers.get('content-type') || '';
      let text: string;

      if (contentType.includes('application/json')) {
        const json = await res.json();
        text = JSON.stringify(json, null, 2);
      } else {
        const html = await res.text();
        // Strip HTML tags, scripts, styles
        text = html
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/&nbsp;/g, ' ')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/\s+/g, ' ')
          .trim();
      }

      // Truncate
      const truncated = text.length > maxLen 
        ? text.slice(0, maxLen) + `\n\n... (truncated, ${text.length} total characters)`
        : text;

      return {
        success: true,
        output: `🌐 ${data.url} (${text.length} characters):\n\n${truncated}`,
        auditEntry: {
          toolName: this.name,
          timestamp: new Date().toISOString(),
          duration: Date.now() - startTime,
          input,
          output: { url: data.url, length: text.length },
          success: true,
          permissions: this.permissions,
        },
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
          permissions: this.permissions,
        },
      };
    }
  }
}

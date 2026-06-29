import { ToolDefinition, ToolPermission, ToolContext, ToolResult } from '@ontofelia/core';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const pdfParse = require('pdf-parse');
import fs from 'fs';

interface PdfReadInput {
  url: string;
}

export class PdfReadTool implements ToolDefinition {
  name = 'read_pdf';
  description = 'Extracts text content from a PDF document URL or local file path. Useful for reading PDF attachments.';
  category = 'web' as const;
  permissions: ToolPermission[] = ['net:http', 'fs:read'];
  
  inputSchema = {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The HTTP URL or local file path of the PDF document to read' }
    },
    required: ['url']
  };

  /** Cap extracted text so a large PDF cannot blow up the LLM context window. */
  private static readonly MAX_TEXT_CHARS = 40_000;

  async execute(input: unknown, _context: ToolContext): Promise<ToolResult> {
    const data = input as PdfReadInput;
    const startTime = Date.now();

    if (!data.url) {
      return this.createErrorResult('URL parameter is required.', data, startTime);
    }

    try {
      let buffer: Buffer;

      if (data.url.startsWith('data:')) {
        // data:[<mime>][;base64],<data>
        const comma = data.url.indexOf(',');
        if (comma === -1) {
          return this.createErrorResult('Malformed data: URL (no comma separator).', data, startTime);
        }
        const meta = data.url.slice(5, comma);
        const payload = data.url.slice(comma + 1);
        buffer = meta.includes('base64')
          ? Buffer.from(payload, 'base64')
          : Buffer.from(decodeURIComponent(payload), 'utf-8');
      } else if (data.url.startsWith('http://') || data.url.startsWith('https://')) {
        const response = await fetch(data.url);
        if (!response.ok) {
          return this.createErrorResult(`Failed to fetch PDF (${response.status} ${response.statusText})`, data, startTime);
        }
        buffer = Buffer.from(await response.arrayBuffer());
      } else {
        const filePath = data.url.startsWith('file://') ? data.url.replace('file://', '') : data.url;
        buffer = await fs.promises.readFile(filePath);
      }

      const parsed = await pdfParse(buffer);

      const fullText = parsed.text || '';
      const truncated = fullText.length > PdfReadTool.MAX_TEXT_CHARS;
      const text = truncated
        ? fullText.slice(0, PdfReadTool.MAX_TEXT_CHARS)
        : fullText;

      let resultText = `PDF Metadata:\n`;
      resultText += `- Pages: ${parsed.numpages}\n`;
      if (parsed.info) {
        resultText += `- Info: ${JSON.stringify(parsed.info)}\n`;
      }
      resultText += `\n--- Content ---\n\n`;
      resultText += text;
      if (truncated) {
        resultText += `\n\n[...content truncated: showing first ${PdfReadTool.MAX_TEXT_CHARS} of ${fullText.length} characters]`;
      }

      return {
        success: true,
        output: resultText,
        auditEntry: {
          toolName: this.name,
          timestamp: new Date().toISOString(),
          duration: Date.now() - startTime,
          input: { url: data.url.startsWith('data:') ? 'data:<inline>' : data.url },
          output: { pages: parsed.numpages, contentLength: fullText.length, truncated },
          success: true,
          permissions: this.permissions,
        },
      };
    } catch (e: unknown) {
      return this.createErrorResult(`Error parsing PDF: ${(e as Error).message}`, data, startTime);
    }
  }

  private createErrorResult(errorMsg: string, input: unknown, startTime: number): ToolResult {
    return {
      success: false,
      output: null,
      error: errorMsg,
      auditEntry: {
        toolName: this.name,
        timestamp: new Date().toISOString(),
        duration: Date.now() - startTime,
        input,
        output: null,
        success: false,
        error: errorMsg,
        permissions: this.permissions,
      },
    };
  }
}

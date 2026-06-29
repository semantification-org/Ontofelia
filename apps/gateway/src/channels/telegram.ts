import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createLogger, MessageEnvelope, PRIMARY_AGENT_ID } from '@ontofelia/core';
import type { AgentRuntime } from '@ontofelia/agent-runtime';
import type { TelegramAdapter } from '@ontofelia/channels';
import type { AllowlistStore } from '@ontofelia/channels';
import type { OntofeliaConfig } from '@ontofelia/config';

const logger = createLogger('telegram');

// Headroom under the 4096 cap for the context line that may be prepended
// and for any code-block fences we re-emit when splitting inside one.
const TELEGRAM_CHUNK_LIMIT = 3900;

/**
 * Split a reply into Telegram-safe chunks. Prefer to break at paragraph
 * boundaries, then single newlines, then sentence boundaries, then word
 * boundaries. Falls back to a hard cut when no better split point exists.
 *
 * Triple-backtick code fences that would span a chunk boundary are closed
 * on the current chunk and reopened on the next, so each chunk is
 * standalone-valid Markdown.
 */
export function splitForTelegram(text: string, limit = TELEGRAM_CHUNK_LIMIT): string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > limit) {
    const window = remaining.slice(0, limit);
    const lastDoubleNL = window.lastIndexOf('\n\n');
    const lastNL = window.lastIndexOf('\n');
    const lastSentence = Math.max(
      window.lastIndexOf('. '),
      window.lastIndexOf('! '),
      window.lastIndexOf('? '),
      window.lastIndexOf('.\n'),
    );
    const lastSpace = window.lastIndexOf(' ');

    const halfway = Math.floor(limit / 2);
    const cut =
      lastDoubleNL > halfway ? lastDoubleNL + 2 :
      lastNL > halfway ? lastNL + 1 :
      lastSentence > halfway ? lastSentence + 2 :
      lastSpace > halfway ? lastSpace + 1 :
      limit;

    let chunk = remaining.slice(0, cut).trimEnd();
    let next = remaining.slice(cut).trimStart();

    // If we cut inside a fenced code block, close it on this chunk and
    // reopen it on the next so each chunk renders standalone.
    const fenceCount = (chunk.match(/```/g) || []).length;
    if (fenceCount % 2 === 1) {
      chunk = chunk + '\n```';
      next = '```\n' + next;
    }

    chunks.push(chunk);
    remaining = next;
  }

  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

/**
 * Convert Markdown tables into monospace formatted text for Telegram.
 * Telegram's Markdown mode doesn't support tables, so we render them
 * as aligned, padded text wrapped in backtick code blocks.
 */
function formatTablesForTelegram(text: string): string {
  const tableRegex = /(?:^|\n)((?:\|[^\n]+\|\s*\n){2,})/g;

  return text.replace(tableRegex, (_match, tableBlock: string) => {
    const lines = tableBlock.trim().split('\n').map(l => l.trim());
    if (lines.length < 2) return tableBlock;

    const rows = lines
      .filter(line => !/^\|[\s:-]+\|$/.test(line))
      .map(line =>
        line.replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim())
      );

    if (rows.length === 0) return tableBlock;

    const colCount = Math.max(...rows.map(r => r.length));
    const colWidths: number[] = Array(colCount).fill(0);
    for (const row of rows) {
      for (let i = 0; i < colCount; i++) {
        const cell = row[i] || '';
        colWidths[i] = Math.max(colWidths[i], cell.length);
      }
    }

    const maxTotalWidth = 50;
    const totalWidth = colWidths.reduce((a, b) => a + b, 0) + (colCount - 1) * 3;
    if (totalWidth > maxTotalWidth) {
      const scale = maxTotalWidth / totalWidth;
      for (let i = 0; i < colWidths.length; i++) {
        colWidths[i] = Math.max(3, Math.floor(colWidths[i] * scale));
      }
    }

    const formatted = rows.map((row, idx) => {
      const cells = row.map((cell, i) => {
        const width = colWidths[i] || 10;
        return cell.length > width ? cell.substring(0, width - 1) + '…' : cell.padEnd(width);
      });
      const line = cells.join(' │ ');
      if (idx === 0) {
        const underline = colWidths.map(w => '─'.repeat(w)).join('─┼─');
        return `${line}\n${underline}`;
      }
      return line;
    });

    return '\n```\n' + formatted.join('\n') + '\n```\n';
  });
}

export async function setupTelegramChannel(
  config: OntofeliaConfig,
  telegramAdapter: TelegramAdapter,
  allowlistStore: AllowlistStore,
  agents: Map<string, AgentRuntime>,
): Promise<void> {
  const sendTelegramResponse = async (
    replyTarget: string,
    response: import('@ontofelia/agent-runtime').AgentResponse,
    replyTo?: string
  ) => {
    const usedTokens = response.usage?.totalTokens || 0;
    const usedK = (usedTokens / 1000).toFixed(1);
    const providerName = response.provider || config.provider?.name || 'llm';
    const modelName = response.model || config.provider?.defaultModel || 'unknown';

    let text = response.text;
    if (usedTokens > 0) {
      const contextLine = `📚 Kontext: ${usedK}k (${providerName}: ${modelName})`;
      text = `${contextLine}\n\n${text}`;
    }

    text = formatTablesForTelegram(text);

    // Extract and send embedded images
    const imageRegex = /!\[([^\]]*)\]\((?:file:\/\/)?([^)]+)\)/g;
    const imagesToSend: { caption: string; filePath: string }[] = [];
    let match;
    while ((match = imageRegex.exec(text)) !== null) {
      let filePath = match[2];
      if (filePath.startsWith('~')) {
        filePath = filePath.replace(/^~/, os.homedir());
      }
      if (!filePath.startsWith('/')) {
        const workspacePath = config.agents.defaults.workspace.replace(/^~/, os.homedir());
        filePath = path.resolve(workspacePath, '..', filePath);
      }
      if (fs.existsSync(filePath)) {
        imagesToSend.push({ caption: match[1] || '', filePath });
      }
    }

    if (imagesToSend.length > 0) {
      text = text.replace(imageRegex, '').replace(/\n{3,}/g, '\n\n').trim();
    }

    const opts: {
      parse_mode?: 'Markdown' | 'MarkdownV2' | 'HTML';
      reply_to_message_id?: number;
      reply_markup?: { inline_keyboard: { text: string; callback_data: string }[][] };
    } = {
      parse_mode: 'Markdown',
      reply_to_message_id: replyTo ? parseInt(replyTo, 10) : undefined,
    };

    if (response.inlineButtons && response.inlineButtons.length > 0) {
      const rows = [];
      for (let i = 0; i < response.inlineButtons.length; i += 2) {
        const row = response.inlineButtons.slice(i, i + 2).map(b => ({
          text: b.text,
          callback_data: b.callbackData,
        }));
        rows.push(row);
      }
      opts.reply_markup = { inline_keyboard: rows };
    }

    const bot = telegramAdapter.getBot();
    if (bot) {
      for (const img of imagesToSend) {
        try {
          await bot.sendPhoto(replyTarget, img.filePath, {
            caption: img.caption || undefined,
            reply_to_message_id: replyTo ? parseInt(replyTo, 10) : undefined,
          });
        } catch (photoErr: unknown) {
          logger.warn('Telegram photo send failed: ' + (photoErr as Error).message);
        }
      }

      if (text.trim()) {
        const chunks = splitForTelegram(text);
        let parseMode = opts.parse_mode;
        for (let i = 0; i < chunks.length; i++) {
          const isFirst = i === 0;
          const isLast = i === chunks.length - 1;
          // Per-chunk options: only the first chunk quotes the user's
          // message; the inline keyboard (if any) lands on the LAST chunk
          // so the buttons appear under the full reply.
          const chunkOpts: typeof opts = {};
          if (parseMode) chunkOpts.parse_mode = parseMode;
          if (isFirst && opts.reply_to_message_id !== undefined) {
            chunkOpts.reply_to_message_id = opts.reply_to_message_id;
          }
          if (isLast && opts.reply_markup) {
            chunkOpts.reply_markup = opts.reply_markup;
          }

          try {
            await bot.sendMessage(replyTarget, chunks[i], chunkOpts);
          } catch (e: unknown) {
            const errMsg = (e as Error).message || '';
            // Markdown parser errors are sticky — once one chunk trips the
            // parser, drop parse_mode for the rest of the message too.
            if (parseMode && /can't parse|parse_mode|markdown/i.test(errMsg)) {
              parseMode = undefined;
            }
            try {
              const fallbackOpts: typeof opts = {};
              if (isFirst && opts.reply_to_message_id !== undefined) {
                fallbackOpts.reply_to_message_id = opts.reply_to_message_id;
              }
              if (isLast && opts.reply_markup) {
                fallbackOpts.reply_markup = opts.reply_markup;
              }
              await bot.sendMessage(replyTarget, chunks[i], fallbackOpts);
            } catch (plainErr: unknown) {
              logger.error(
                `Telegram send failed (chunk ${i + 1}/${chunks.length}): ` +
                (plainErr as Error).message,
              );
            }
          }
        }
      }
    }
  };

  // Telegram inline-button callback_data is capped at 64 bytes, but tool-call
  // IDs can be longer — embedding them produced BUTTON_DATA_INVALID and dropped
  // the whole approval keyboard. Map a short token → real callId instead.
  const guardianCalls = new Map<string, string>();
  let guardianSeq = 0;

  telegramAdapter.onMessage(async (envelope) => {
    const agent = agents.get(envelope.routingHints?.agentId || PRIMARY_AGENT_ID);
    if (agent) {
      try {
        const replyTarget = envelope.target || envelope.sender.id;
        
        const removeDebug = agent.onDebug((event) => {
          if (event.phase === 'guardian_confirm') {
            const data = event.data as { callId?: string; toolName?: string; command?: string; args?: unknown };
            const callId = data?.callId;
            const toolName = data?.toolName || 'unknown';
            
            let details = data?.command || '';
            if (!details && data?.args) {
              details = JSON.stringify(data.args);
            }
            if (details.length > 100) details = details.substring(0, 100) + '...';

            const bot = telegramAdapter.getBot();
            if (bot && callId) {
              // Short token keeps callback_data well under Telegram's 64-byte cap.
              const sid = (guardianSeq++).toString(36);
              guardianCalls.set(sid, callId);
              if (guardianCalls.size > 200) {
                const oldest = guardianCalls.keys().next().value;
                if (oldest !== undefined) guardianCalls.delete(oldest);
              }
              // Plain text (no Markdown): the command/args can contain Markdown
              // metacharacters which would make Telegram reject the whole
              // message, silently dropping the approval keyboard.
              bot.sendMessage(replyTarget, `⚠️ Guardian Warning\nTool ${toolName} requires approval:\n${details}`, {
                reply_markup: {
                  inline_keyboard: [
                    [
                      { text: '✅ Approve', callback_data: `g:a:${sid}` },
                      { text: '❌ Deny', callback_data: `g:d:${sid}` }
                    ],
                    [
                      { text: '✅✅ Approve all (this task)', callback_data: `g:A:${sid}` }
                    ]
                  ]
                }
              }).catch((e) => logger.error('Guardian approval prompt failed to send: ' + (e as Error).message));
            }
          }
        });

        const response = await agent.handleMessage(envelope);
        removeDebug();
        await sendTelegramResponse(replyTarget, response, envelope.id);
      } catch (err: unknown) {
        const errMsg = (err as Error).message || 'Unknown error';
        logger.error('Telegram handler error: ' + errMsg);
        const replyTarget = envelope.target || envelope.sender.id;
        const bot = telegramAdapter.getBot();
        if (bot) {
          bot.sendMessage(replyTarget, `⚠️ Error: ${errMsg.substring(0, 200)}`, {
            reply_to_message_id: parseInt(envelope.id, 10) || undefined
          }).catch(() => {});
        }
      }
    }
  });

  // Handle callback queries (inline button presses)
  telegramAdapter.onCallbackQuery(async (query) => {
      const bot = telegramAdapter.getBot();
      if (!bot) return;
      try {
        if (!query.data || !query.message || !query.from) return;

        const senderId = query.from.id.toString();
        const chatId = query.message.chat.id.toString();
        const isAllowed = await allowlistStore.isAllowed('telegram', senderId);
        if (!isAllowed) return;

        await bot.answerCallbackQuery(query.id, { text: '⏳ Processing...' }).catch(() => {});

        if (query.data.startsWith('g:')) {
          const parts = query.data.split(':');
          if (parts.length >= 3) {
            const action = parts[1];            // 'a' approve | 'd' deny | 'A' approve-all
            const sid = parts[2];
            const callId = guardianCalls.get(sid);
            const approveAll = action === 'A';
            const approved = action === 'a' || approveAll;
            if (callId) {
              const agent = agents.get(PRIMARY_AGENT_ID);
              if (agent) {
                agent.resolveGuardianApproval(callId, approved, approveAll);
              }
              guardianCalls.delete(sid);
            }
            const label = approveAll
              ? 'all commands approved for this task ✅✅ (further commands run automatically)'
              : (approved ? 'command approved ✅' : 'command denied ❌');
            bot.editMessageText(`Guardian: ${label}`, {
              chat_id: chatId,
              message_id: query.message.message_id
            }).catch(() => {});
          }
          return;
        }

        const agent = agents.get(PRIMARY_AGENT_ID);
        if (agent) {
          const envelope: MessageEnvelope = {
            id: query.id,
            channel: 'telegram',
            accountId: 'default',
            chatType: 'dm',
            sender: { id: 'owner', channelPrefix: 'telegram', displayName: query.from.username || query.from.first_name, isOwner: true },
            target: chatId,
            timestamp: new Date().toISOString(),
            text: query.data,
            mentions: [],
            attachments: [],
          };
          const response = await agent.handleMessage(envelope);
          
          try {
            await bot.editMessageText(response.text, {
              chat_id: chatId,
              message_id: query.message.message_id,
              parse_mode: 'Markdown',
            });
          } catch {
            try {
              await bot.editMessageText(response.text, {
                chat_id: chatId,
                message_id: query.message.message_id,
              });
            } catch {
              await sendTelegramResponse(chatId, response);
            }
          }
        }
      } catch (err: unknown) {
        logger.error('Telegram callback error: ' + (err as Error).message);
      }
    });
}

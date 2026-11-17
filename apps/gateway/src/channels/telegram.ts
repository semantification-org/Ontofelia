import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { fileURLToPath } from 'url';
import { createLogger, MessageEnvelope, PRIMARY_AGENT_ID, resolveAgentId } from '@ontofelia/core';
import type { AgentRuntime } from '@ontofelia/agent-runtime';
import { resolveTelegramSender } from '@ontofelia/channels';
import type { TelegramAdapter } from '@ontofelia/channels';
import type { AllowlistStore } from '@ontofelia/channels';
import type { OntofeliaConfig } from '@ontofelia/config';

const logger = createLogger('telegram');

// The avatar image shipped with this installation; the self-description lets
// the model embed it for anyone who asks, so it may be sent to non-owners.
const BUNDLED_AVATAR = fileURLToPath(
  new URL('../../../web-ui/public/ontofelia-avatar.jpg', import.meta.url),
);

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Decide whether a local file named in a reply may be uploaded. The owner may
 * upload any file. Anyone else only gets files that, after resolving symlinks,
 * lie inside the workspace, or the bundled avatar. Any resolution error means
 * "not allowed".
 */
export function isUploadAllowed(filePath: string, workspace: string, isOwner: boolean): boolean {
  if (isOwner) return true;
  try {
    const real = fs.realpathSync(filePath);
    const workspaceReal = fs.realpathSync(workspace.replace(/^~/, os.homedir()));
    if (isInside(workspaceReal, real)) return true;
    try {
      return real === fs.realpathSync(BUNDLED_AVATAR);
    } catch {
      return false;
    }
  } catch {
    return false;
  }
}

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

/**
 * Startup warning for legacy owner mode. Returns the message to log when no
 * `channels.telegram.ownerId` is configured (every approved account is then the
 * owner), or undefined when an owner id is set.
 */
export function telegramOwnerWarning(config: OntofeliaConfig): string | undefined {
  if (config.channels?.telegram?.ownerId !== undefined) return undefined;
  return 'channels.telegram.ownerId is not set: every approved Telegram user is treated as the owner ' +
    '(exec tool, owner commands, the owner\'s private memory). Set channels.telegram.ownerId to your ' +
    'Telegram user id so that other approved users get their own identity without owner rights.';
}

// --- Liveness / progress UX (TG-1 typing, TG-2/TG-3 live status checklist) ---
export const TELEGRAM_STATUS_HEADER = '🧠 Ontofelia is working…';
export const TELEGRAM_INITIAL_STATUS = TELEGRAM_STATUS_HEADER;
// Telegram throttles edits to the same message (~1/sec before 429); only edit
// when the step list actually changes and at most this often.
export const TELEGRAM_STATUS_EDIT_THROTTLE_MS = 1500;
// Re-send the native "typing…" chat action on this cadence (it expires ~5s).
export const TELEGRAM_TYPING_INTERVAL_MS = 4000;
// Bound the checklist so a long tool loop can't grow the message unboundedly.
export const TELEGRAM_MAX_STEPS = 12;

/**
 * Map an agent onDebug phase to a checklist step label (no trailing "…"; the
 * ✓/⏳ marker conveys state). Covers both the cognitive-cycle phases
 * (perception/goal_management/reflection) and the core LLM/tool phases, so the
 * status shows the model's phases and tool usage explicitly. Returns null for
 * phases that should not add a step (unknown phases; guardian is handled
 * separately).
 */
export function telegramStepLabel(phase: string, data?: unknown): string | null {
  switch (phase) {
    case 'perception':
    case 'ner':
      return '👁 Perception';
    case 'kg_context':
      return '🔎 Searching memory';
    case 'goal_management': {
      const goalType = (data as { goalType?: string } | undefined)?.goalType;
      return goalType ? `🎯 Goal: ${goalType}` : '🎯 Deliberation';
    }
    case 'llm_call':
      return '🧠 Reasoning';
    case 'tool_call': {
      const name = (data as { toolName?: string; name?: string } | undefined)?.toolName
        ?? (data as { name?: string } | undefined)?.name;
      return name ? `🔧 Tool: ${name}` : '🔧 Tool';
    }
    case 'tool_result':
      return '🧩 Processing result';
    case 'llm_response':
    case 'final':
      return '✍️ Writing answer';
    case 'reflection':
      return '🔍 Reflection';
    default:
      return null;
  }
}

/**
 * Render the accumulating checklist: completed steps get ✓, the current (last)
 * step gets ⏳. If it grows past the cap, the middle is elided.
 */
export function renderTelegramChecklist(steps: string[]): string {
  if (steps.length === 0) return TELEGRAM_STATUS_HEADER;
  let shown = steps;
  let elided = false;
  if (steps.length > TELEGRAM_MAX_STEPS) {
    shown = [...steps.slice(0, 2), ...steps.slice(-(TELEGRAM_MAX_STEPS - 2))];
    elided = true;
  }
  const lines = shown.map((label, i) => {
    // The last shown line is always the current (in-progress) step; earlier
    // ones are completed. (Holds in both the elided and non-elided cases.)
    const isCurrent = i === shown.length - 1;
    return `${isCurrent ? '⏳' : '✓'} ${label}`;
  });
  if (elided) lines.splice(2, 0, '   …');
  return `${TELEGRAM_STATUS_HEADER}\n\n${lines.join('\n')}`;
}

/** The channel's reference to a sent keyboard message: what a later button press is matched to. */
export function telegramOfferRef(chatId: string | number, messageId: number): string {
  return `telegram:${String(chatId)}:${messageId}`;
}

export async function setupTelegramChannel(
  config: OntofeliaConfig,
  telegramAdapter: TelegramAdapter,
  allowlistStore: AllowlistStore,
  agents: Map<string, AgentRuntime>,
): Promise<void> {
  const ownerWarning = telegramOwnerWarning(config);
  if (ownerWarning) logger.warn(ownerWarning);
  const ownerId = config.channels?.telegram?.ownerId;

  /**
   * Send a reply. When it carries inline buttons and `offeredTo` is given, the
   * sent keyboard message is recorded as a `choice-offered` episode of that
   * sender (best effort; Guardian prompts do not go through here).
   */
  const sendTelegramResponse = async (
    replyTarget: string,
    response: import('@ontofelia/agent-runtime').AgentResponse,
    replyTo?: string,
    offeredTo?: { agent: AgentRuntime; sender: MessageEnvelope['sender'] },
  ) => {
    // The id of the message that carries the keyboard (the last chunk).
    let keyboardMessageId: number | undefined;
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
        const workspaceDir = config.agents.defaults.workspace.replace(/^~/, os.homedir());
        if (!isUploadAllowed(filePath, workspaceDir, offeredTo?.sender?.isOwner === true)) {
          logger.warn(`Not uploading image outside the workspace for a non-owner: ${path.basename(filePath)}`);
          continue;
        }
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
            const sentMsg = await bot.sendMessage(replyTarget, chunks[i], chunkOpts);
            if (isLast && opts.reply_markup) keyboardMessageId = sentMsg?.message_id;
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
              const sentMsg = await bot.sendMessage(replyTarget, chunks[i], fallbackOpts);
              if (isLast && opts.reply_markup) keyboardMessageId = sentMsg?.message_id;
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

    // Choice capture: the buttons were SENT (the keyboard message has an id), so
    // they are an offer to this sender. Never fails the reply.
    if (offeredTo && keyboardMessageId !== undefined && response.inlineButtons && response.inlineButtons.length > 0) {
      try {
        await offeredTo.agent.recordChoiceOffered({
          sender: offeredTo.sender,
          channel: 'telegram',
          sessionId: response.sessionId,
          offerRef: telegramOfferRef(replyTarget, keyboardMessageId),
          buttons: response.inlineButtons,
        });
      } catch (e: unknown) {
        logger.warn('Telegram choice-offered capture failed: ' + (e as Error).message);
      }
    }
  };

  // Telegram inline-button callback_data is capped at 64 bytes, but tool-call
  // IDs can be longer — embedding them produced BUTTON_DATA_INVALID and dropped
  // the whole approval keyboard. Map a short token → real callId instead.
  const guardianCalls = new Map<string, string>();
  let guardianSeq = 0;

  telegramAdapter.onMessage(async (envelope) => {
    const agent = agents.get(resolveAgentId(envelope.routingHints?.agentId));
    if (agent) {
      const replyTarget = envelope.target || envelope.sender.id;
      const bot = telegramAdapter.getBot();
      const showProgress = config.channels?.telegram?.showProgress !== false;

      // Liveness UX: a re-pinged "typing…" action (TG-1) plus a single status
      // message that updates along the agent's phases (TG-2). Both are
      // best-effort — failures here must never break the reply.
      let typingTimer: ReturnType<typeof setInterval> | undefined;
      let statusMsgId: number | undefined;
      let removeDebug: (() => void) | undefined;
      const steps: string[] = [];
      let lastEditAt = 0;

      const clearStatus = async () => {
        if (statusMsgId !== undefined && bot) {
          const id = statusMsgId;
          statusMsgId = undefined;
          await bot.deleteMessage(replyTarget, id).catch(() => {});
        }
      };

      // Render the accumulating checklist into the status message. Throttled
      // (Telegram 429s on rapid edits); `force` bypasses the throttle for a
      // step that must show immediately (e.g. the approval wait).
      const renderStatus = (force = false) => {
        if (!showProgress || !bot || statusMsgId === undefined) return;
        const now = Date.now();
        if (!force && now - lastEditAt < TELEGRAM_STATUS_EDIT_THROTTLE_MS) return;
        lastEditAt = now;
        bot.editMessageText(renderTelegramChecklist(steps), { chat_id: replyTarget, message_id: statusMsgId }).catch(() => {});
      };
      // Append a step (skipping consecutive duplicates) and re-render.
      const pushStep = (label: string, force = false) => {
        if (steps[steps.length - 1] === label) return;
        steps.push(label);
        renderStatus(force);
      };

      try {
        if (bot) {
          const ping = () => { bot.sendChatAction(replyTarget, 'typing').catch(() => {}); };
          ping();
          typingTimer = setInterval(ping, TELEGRAM_TYPING_INTERVAL_MS);
        }
        if (bot && showProgress) {
          try {
            const m = await bot.sendMessage(replyTarget, TELEGRAM_INITIAL_STATUS);
            statusMsgId = m.message_id;
          } catch (e) {
            logger.warn('Telegram status message failed to send: ' + (e as Error).message);
          }
        }

        removeDebug = agent.onDebug((event) => {
          if (event.phase === 'guardian_confirm') {
            const data = event.data as { callId?: string; toolName?: string; command?: string; args?: unknown; channelType?: string; senderId?: string };
            // The debug bus broadcasts to every running conversation. Show the
            // request only in the conversation that raised it; an event
            // without a matching origin is shown nowhere.
            if (data?.senderId !== envelope.sender.id || data?.channelType !== 'telegram') return;
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
            // Reflect the approval wait as a checklist step (forced past the
            // throttle) so it doesn't look stuck while the agent blocks for the
            // user's Approve/Deny tap.
            pushStep('🔐 Waiting for your approval', true);
            return;
          }

          // TG-3: append the phase (cognitive-cycle + core LLM/tool) as a
          // checklist step so the model's phases and tool usage show explicitly.
          // Known limitation: agent.onDebug is a shared bus with no per-message
          // correlation id, so under truly concurrent messages to the same agent
          // a chat may briefly show another chat's step; a real fix needs a
          // sessionId threaded through emitDebug (tracked follow-up).
          if (showProgress && bot && statusMsgId !== undefined) {
            const label = telegramStepLabel(event.phase, event.data);
            if (label) pushStep(label);
          }
        });

        const response = await agent.handleMessage(envelope);
        removeDebug();
        removeDebug = undefined;
        await clearStatus();
        await sendTelegramResponse(replyTarget, response, envelope.id, { agent, sender: envelope.sender });
      } catch (err: unknown) {
        const errMsg = (err as Error).message || 'Unknown error';
        logger.error('Telegram handler error: ' + errMsg);
        if (bot) {
          bot.sendMessage(replyTarget, `⚠️ Error: ${errMsg.substring(0, 200)}`, {
            reply_to_message_id: parseInt(envelope.id, 10) || undefined
          }).catch(() => {});
        }
      } finally {
        if (typingTimer) clearInterval(typingTimer);
        if (removeDebug) removeDebug();
        await clearStatus();
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

        // Same resolver as for messages: owner vs. other approved user.
        const sender = resolveTelegramSender(
          senderId,
          query.from.username || query.from.first_name,
          ownerId,
        );
        if (!sender) return;

        // Guardian approvals release the owner's pending tool calls; only the
        // owner may press them.
        if (query.data.startsWith('g:') && !sender.isOwner) {
          await bot.answerCallbackQuery(query.id, {
            text: 'Only the owner can approve or deny this.',
            show_alert: true,
          }).catch(() => {});
          return;
        }

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
          // Choice capture: the press of a button of an earlier offer. Guardian
          // approvals (`g:`) returned above and never reach here; the capture
          // refuses them again. Only the same user's press counts (checked in the
          // capture against the user the offer went to). Never fails the press.
          if (!query.data.startsWith('g:')) {
            try {
              await agent.recordChoiceMade({
                sender,
                offerRef: telegramOfferRef(chatId, query.message.message_id),
                callbackData: query.data,
              });
            } catch (e: unknown) {
              logger.warn('Telegram choice-made capture failed: ' + (e as Error).message);
            }
          }
          const envelope: MessageEnvelope = {
            id: query.id,
            channel: 'telegram',
            accountId: 'default',
            chatType: 'dm',
            sender,
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
              await sendTelegramResponse(chatId, response, undefined, { agent, sender });
            }
          }
        }
      } catch (err: unknown) {
        logger.error('Telegram callback error: ' + (err as Error).message);
      }
    });
}

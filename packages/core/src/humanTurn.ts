import type { MessageEnvelope } from './types/message.js';

/** Senders that are synthetic even though they claim `isOwner: true`. */
const SYNTHETIC_SENDER_IDS: ReadonlySet<string> = new Set(['scheduler', 'cron', 'initiative']);

/** Channels that never carry a live human turn. */
const NON_HUMAN_CHANNELS: ReadonlySet<string> = new Set(['system', 'cron', 'webhook']);

/** Chat types of a live conversation (web chat, CLI and Telegram all use `dm`; Telegram groups use `group`). */
const HUMAN_CHAT_TYPES: ReadonlySet<string> = new Set(['dm', 'group']);

/**
 * True only for a turn in which the verified owner is present in a live,
 * human-facing conversation. Synthetic envelopes (the scheduler, the cron
 * trigger endpoint, webhooks, the initiative cycle) claim `isOwner: true` but
 * are not the owner speaking, and their text can be authored by the agent
 * itself, so they must never count as an owner's word (goal mandates, owner-gated
 * goal tools). The rule:
 *
 *   sender.isOwner === true
 *   AND chatType is `dm` or `group`
 *   AND channel is not `system`, `cron` or `webhook`
 *   AND sender.id is not `scheduler`, `cron` or `initiative`.
 */
export function isHumanOwnerTurn(envelope: MessageEnvelope): boolean {
  return (
    envelope.sender?.isOwner === true &&
    HUMAN_CHAT_TYPES.has(envelope.chatType) &&
    !NON_HUMAN_CHANNELS.has(String(envelope.channel)) &&
    !SYNTHETIC_SENDER_IDS.has(envelope.sender.id)
  );
}

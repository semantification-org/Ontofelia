import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDefaultConfig } from '@ontofelia/config';
import { PRIMARY_AGENT_ID } from '@ontofelia/core';
import { setupTelegramChannel } from '../telegram.js';

// A reply from a non-owner conversation must not make the gateway upload local
// files from outside the workspace. The owner keeps the unrestricted behaviour,
// and the bundled avatar stays available to everyone.

const tmpRoots: string[] = [];
afterAll(() => {
  for (const d of tmpRoots) fs.rmSync(d, { recursive: true, force: true });
});

function makeEnvelope(senderId: string, isOwner: boolean, id: string) {
  return {
    id, channel: 'telegram', accountId: 'a', chatType: 'dm',
    sender: { id: senderId, channelPrefix: 'telegram', isOwner },
    timestamp: new Date().toISOString(), text: 'hi', mentions: [], attachments: [],
  };
}

function makeHarness(replyFor: (senderId: string) => string = () => 'done') {
  const sent: { chat: string; text: string }[] = [];
  const photos: { chat: string; file: string }[] = [];
  const bot = {
    sendChatAction: () => Promise.resolve(true),
    sendMessage: (chat: string, text: string) => {
      sent.push({ chat: String(chat), text });
      return Promise.resolve({ message_id: 1 });
    },
    editMessageText: () => Promise.resolve(true),
    deleteMessage: () => Promise.resolve(true),
    sendPhoto: (chat: string, file: string) => {
      photos.push({ chat: String(chat), file });
      return Promise.resolve({ message_id: 2 });
    },
  };
  let messageCb: ((envelope: unknown) => Promise<void>) | undefined;
  const adapter = {
    getBot: () => bot,
    onMessage: (cb: (envelope: unknown) => Promise<void>) => { messageCb = cb; },
    onCallbackQuery: () => {},
  };
  const agent = {
    onDebug: () => () => {},
    handleMessage: async (env: { sender: { id: string } }) => ({ text: replyFor(env.sender.id) }),
  };
  return { sent, photos, adapter, agent, getMessageCb: () => messageCb };
}

async function setup(h: ReturnType<typeof makeHarness>, workspace?: string) {
  const config = getDefaultConfig();
  if (workspace) config.agents.defaults.workspace = workspace;
  const agents = new Map([[PRIMARY_AGENT_ID, h.agent]]);
  await setupTelegramChannel(
    config,
    h.adapter as unknown as Parameters<typeof setupTelegramChannel>[1],
    { isAllowed: async () => true } as unknown as Parameters<typeof setupTelegramChannel>[2],
    agents as unknown as Parameters<typeof setupTelegramChannel>[3],
  );
}

describe('local image upload from a non-owner reply', () => {
  function layout() {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-img-'));
    tmpRoots.push(base);
    const workspace = path.join(base, 'a', 'ws');
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(path.join(base, 'outside'), { recursive: true });
    const outside = path.join(base, 'outside', 'private.png');
    fs.writeFileSync(outside, 'not-really-a-png');
    const relative = path.relative(path.resolve(workspace, '..'), outside);
    const inside = path.join(workspace, 'pic.png');
    fs.writeFileSync(inside, 'inside-image');
    const insideRelative = path.relative(path.resolve(workspace, '..'), inside);
    return { base, workspace, outside, relative, inside, insideRelative };
  }

  it('control: a plain text reply sends no photo', async () => {
    const { workspace } = layout();
    const h = makeHarness(() => 'just text');
    await setup(h, workspace);
    await h.getMessageCb()!(makeEnvelope('other', false, 'm1'));
    expect(h.photos).toEqual([]);
    expect(h.sent.some((m) => m.chat === 'other' && m.text.includes('just text'))).toBe(true);
  });

  it('control: the relative path in the second case really leaves the workspace', () => {
    const { relative } = layout();
    expect(relative.startsWith('..')).toBe(true);
  });

  it('does not upload a file outside the workspace named by an absolute file:// URL', async () => {
    const { workspace, outside } = layout();
    const h = makeHarness(() => `here ![x](file://${outside})`);
    await setup(h, workspace);
    await h.getMessageCb()!(makeEnvelope('other', false, 'm1'));
    expect(h.photos.map((p) => p.file)).not.toContain(outside);
  });

  it('does not upload a file outside the workspace named by a relative ../ path', async () => {
    const { workspace, outside, relative } = layout();
    const h = makeHarness(() => `here ![x](${relative})`);
    await setup(h, workspace);
    await h.getMessageCb()!(makeEnvelope('other', false, 'm1'));
    expect(h.photos.map((p) => p.file)).not.toContain(outside);
  });

  async function upload(reply: string, workspace: string, isOwner: boolean) {
    const h = makeHarness(() => reply);
    await setup(h, workspace);
    await h.getMessageCb()!(makeEnvelope('other', isOwner, 'm1'));
    return h.photos.map((p) => p.file);
  }

  it('uploads an image inside the workspace for a non-owner (absolute path)', async () => {
    const { workspace, inside } = layout();
    expect(await upload(`![x](file://${inside})`, workspace, false)).toContain(inside);
  });

  it('uploads an image inside the workspace for a non-owner (relative path)', async () => {
    const { workspace, inside, insideRelative } = layout();
    expect(await upload(`![x](${insideRelative})`, workspace, false)).toContain(inside);
  });

  it('still uploads a file outside the workspace for the owner', async () => {
    const { workspace, outside } = layout();
    expect(await upload(`![x](file://${outside})`, workspace, true)).toContain(outside);
  });

  it('does not upload through a symlink inside the workspace that points outside', async () => {
    const { workspace, outside } = layout();
    const link = path.join(workspace, 'link.png');
    fs.symlinkSync(outside, link);
    expect(await upload(`![x](file://${link})`, workspace, false)).not.toContain(link);
  });

  it('does not upload from a sibling directory whose name starts with the workspace name', async () => {
    const { base, workspace } = layout();
    const evilDir = path.join(base, 'a', 'ws-evil');
    fs.mkdirSync(evilDir, { recursive: true });
    const evil = path.join(evilDir, 'x.png');
    fs.writeFileSync(evil, 'evil');
    expect(await upload(`![x](file://${evil})`, workspace, false)).not.toContain(evil);
  });

  const avatar = fileURLToPath(
    new URL('../../../../web-ui/public/ontofelia-avatar.jpg', import.meta.url),
  );
  it.skipIf(!fs.existsSync(avatar))(
    'uploads the bundled avatar for a non-owner (skipped when the checkout lacks the file)',
    async () => {
      const { workspace } = layout();
      expect(await upload(`![me](file://${avatar})`, workspace, false)).toContain(avatar);
    },
  );
});

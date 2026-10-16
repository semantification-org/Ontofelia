# Demo: an agent that keeps working on its own and reports back

This walkthrough shows the initiative system end to end on a local install. You
ask the agent in plain words to work on something later. It arms a goal with
your message as mandate and a wake time. When the wake comes due, while nobody
is chatting, it runs an unattended cycle, records progress, and you inspect what
happened.

Every step uses a supported chat command or the normal chat. Nothing needs a
script, a stopped gateway or a manual edit of the store. Read
[Initiative Architecture](initiative-architecture.md) for what each step relies
on (mandate, guards, allow-list, notification).

## What you must know before you start

- **Three switches, all off by default, all owner-only:**
  `/cog cycle on` (the cycle manager records your messages as episodes, which is
  the only thing a goal mandate may point to), `/initiative on` (the kill switch
  for self-initiated cycles) and, for the web panel only, `/cog debug on`. No
  other flag is needed: `flagGoalStack` is not required by `arm_goal`, by the
  wake path or by the initiative cycle.
- **Whether the model calls `arm_goal` depends on the language model.** The
  system prompt tells it to use the tool only when you explicitly ask for work
  later or regularly. A weak model may answer in prose instead. Step 3 gives an
  explicit phrasing that works with most models; if the model still does not call
  the tool, the demo cannot continue from chat (there is no command that arms a
  goal) and you have learned something about that model.
- **The web chat can arm a goal.** The web chat streams the reply; with the cycle
  manager on, a streamed turn records the same mandate episode as any other
  owner turn. The commands (`/cog cycle on`, `/initiative on`, `/goals`,
  `/initiative`) work in every client.
- **The reply of an initiative cycle is shown to nobody.** You learn what
  happened from `/initiative`, `/goals`, the web panel, the API and, if
  configured, a Telegram notification. What the model does during the cycle is
  not deterministic; the cycle itself is always recorded.
- **Wakes need a running gateway.** Keep it running until the wake has fired. A
  wake that comes due while `/initiative` is off is consumed without a cycle.

## Prerequisites

- A working install with a configured provider and a build from this checkout
  (see the README and [Configuration](configuration.md)), with the default
  embedded triplestore.
- Optional, for a push message: a Telegram channel with an owner target
  (`channels.telegram.ownerChatId` or `notifications.target`, see
  [Channels](channels.md)). Without it a notification is suppressed with the
  reason `no-target` and queued for the next conversation.
- You must be the owner in the chat you use (the web chat and `POST /api/chat`
  with the default sender `owner` are). Non-owners and scheduled turns are
  refused by every command below.

## Walkthrough

### 1. Start the gateway

```bash
ontofelia gateway start
```

Open the web chat at `http://127.0.0.1:18780` (see
[Deployment](deployment.md)).

### 2. Switch on the cycle manager and initiative

```
/cog cycle on
```

Expected: `Cycle manager enabled (flagCycleManager = true).` followed by a line
saying that owner messages are now recorded as episodes.

```
/initiative on
```

Expected: `Initiative enabled (flagInitiative = true).` plus a note that nothing will
fire until a goal has an owner mandate and a wake time. That is correct at this
point.

Check the state at any time with `/initiative`: while the cycle manager is off
the report has the line `Cycle manager: OFF (flagCycleManager). arm_goal needs
/cog cycle on.`; `/cog health` shows `flags.cycleManager`.

### 3. Ask the agent to work on something later

Send a plain request with a short delay. In the web chat or
Telegram, write it as a normal message. With the API (the token comes from
`ontofelia auth token`):

```bash
curl -s -X POST http://127.0.0.1:18780/api/chat \
  -H "Authorization: Bearer $(ontofelia auth token)" \
  -H "Content-Type: application/json" \
  -d '{"message": "Please check the build status for me in 2 minutes."}'
```

If the model answers in prose and does not arm anything, use the explicit
phrasing:

```
Use your arm_goal tool now: create a new goal "Check the build status" and wake yourself in PT2M.
```

Expected: the agent replies that it will look into it, and the tool result says
`Created and armed goal "Check the build status" (urn:...)` and
`Next wake: <ISO time> (once).` If it says that the cycle manager must be on,
step 2 was skipped. If it says initiative is switched off, run `/initiative on`.

```
/goals
```

Expected shape:

```
🎯 Your goals (1):

*Active*
• Check the build status — active, priority 0.60
   next: none planned
   waiting until in 118 s (2026-...)
```

### 4. Wait for the wake

Do not send anything for about two minutes. The scheduler fires the wake job
`initiative-<goal>` at the wake time. The guards run first (flag, hourly and
daily cap, per-goal cooldown, mandate check); then an unattended cycle runs with
a restricted tool set. In this cycle the model can read, call `notify_owner` and
call `update_goal_step` for this one goal. It cannot arm goals or change mandate,
wake or priority.

### 5. Inspect

```
/initiative
```

Expected shape (the outcome depends on what the model did: "with output", "with
tool action(s)" or "as a no-op"; an error shows as `[error]`):

```
⚙️ Initiative: ON (flagInitiative)
Runaway counter: 1/4 in the last hour, 1/24 in the last 24h (caps are defaults).

Recent initiative cycles (1):
• just now (2026-...): trigger: Initiative wake. Goal "Check the build status" (urn:...) is due for autonomous work: scheduled wake due. ... | outcome: initiative cycle completed with output | tools: 1

Recent notifications: none.
```

```
/goals
```

If the model called `update_goal_step`, the goal now shows its progress, for
example `next: Read the build log`, and no longer shows "waiting until": a
one-shot wake is cleared when it fires. If the model did not call the tool, the
goal is unchanged except for the missing wake. That is the model's choice, not an
error.

**Notification.** If Telegram is configured and the model called `notify_owner`
you also get a message there. If it was suppressed (`no-target`, `daily-cap`,
`quiet-hours`), `/initiative` lists the reason under "Recent notifications" and
the next conversation with you opens with a "While you were away" summary.

**Web panel.** Send `/cog debug on`, then click "Cognitive Panel" in the web UI
sidebar. The Initiative tab shows the flag, counters, recent cycles and
notifications; the Goals tab shows the goal with its step.

**API.** The same data as JSON (needs `/cog debug on`, otherwise 403):

```bash
curl -s -H "Authorization: Bearer $(ontofelia auth token)" \
  "http://127.0.0.1:18780/api/cog/inspect/initiative?limit=10"
```

### 6. Turn it off

```
/initiative off
/cog cycle off
```

Expected: `Initiative disabled (flagInitiative = false).` and `Cycle manager disabled
(flagCycleManager = false).` From now on any wake is a silent no-op. Optionally
`/cog debug off`.

## Limits that apply during the demo

- At most 4 initiative cycles per rolling hour and 24 per rolling day, and a
  30 minute cooldown per goal. A wake inside the cooldown is skipped and logged
  as an initiative episode with the reason. These are fixed defaults.
- A recurring goal (`every`, for example `PT30M`, `PT2H` or `P1D`) cannot be
  shorter than 30 minutes. Ask for one in plain words ("every 2 hours"); the
  wake then repeats until you abandon the goal or switch initiative off.
- Trying to make the agent do something outside the allow-list during a cycle
  (for example writing a file) is refused with the rule
  `initiative-restricted-tool` and logged in the tool audit log.

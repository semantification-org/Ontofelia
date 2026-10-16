# Initiative Architecture

This document describes the governed-autonomy ("initiative") system as it is
implemented in this repository: how an agent can be woken by a goal, work on it
unattended, and report back to its owner, and which hard limits surround that.

Source comments cite this file by section number (for example "§5" or "§7").
The numbering is stable on purpose:

| Section | Topic | Main code |
|---|---|---|
| §1 | Purpose and safety stance | n/a |
| §2 | Concepts | n/a |
| §3 | Kill switch, defaults, configuration | `packages/agent-runtime/src/cognitive/CognitiveConfig.ts` |
| §4 | Components and data flow | `apps/gateway/src/index.ts` |
| §5 | Goals, wake policy, mandate gate, runaway guards | `GoalStack.ts`, `InitiativeService.ts` |
| §6 | The initiative cycle | `CycleManager.ts`, `packages/agent-runtime/src/index.ts` |
| §7 | Owner notification | `NotificationService.ts`, `notify_owner.ts` |
| §8 | Tool restrictions and privacy for unattended cycles | `initiativeTools.ts`, `ToolExecutor.ts` |
| §9 | Observability and arming | `/goals`, `/initiative`, `list_goals`, `arm_goal`, `update_goal_step`, inspect API, web panel |
| §10 | Not implemented / limits | n/a |
| §11 | Source map | n/a |
| §12 | Recorded design decisions | n/a |

File paths below are relative to the repository root. Line numbers are
deliberately not given.

## 1. Purpose and safety stance

The system lets an agent keep working on a goal between conversations and tell
its owner about it, without a person present. Because nobody is watching, the
design is restrictive by default:

- The whole capability is behind one switch, `flagInitiative`, which is OFF by
  default (§3). With the switch off, a due wake is a silent no-op.
- A goal never wakes on its own authority. It needs a "mandate", a reference to
  a real inbound human utterance recorded in episodic memory (§5.1).
- Hard runaway limits (per hour, per day, per goal) are enforced in code, not
  by the language model (§5.3).
- An unattended cycle may only use a small allow-list of tools: one
  notification tool plus read-only tools. The limit is enforced where tools are
  executed, not only where they are advertised (§8).
- Everything the agent does while unattended leaves an episode in episodic
  memory, and the owner can read it back (§6, §9).
- The agent cannot change its own wake schedule: the scheduler job-name prefix
  `initiative-` is reserved and blocked for the `cron_manage` tool (§8).

The code comments describe "no second mind": an initiative cycle is the normal
cognitive cycle run with a synthetic trigger, not a separate agent loop (§6).

## 2. Concepts

- **Goal.** A `cogt:Goal` resource in the goal graphs, managed by `GoalStack`.
  It has a status (`proposed`, `active`, `blocked`, `resolved`, `abandoned`), a
  priority in [0,1], optional deadline, planned steps, current step and step
  progress. Goals live in a per-session graph `urn:<agent>:cog:goals:<session>`
  or the fixed graph `urn:<agent>:cog:goals:longterm`.
- **Wake policy.** Three optional goal properties: `cogt:wakeAt` (absolute next
  wake), `cogt:wakeEvery` (a recurring interval as an ISO-8601 duration) and
  the tracking fields `cogt:lastWakeAt`, `cogt:wakeCount`,
  `cogt:consecutiveFailures`.
- **Mandate.** The property `cogt:mandatedBy`: the IRI of an episode in the
  episodic graph that proves the owner asked for this work. See §5.1 for the
  exact validity test.
- **Drive.** A `cogt:Drive` individual (label, statement, rank) in the self
  graph, seeded in `bootstrap/self.ttl` (Truthfulness, Service, Growth,
  Accountability). Drives are rendered into the system prompt as "What drives
  me" (`packages/semantic-memory/src/KnowledgeEngine.ts`). A goal may point to a
  drive with `cogt:servesDrive`; the only runtime use of that link is that
  `/goals` shows the drive's label. A drive grants no permission.
- **Wake.** A one-time scheduler job named `initiative-<goalUri>`, scheduled for
  the goal's `wakeAt`. When it fires, `InitiativeService.onWake` decides whether
  a cycle runs.
- **Initiative cycle.** A cognitive cycle run in `mode: 'initiative'` with a
  synthetic envelope (`chatType: 'initiative'`) that names the goal (§6).
- **Initiative episode.** One audit record (`episodeType: 'initiative'`) per
  unattended cycle, plus skip records for governed no-ops (§5, §6).
- **Notification.** An out-of-band message to the owner, governed by a daily
  cap and quiet hours, with a digest for suppressed items (§7).

## 3. Kill switch, defaults and configuration

**`flagInitiative`.** `CognitiveConfig.isInitiativeEnabled()` reads the boolean
triple `cog.flagInitiative` on `urn:<agent>:setup:cognitive` in the setup graph
`urn:<agent>:setup`. It is `false` when absent or unparseable. It is flipped at
runtime by the owner-only chat command `/initiative on` and `/initiative off`
(§9), which call `CognitiveConfig.setInitiativeEnabled`. No other code enables
it, and the default is never changed by configuration files.

The flag is checked first in `InitiativeService.onWake` (before any other
guard). With the flag off, a wake returns `flag-off` and nothing else happens:
no episode, no counter change, no dispatch.

**Related cognitive flags.** These are separate flags in the same setup
resource, all default OFF (the design note in
`docs/cognitive-architecture/09-integration-and-migration.md` shows the
triples):

- `flagCycleManager`: routes conversational messages through `CycleManager`.
  Only then are `message-received` episodes written, and those are the only
  thing a mandate can validly point to (§5.1). `arm_goal` (§9) therefore
  refuses to work without this flag. The owner switches it with the chat
  command `/cog cycle on` and `/cog cycle off` (`CognitiveConfig.setCycleManagerEnabled`).
  The command is refused for non-owners and for synthetic owner senders
  (scheduler, cron, webhook, initiative; `isHumanOwnerTurn`). `/initiative`
  says so when the flag is off, and `/cog health` shows its state.
- `flagGoalStack`: manages goals during conversational cycles. Not required for
  initiative cycles, which always run with goal management on (§6).
- `flagDebugPanel`: `/cog debug on|off`. Required for the `/api/cog/inspect/*`
  routes and the web panel (§9).

**Runaway guards.** `InitiativeGuardConfig` in
`packages/agent-runtime/src/cognitive/InitiativeService.ts` has these defaults:
4 cycles per rolling hour, 24 per rolling day, a 30 minute per-goal cooldown, a
tool-round budget of 25, a goal-session transcript cap of 500 entries, and a
2000 ms delay for wakes that are already in the past. The gateway constructs
`InitiativeService` without a `guards` override, so the defaults are the
effective values; there is no configuration key for them.

**Notification policy.** The `notifications` section of the configuration
schema (`packages/config/src/schema.ts`) has `maxPerDay` (default 5, 0 means
never send), optional `quietHours` (`start` and `end` as `HH:MM`, wrapping
midnight), `minPriorityDuringQuietHours` (default `high`), optional IANA
`timezone`, and optional `target`. The `approvalMaxPerDay` key
that older configs may carry has been removed; it is ignored on load.

## 4. Components and data flow

Everything is composed in `apps/gateway/src/index.ts`:

1. A `NotificationService` is created with the triplestore, the channel
   registry (lazily resolving the Telegram adapter) and an owner-target
   resolver (`apps/gateway/src/services/notificationTarget.ts`). It is
   registered as the backing service of the `notify_owner` tool and set as the
   agent's digest source (§7). A `list_goals` tool is registered next to it.
2. A `JobScheduler` is created and `scheduler.onJob` is installed. Jobs whose
   name starts with `initiative-` are routed to `InitiativeService.onWake`;
   everything else is a normal cron job.
3. `InitiativeService` is created with a `dispatch` function that calls
   `defaultAgent.handleMessage(envelope)`, and a session port that maps a goal
   to a persistent session (key `initiative:<goalKey>`).
4. `InitiativeService.recoverOnStart()` runs once at boot, best effort (§5.2).

```
goal (wakeAt, mandatedBy)            -- written by the owner-only arm_goal tool, see §9
        |
        v
InitiativeService.registerGoalWake --> one-time job "initiative-<goalUri>"
        |                                     (JobScheduler, persisted)
        v   (timer fires)
scheduler.onJob --> InitiativeService.onWake
        flag -> goal active -> mandate -> hourly/daily cap -> cooldown
        |
        v
dispatch(envelope chatType='initiative') --> AgentRuntime.handleMessage
        |
        v
CycleManager.runCycle(mode='initiative') --> LLM with allow-listed tools
        |                                        |
        v                                        v
initiative episode                        notify_owner -> NotificationService
```

## 5. Goals, wake policy, mandate gate and runaway guards

Code: `packages/agent-runtime/src/cognitive/GoalStack.ts` and
`packages/agent-runtime/src/cognitive/InitiativeService.ts`.

### 5.1 Wake policy and the mandate gate

**Writing a wake policy.** `GoalStack.push` accepts `wakeAt`, `wakeEvery`,
`mandatedBy` and `servesDrive`; `GoalStack.setWake` updates `wakeAt` and
`wakeEvery` of an existing goal (if only `wakeEvery` is given and there is no
`wakeAt`, the first wake is `now + wakeEvery`). All writes go through
`GraphRegistry.assertWritable`, so a goal can only be written to the registered
goal graphs.

**Duration grammar.** `wakeEvery` is a subset of ISO-8601 durations:
`P[nD][T[nH][nM][nS]]` with at least one component, for example `PT30M`,
`PT2H`, `P1D`, `P1DT12H`. Weeks, months and years are rejected because their
length is not fixed. A `wakeEvery` shorter than the minimum interval (the
per-goal cooldown, 30 minutes by default) is rejected at write time because it
could only churn; one longer than about 10 years is rejected as well.

**Mandate gate.** `GoalStack.isMandateValid(mandatedBy)` returns true only if
the IRI resolves, in `urn:<agent>:cog:episodic`, to a subject that

1. is typed `cogt:Episode`,
2. has `episodeType` `message-received` (an inbound utterance, not agent
   output),
3. has an `actor` that exists and is not the agent's own self entity, and
4. carries `cogt:actorIsOwner true`.

A made-up IRI, a non-episode subject (a drive, another goal) or an
agent-/initiative-authored episode therefore fails. The gate is used on every
path: `wakingGoals()` (the single eligibility query: status `active`, a
mandate, a `wakeAt`), `dueWakes()` (the same, filtered by time) and
`InitiativeService.onWake`.

The owner marker is written by `CycleManager` only for a human owner turn
(`isHumanOwnerTurn` in `packages/core/src/humanTurn.ts`): `sender.isOwner` is
true, `chatType` is `dm` or `group`, `channel` is not `system`, `cron` or
`webhook`, and the sender id is not `scheduler`, `cron` or `initiative`. The
initiative envelope, scheduled cron jobs (whose text the agent can write
itself), the `/api/cron-trigger` endpoint and webhooks all claim `isOwner: true`
and therefore never produce a valid mandate. The same predicate sets
`ToolContext.ownerPresent`, which `arm_goal` and `update_goal_step` require
(the latter also accepts an initiative cycle for its own goal). Episodes written
before the marker existed lack it and fail the gate (§10).

**Where wakeable goals must live.** `InitiativeService` reads goals through a
`GoalStack` scoped to the fixed pseudo-session `initiative`, so it sees the
long-term goal graph `urn:<agent>:cog:goals:longterm` (and that pseudo-session's
graph), not other sessions' graphs. A mandated waking goal in some other
session graph is invisible to the wake path: `wakingGoals()` does not list it
and `onWake` reports `goal-missing`. Goals reach the long-term graph through
`GoalStack.migrateLongterm` (at `/new` or `/cog migrate`, which act only when
`flagGoalStack` is on, for goals that are resolved, flagged `cogt:longTerm true`,
or have a future deadline) or by being
written there directly. The `arm_goal` tool (§9) uses
`GoalStack.promoteToLongterm`, the single-goal form of that move.

### 5.2 Scheduling and downtime recovery

`InitiativeService.registerGoalWake(goal)` removes any pending job of the same
name, then adds a one-time scheduler job `initiative-<goalUri>` at
`max(wakeAt, now + 2 s)` for the agent. The job is persisted by the scheduler.

`recoverOnStart()` replaces any periodic sweep (see §12.2). Once at boot it
lists `wakingGoals()`; for each future wake it re-registers the job, and for
each overdue wake it removes the persisted job and calls `onWake` directly
(subject to all guards), so a restart cannot fire a wake twice. No recurring
tick is installed.

### 5.3 The guard order in `onWake`

Wakes are serialized per agent through a promise chain, so two cycles never
overlap and the cap check cannot race. The order is:

1. `flagInitiative` off: return `flag-off`.
2. Goal unknown: `goal-missing`. Goal not `active`: `goal-inactive`.
3. Mandate gate fails: `no-mandate`.
4. Hourly cap (4 per rolling hour): `rate-limit-hour`.
5. Daily cap (24 per rolling day): `rate-limit-day`.
6. Per-goal cooldown (30 minutes since `lastWakeAt`): `cooldown`.
7. Otherwise: record the run, stamp the goal (`recordWake`), resolve the goal
   session, and dispatch the initiative envelope (`dispatched`).

Details that matter:

- The run counter is persisted as `cogt:initiativeRunAt` timestamps on
  `urn:<agent>:setup:initiative` in the setup graph, pruned to 24 hours. A run
  is counted at the dispatch attempt, so a cycle that later fails still uses
  budget.
- A cap or cooldown skip re-arms the goal's wake (at the time budget frees, or
  at the cooldown boundary, never earlier than `now + wakeEvery` for recurring
  goals) instead of dropping it.
- `recordWake` rolls `wakeAt` forward by `wakeEvery` for recurring goals and
  clears `wakeAt` for one-shot goals.
- Skips are written as an `initiative` episode ("initiative skipped for goal
  ...: reason"), at most one per goal per cooldown window; further skips are
  only logged.

### 5.4 Failure handling

If dispatch throws, `recordWakeFailure` increments `consecutiveFailures`. At
3 consecutive failures the goal becomes `blocked` with reason
`initiative-failures-exceeded` and stops waking until something unblocks it.
A successful dispatch clears the counter. When the goal is `resolved` or
`abandoned` after a cycle, its goal session is archived; when it is still
`active` with a `wakeAt`, the next wake is registered.

## 6. The initiative cycle

**Envelope.** `InitiativeService.buildEnvelope` creates a synthetic
`MessageEnvelope`: `channel: 'system'`, `chatType: 'initiative'`, sender id
`initiative` with `isOwner: true`, and `routingHints.initiativeGoalId` set to
the goal IRI and `routingHints.sessionId` set to the goal's session. The text
says the goal is due ("deadline approaching" if the deadline is within 24
hours, else "scheduled wake due"), that the agent runs unattended and that its
output is shown to nobody, and asks it to make progress and "only reach the
owner if the matter is urgent".

**Session continuity.** The gateway maps each goal to a session with key
`initiative:<goalKey>`, so consecutive wakes share a transcript. When the
transcript reaches the cap (500 entries) the session is archived with a note and
a fresh one is started.

**Runtime path.** In `AgentRuntime.handleMessage`
(`packages/agent-runtime/src/index.ts`), an envelope with
`chatType === 'initiative'` runs through `CycleManager.runCycle` with
`mode: 'initiative'`, goal management on, and a tool-round budget of 25
(`INITIATIVE_TOOL_ROUNDS`, versus 100 for conversations). The `flagInitiative`
check happens upstream in `InitiativeService`, not here. The `ToolContext`
gets `unattended: true` from `chatType === 'initiative'`; that single signal
drives the restrictions in §8.

**Cycle manager.** `RunCycleOptions.mode` is `'conversational'` (default,
unchanged) or `'initiative'`. In initiative mode, goal management uses the
goal named by `initiativeGoalUri` as the active goal (the implicit
"Respond to the user" goal is never seeded, because there is nobody to
respond to), and the persistence step additionally writes an initiative
episode.

**Initiative episode.** `CycleManager.writeInitiativeEpisode` appends one
episode of `episodeType: 'initiative'` per cycle, with the payload
`trigger: <envelope text> | outcome: <reason> | tools: <count>`, outcome
`success` or `error`, the goal as `partOfGoal`, and salience 0.8. The reason is
one of: aborted (core delegation threw), completed with output, completed with
tool action(s), or completed as a no-op. The cycle's own output is not
delivered to anyone.

## 7. Owner notification

Code: `packages/agent-runtime/src/cognitive/NotificationService.ts`,
`packages/tools/src/channel/notify_owner.ts`,
`apps/gateway/src/services/notificationTarget.ts`, and the digest rendering in
`packages/agent-runtime/src/index.ts`.

**The tool.** `notify_owner(message, priority?, goalId?)` is the one way an
unattended cycle can reach its owner. Its behavior depends on the caller:

- unattended initiative cycle: forwards to `NotificationService.deliver` and
  reports sent or deferred (with the reason);
- the owner in a normal chat: does nothing and says so (the reply channel
  already reaches the owner);
- any other sender: refuses. It is also hidden from non-owner senders in tool
  advertisement.

**Delivery policy.** `NotificationService.deliver` is serialized, and
evaluates in this order, before any send:

1. Resolve the owner target. None: suppress as `no-target`.
2. Daily cap (`notifications.maxPerDay`, counting delivered notifications over
   a rolling 24 hours): suppress as `daily-cap`.
3. Quiet hours (a wall-clock `HH:MM` window in the configured timezone): items
   below `minPriorityDuringQuietHours` are suppressed as `quiet-hours`.
4. Send through the Telegram adapter (`sendText(target, text)`). No adapter:
   `no-target`. A thrown error: `send-failed` (the budget is not consumed).

Suppressed items are queued as digest items in the setup graph (at most 50, the
oldest dropped). Every notification, sent or suppressed, is written as an
episode of type `notification` whose payload is JSON with `priority`, `reason`
and optional `goalId`; the message text is not stored in that episode.

**Target resolution.** `resolveOwnerTarget` uses, in order,
`notifications.target`, `channels.telegram.ownerChatId`, and a Telegram
allow-list entry only when exactly one entry exists. With several allow-listed
users and no explicit target there is no target, nothing is delivered, and the
gateway logs a one-time warning.

**Digest on next contact.** On the next conversational message from the owner
(never in an initiative cycle, never for other senders), the runtime drains the
queue and adds a "While you were away" section to the system prompt. Each line
is reduced to inert single-line text (control characters and leading markdown
characters removed, 200 characters at most), at most 10 lines are shown, and
the block is marked as untrusted relayed content to be treated as data.

## 8. Tool restrictions and privacy for unattended cycles

**Allow-list.** `packages/agent-runtime/src/initiativeTools.ts` exports
`INITIATIVE_ALLOWED_TOOLS`, the single list used by both enforcement points:

- `notify_owner`
- memory reads: `memory_ask`, `memory_sparql`, `memory_explain`
- inspection and utilities: `ontology_inspect`, `self_inspect`, `list_goals`,
  `web_fetch`, `read_pdf`, `datetime`, `calculator`
- goal progress: `update_goal_step` (confined to the cycle's own goal, §9)
- filesystem reads: `fs_read`, `fs_list`

**Two enforcement points.**

1. Advertisement: `AgentRuntime.getAllowedTools` shows an initiative cycle only
   tools from the list (after the normal tool policy).
2. Execution: `ToolExecutor.execute` denies any tool outside the list whenever
   `context.unattended` is true, with the rule name
   `initiative-restricted-tool`, and writes an audit entry. This deny cannot be
   approved or overridden, because no owner is present. The code comments call
   advertisement filtering defense in depth and the execution gate the security
   boundary. Because it is an allow-list, a newly added tool is excluded from
   unattended cycles until it is added on purpose.

So in an unattended cycle the agent cannot run `exec`, write files, change
cron jobs, store or retract memory, or propose ontology changes. The
approval-queue substrate that would let a cycle ask for such an action does not
exist yet (§10).

**Self-protection.** Independent of initiative mode, `SelfProtection` blocks
`cron_manage` calls with a label starting with `initiative-`
(`initiative-cron-protection`), and `packages/tools/src/utility/cron.ts` has
the same reserved prefix. The agent therefore cannot create, change or remove
its own wake jobs. This check is not disabled by the `allowSelfSourceWrites`
escape hatch.

**Privacy and data exposure.**

- `list_goals`, `arm_goal`, `update_goal_step`, `/goals` and `/initiative` are owner-only; the digest is shown
  only to the owner; `notify_owner` is hidden from non-owners.
- An initiative cycle can read: the knowledge graph (through the three memory
  read tools), and the file system and the web through `fs_read`, `fs_list`,
  `read_pdf` and `web_fetch`. These are subject to the same per-tool policy
  checks that apply to any tool call. There is no initiative-specific narrowing
  of which paths or URLs they may touch.
- The only outbound channel is `notify_owner`, which can reach only the
  resolved owner target.
- Initiative cycles write episodes, so the trigger text, outcome and tool count
  of every unattended cycle are stored in episodic memory.

## 9. Observability

All of these read the same stored state (goal triples, episodes, persisted
counters, the flag), without asking the model.

**`/goals`** (chat command, owner-only). `AgentRuntime.renderGoalsReport` lists
all goals from the session and long-term graphs, grouped Active, Proposed,
Blocked, Closed, priority-descending. For each goal it shows label, status and
priority; for open goals the next action; either "waiting until ..." (an active
goal whose wake is in the future) or "next wake"; the deadline; a blocked
reason; and the drive label if any. The per-goal facts come from `summarizeGoal`
in `packages/agent-runtime/src/cognitive/goalSummary.ts`. The next action is the
first planned step not yet done (from `plannedSteps` and `stepProgress`), else
the current step.

**`/initiative`** (chat command, owner-only).

- `/initiative` shows the flag state, the runaway counters (cycles in the last
  hour and day against the cap defaults, labelled "caps are defaults"), the
  recent initiative episodes, and the recent notification episodes with their
  delivery or suppression reason.
- `/initiative on` and `/initiative off` flip `flagInitiative`. When turning it
  on and no waking goal exists, the reply says that nothing will fire until a
  goal has an owner mandate and a wake time.
- `/initiative help` prints the usage.

**`list_goals`** (tool, owner-only, read-only). Returns the open goals as JSON
built by the same `summarizeGoal` as `/goals`, so the two cannot disagree. It
is in the initiative allow-list, so an unattended cycle can read its own goals.

**`arm_goal`** (tool, owner-only, writes). The one supported way to give a goal
a mandate and a wake from normal use. Code: `packages/tools/src/cognitive/arm_goal.ts`
(the tool) and `packages/agent-runtime/src/cognitive/armGoal.ts` (the goal writes);
the gateway wires them to `InitiativeService`.

- *Input.* An existing open goal (`goal`: label or IRI, matched against the same
  list as `/goals` and `list_goals`) or a new goal (`newGoal`: label, optional
  `priority`); exactly one of `wakeAt` (ISO-8601 timestamp with time zone, in
  the future) or `wakeIn` (ISO-8601 duration such as `PT2H`); optional `every`
  (recurring duration). `every` goes through the same `GoalStack` validation as
  any other write: grammar, minimum interval (the per-goal cooldown) and
  ceiling (§5.1); a refused interval writes nothing. An existing goal that is
  not given `every` keeps its own interval. A proposed goal is activated; a
  blocked goal, the implicit "Respond to the user" goal and a closed goal are
  refused. A new goal gets the type `cogt:OwnerRequestedWork`, priority 0.6 by
  default, and `cogt:longTerm true`.
- *Mandate.* The episode of the owner's current message. `CycleManager` writes
  that `message-received` episode before the tool loop of a conversational turn
  (it used to write it only afterwards, when the IRI could not be known) and
  puts its IRI on the tool context (`inboundEpisodeUri`); persistence reuses it,
  so there is still exactly one episode per turn. The tool never mints a mandate:
  it passes this IRI, and `armGoal` checks `GoalStack.isMandateValid` before any
  write. `isMandateValid` also requires the owner marker `cogt:actorIsOwner true`,
  which `CycleManager` writes on the inbound episode only when the sender is the
  verified owner and the turn is conversational. The initiative cycle's synthetic
  envelope (sender `initiative`, `isOwner: true`) and any non-owner sender get no
  marker, so neither can serve as a mandate. The episode exists only on the cycle manager path, so without
  `flagCycleManager` the tool refuses and names the
  flag; it does not switch any flag on. Initiative cycles record no such
  episode ahead of the tool loop.
- *Writes.* A new goal is pushed with mandate and wake and then moved with
  `GoalStack.promoteToLongterm`; an existing goal gets `GoalStack.setMandate` and
  `GoalStack.setWake` and is moved the same way, keeping its IRI. Afterwards the
  goal must be readable in the long-term graph, otherwise no wake is scheduled.
- *Scheduling.* The gateway passes `InitiativeService.registerGoalWake`, the same
  call the wake path uses (§5.2), so the job is `initiative-<goalUri>`. If
  scheduling fails the wake stays stored and is picked up by `recoverOnStart`
  at the next gateway start, and the tool says so.
- *Gating.* Owner only: hidden from non-owner senders in tool advertisement
  and refused when executed. Not in `INITIATIVE_ALLOWED_TOOLS`, so the executor
  denies it in an unattended cycle, and the tool also refuses when
  `context.unattended` is set. An unattended cycle can therefore never arm a
  goal for itself.
- *Output.* What was armed, the next wake time, the recurring interval if any,
  and, when `flagInitiative` is off, a reminder that the wake will not fire until
  `/initiative on` (and that a wake falling due while the flag is off is
  consumed, §10).
- *Prompt.* The system prompt tells the agent to use it only when the owner
  explicitly asks for work later or regularly.

**`update_goal_step`** (tool, writes the goal's progress only). The initiative
envelope asks the agent to update its goal's status and next step; this is the
tool that does it. Code: `packages/tools/src/cognitive/update_goal_step.ts` (the
tool) and `packages/agent-runtime/src/cognitive/updateGoalStep.ts` (the writes).

- *Input.* `goal` (label or IRI; optional in an initiative cycle, where it
  defaults to the cycle's goal) and any of `currentStep`, `stepProgress` (such
  as `3/8`), `plannedSteps` and `status`. `status` may be `active`, `blocked`
  (needs `blockedReason`) or `resolved`. At least one field is required.
- *Cannot do.* Change mandate, wake or priority (no such parameter exists and
  the writes use only `GoalStack.setStep`, `setPlannedSteps` and `setStatus`);
  set `abandoned` or `proposed`; reopen a resolved or abandoned goal; touch the
  implicit "Respond to the user" goal. Any refused request writes nothing.
- *Scope.* In an unattended initiative cycle the tool may only touch the goal
  that cycle was woken for: the runtime puts `routingHints.initiativeGoalId` on
  the tool context as `initiativeGoalUri` (only when `unattended` is set), and
  the tool passes it as the only permitted goal. In a conversation with the
  owner any open goal may be updated. For other senders the tool is hidden and
  refuses when executed.
- *Gating.* It is in `INITIATIVE_ALLOWED_TOOLS` (§8) so the executor lets an
  unattended cycle call it; the system prompt lists it under "Your Tools".

**`GET /api/cog/inspect/initiative`** (gateway, bearer token). Returns the
`InitiativeReport` JSON (`enabled`, `counters`, `episodes`, `notifications`)
from `AgentRuntime.initiativeReport`, the same function behind `/initiative`.
Optional query parameters: `agentId`, `limit`. It answers 403 until the debug
panel flag is on (`/cog debug on`) and 503 when the cognitive architecture is
not active. `GET /api/cog/inspect/goals?sessionId=...` returns the goals of a
session plus the long-term graph with `nextAction` and `waitingUntil` added.

**Web panel.** The sidebar button "Cognitive Panel" opens
`apps/web-ui/src/components/CognitivePanel.tsx`, which has tabs Cycles, Goals,
Episodes and Initiative. The Initiative tab shows the flag, the counters, the
recent initiative cycles and the recent notifications. It needs
`/cog debug on`; otherwise the panel shows that the debug panel is disabled.

**Demo.** [demo-initiative.md](demo-initiative.md) walks through the whole
chain on a local install with supported steps only.

**Other traces.** Every skip and cycle is an `initiative` episode; every
notification is a `notification` episode; the tool audit log records denied
tool calls with rule `initiative-restricted-tool`.

## 10. Not implemented / limits

What the code in this repository does not do, stated plainly:

- **No goal receives a mandate or a wake automatically.** The only way from
  normal use is the owner-only `arm_goal` tool (§9), which the agent may call
  only when the owner asks for it in the current message and which needs
  `flagCycleManager` (`/cog cycle on`) and `flagEpisodicMemory`
  (`/cog flag episodicmemory on`). The cycle manager itself still creates goals only for a
  message intent (without wake policy) or the implicit "Respond to the user"
  goal. A wake needs a further `/initiative on` before it fires.
- **An unattended cycle can change only its own goal's progress.** The sole
  goal-writing tool in the allow-list is `update_goal_step` (§9): step,
  progress, plan and status (active, blocked, resolved) of the goal the cycle
  was woken for. It cannot arm a goal (`arm_goal` is refused in unattended
  cycles), change mandate, wake or priority, abandon, or reopen a closed goal.
- **`arm_goal` cannot clear a recurring interval.** Re-arming a recurring goal
  keeps its `every` unless a new one is given.
- **Mandate episodes written before the owner marker are not valid.** A
  `message-received` episode without `cogt:actorIsOwner true` fails
  `isMandateValid`; there is no migration. Goals armed through `arm_goal` always
  carry a marked episode.
- **Mandated goals must be in the long-term goal graph** to be seen by the wake
  path (§5.1).
- **Guard values are not configurable.** The caps, cooldown and transcript cap
  use fixed defaults, and so does the tool-round budget of initiative cycles
  (the constant `INITIATIVE_TOOL_ROUNDS` = 25 in the runtime). The numbers in
  `/initiative` ("caps are defaults") are constants in the runtime, which has no
  reference to the gateway's service.
- **Notifications go to Telegram only.** There is no other outbound channel.
  Without a configured target or an enabled Telegram adapter, notifications are
  suppressed as `no-target` and wait in the digest.
- **`NotificationService` is wired to `notify_owner` regardless of the
  Telegram setting.** `InitiativeService` itself sends nothing.
- **No approval queue** for unattended cycles. The former
  `notifications.approvalMaxPerDay` key was removed because nothing read it.
- **No periodic sweep.** Wakes are timers plus one boot-time recovery scan.
  A wake that fires while the flag is off is consumed and not re-armed; the
  goal keeps its `wakeAt`, so it is only picked up again as an overdue wake at
  the next gateway start. Turning the flag on later does not re-register it.
- **Quiet hours** compare wall-clock `HH:MM`, so the window is one hour
  shorter or longer on a daylight-saving transition day.
- **The `cogt:servesDrive` link is informational.** It affects only the `/goals`
  display.
- **The cycle manager alone is not enough for `arm_goal`.** `/cog cycle on`
  sets only `flagCycleManager`; episodes (and so the `arm_goal` mandate) also
  need `flagEpisodicMemory`. The owner lists and sets every cognitive flag from
  chat with `/cog flags` and `/cog flag <name> on|off`.

## 11. Source map

- Goal model and wake policy: `packages/agent-runtime/src/cognitive/GoalStack.ts`
- Trigger and guards: `packages/agent-runtime/src/cognitive/InitiativeService.ts`
- Initiative mode and episode: `packages/agent-runtime/src/cognitive/CycleManager.ts`
- Flag access: `packages/agent-runtime/src/cognitive/CognitiveConfig.ts`
- Notifications: `packages/agent-runtime/src/cognitive/NotificationService.ts`,
  `packages/tools/src/channel/notify_owner.ts`,
  `apps/gateway/src/services/notificationTarget.ts`
- Tool restriction: `packages/agent-runtime/src/initiativeTools.ts`,
  `packages/agent-runtime/src/executor/ToolExecutor.ts`,
  `packages/core/src/types/tool.ts` (`unattended`)
- Envelope type: `packages/core/src/types/message.ts` (`chatType: 'initiative'`,
  `routingHints.initiativeGoalId`)
- Self-protection of wake jobs: `packages/security/src/SelfProtection.ts`,
  `packages/tools/src/utility/cron.ts`
- Commands, reports, digest: `packages/agent-runtime/src/index.ts`,
  `packages/agent-runtime/src/cognitive/goalSummary.ts`,
  `packages/tools/src/cognitive/list_goals.ts`,
  `packages/tools/src/cognitive/arm_goal.ts`,
  `packages/agent-runtime/src/cognitive/armGoal.ts`,
  `packages/tools/src/cognitive/update_goal_step.ts`,
  `packages/agent-runtime/src/cognitive/updateGoalStep.ts`
- Gateway wiring and inspect routes: `apps/gateway/src/index.ts`,
  `apps/gateway/src/routes/admin.ts`
- Web panel: `apps/web-ui/src/components/CognitivePanel.tsx`
- Config: `packages/config/src/schema.ts` (`notifications`)

## 12. Recorded design decisions

These are decisions the code makes visible; the number is referenced from
source comments.

- **12.1 Default OFF.** `flagInitiative` is never on by default and is not
  enabled by any configuration file. Turning it on is an owner action in chat.
- **12.2 No periodic sweep.** Wakes are one-time timer jobs, plus one scan on
  boot. A recurring tick that polled for due goals was rejected in favor of
  this.
- **12.3 Mandate must be a real inbound utterance.** A goal's `mandatedBy`
  must resolve to a `message-received` episode with a non-self actor and the
  owner marker, so a goal the agent invents for itself cannot grant itself the
  right to wake, and a non-owner sender or the initiative envelope cannot either.

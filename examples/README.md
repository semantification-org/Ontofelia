# Examples — see the knowledge graph work

You installed Ontofelia, the gateway is running on `http://127.0.0.1:18780` — now what?

These recipes each take under two minutes and show one thing a governed RDF/OWL memory
does that a plain chat log or vector store does not:

| Recipe | What it shows |
|--------|---------------|
| [01 — Why do you believe that?](01-why-do-you-believe-that/) | Every fact carries a **claim + evidence chain** back to the exact utterance it was learned from |
| [02 — Contradiction detected](02-contradiction-detected/) | Contradicting a fact **supersedes** the old belief instead of piling contradictions into memory |
| [03 — Career history](03-career-history/) | The ontology decides: `worksAt` **accumulates** (history), `livesIn` **replaces** (single-valued) |

Each recipe is a `README.md` walkthrough plus a runnable `run.sh`.

## Prerequisites

### 1. A running gateway

```bash
ontofelia gateway start        # or: bash install.sh did this for you already
curl -s http://127.0.0.1:18780/api/health
```

### 2. You need a real LLM provider

**This is the one thing that will trip you up.** Fact extraction ("semantic
ingestion") parses your chat messages *with the LLM*. If the gateway is running
with the built-in `mock` provider — which is what `ontofelia onboard
--non-interactive` configures, e.g. when `install.sh` ran without a terminal —
**no facts will ever reach the knowledge graph**. The recipes check for this
and refuse to run rather than show you fake output.

Pick one:

- **OpenRouter** (has free-tier models): edit `~/.ontofelia/ontofelia.json5`
  and set

  ```json5
  provider: {
    name: "openrouter",
    apiKey: "sk-or-v1-...",
    defaultModel: "deepseek/deepseek-v4-flash:free",
  }
  ```

- **ChatGPT Plus/Pro account** (OAuth, no API key):

  ```bash
  ontofelia auth login
  ```

  then set `provider.name` accordingly in the config (the wizard/`ontofelia model`
  can do this for you).

Restart the gateway after changing the config: `ontofelia gateway restart`.

### 3. Tools on your machine

`bash`, `curl`, `python3` (used only for JSON handling — no packages needed).

## How the scripts connect

Every `run.sh` reads:

- `ONTOFELIA_URL` — gateway base URL, default `http://127.0.0.1:18780`
- `ONTOFELIA_TOKEN` — gateway API token; if unset, it is read from
  `~/.ontofelia/ontofelia.json5` (`gateway.token`)

```bash
cd examples/01-why-do-you-believe-that
./run.sh
```

## What the recipes touch (and don't)

The scripts only do two kinds of things:

- `POST /api/chat` — send a chat message to the agent (same as typing in the Web UI)
- `GET /api/knowledge/graphs` / `GET /api/reasoning/conflicts` — *read* the knowledge graph

They never delete or modify anything directly. The facts they teach are about
clearly fictional people (Ada Marlowe, Ben Okafor, Carla Reyes), so they won't
collide with your real knowledge — but they *do* persist in your agent's
memory afterwards, like anything else you tell it. You can ask the agent to
forget them ("Please retract everything you know about Ada Marlowe").

## Honesty note on expected output

Agent replies and extracted triples are **LLM-dependent — your output will
vary**. The sample outputs in the walkthroughs are real transcripts from one
run, not guaranteed renderings. Occasionally a model phrases a fact so that
the parser picks a different predicate name or misses a fact entirely; if a
step shows nothing, rephrase slightly and try again (that is honest reality,
not a demo trick). The *mechanics* — claims, evidence, supersession — are
deterministic once a fact is extracted.

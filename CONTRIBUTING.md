# Contributing to Ontofelia

Thank you for your interest in contributing to Ontofelia! This document provides guidelines and instructions for contributing.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Development Workflow](#development-workflow)
- [Project Structure](#project-structure)
- [Coding Standards](#coding-standards)
- [Writing Tests](#writing-tests)
- [Commit Messages](#commit-messages)
- [Pull Request Process](#pull-request-process)
- [Architecture Decisions](#architecture-decisions)
- [Documentation](#documentation)

## Code of Conduct

This project adheres to a code of conduct adapted from the [Contributor Covenant](https://www.contributor-covenant.org/). By participating, you are expected to uphold this standard. Please report unacceptable behavior to the project maintainers.

## Getting Started

### Prerequisites

- **Node.js 20+** (LTS) — we use native ESM, top-level await, and built-in `fetch`
- **pnpm 9+** — our workspace manager (`npm install -g pnpm`)
- **C/C++ toolchain + Python 3** — native modules (`better-sqlite3`) compile from source when no prebuilt binary matches your Node version. On Debian/Ubuntu: `sudo apt-get install build-essential python3`. On macOS: Xcode Command Line Tools (`xcode-select --install`).
- **Docker** (optional) — for sandboxed tool execution

### Initial Setup

```bash
# Clone and install
git clone https://github.com/ORG/ontofelia.git
cd Ontofelia
pnpm install

# Build everything
pnpm build

# Run all tests
pnpm test

# Lint
pnpm lint
```

### Running Locally

```bash
# Run the onboarding wizard (generates config + gateway token)
ontofelia onboard

# Start the gateway
ontofelia gateway
```

Open http://127.0.0.1:18780 for the Web UI.

### Runtime Smoke Test

The smoke test proves runtime stability and the North-Star reasoning path
without requiring any LLM key. It exercises the Oxigraph triplestore + Reasonable
OWL 2 RL reasoner, SPARQL queries, provenance/claim chains, gateway boot, and
graceful error handling.

```bash
# Build first (smoke test uses compiled dist/)
pnpm build

# Run the smoke test
pnpm smoke
```

The `smoke` script runs `node smoke/runtime-smoke.mjs` and covers:

1. **Reasoning rules** — transitive (`locatedIn`, `partOf`), symmetric (`knows`),
   `rdfs:subPropertyOf` propagation (`memberOf → relatedTo`), all via the Rust
   `@ontofelia/reasoner` (Reasonable crate, OWL 2 RL forward-chaining).
2. **SPARQL retrieval** — queries the Oxigraph store for both stored and inferred triples.
3. **Provenance chain** — verifies that every asserted fact produces a `core:Claim`
   with `sourceKind`, `confidence`, `status`, and linked `core:Evidence` with
   `rawText` and `evidenceType` ("why do I believe this?").
4. **Gateway boot + health** — in an isolated `HOME` (never touches `~/.ontofelia`),
   runs `onboard --non-interactive`, starts the gateway, and verifies
   `GET /api/health` returns HTTP 200.
5. **Graceful no-token error** — starts the gateway with an empty token and asserts
   it exits with a clear "token is required" message, not a raw stacktrace.

Exit code 0 = all pass, 1 = one or more failures.

## Development Workflow

### Branch Naming

- `feature/description` — new features
- `fix/description` — bug fixes
- `refactor/description` — code refactoring
- `docs/description` — documentation only
- `test/description` — test additions or fixes

### Working on a Single Package

```bash
# Build only the package you're working on
pnpm --filter @ontofelia/agent-runtime build

# Run tests for a specific package
pnpm --filter @ontofelia/tools test

# Type-check without emitting
pnpm --filter @ontofelia/core build
```

Turborepo intelligently caches builds. If dependencies haven't changed, subsequent builds are instant.

### Making Changes

1. Create a feature branch from `main`
2. Make your changes in the relevant packages
3. Add or update tests
4. Run the full check:
   ```bash
   pnpm build && pnpm test && pnpm lint
   ```
5. Commit using [conventional commit messages](#commit-messages)
6. Push and open a Pull Request

## Project Structure

Understanding the project layout is essential for effective contributions:

```
ontofelia/
├── apps/                    # Deployable applications
│   ├── cli/                 # Command-line interface
│   ├── gateway/             # HTTP/WebSocket server
│   └── web-ui/              # React frontend
├── packages/                # Shared libraries
│   ├── core/                # Type definitions and interfaces
│   ├── config/              # Configuration loading and validation
│   ├── agent-runtime/       # LLM orchestration engine
│   ├── session-store/       # Session persistence
│   ├── semantic-memory/     # RDF/SPARQL/OWL integration
│   ├── providers/           # LLM provider adapters
│   ├── tools/               # Tool registry and built-in tools
│   ├── security/            # Policy engine, RBAC
│   ├── channels/            # Communication channel adapters
│   ├── skills/              # Skill system
│   ├── plugins/             # Plugin registry
│   ├── scheduler/           # Cron and webhook handling
│   ├── sandbox/             # Docker-based isolation
│   ├── media/               # File handling, thumbnails
│   ├── nodes/               # IoT/device node protocol
│   └── testkit/             # Test utilities and mocks
└── docs/                    # Documentation
```

### Package Dependencies

Dependencies flow **downward** — `core` has no internal dependencies, `agent-runtime` depends on `core`, `gateway` depends on everything. Never create circular dependencies.

```
core → config → agent-runtime → gateway
  ↓               ↓
tools           session-store
security        semantic-memory
channels        providers
```

## Coding Standards

### TypeScript

- **Strict mode** is enabled everywhere (`"strict": true`)
- Use `type` imports for type-only values: `import type { Foo } from './foo.js'`
- Use `.js` extensions in import paths (ESM requirement)
- Prefer `interface` over `type` for object shapes
- Avoid `any` — use `unknown` and type narrowing instead
- All exported functions must have JSDoc comments

### Style

- **Prettier** handles formatting — don't fight it
- **ESLint 9** (flat config) catches errors
- 2-space indentation
- Single quotes for strings
- No semicolons (Prettier default)
- Trailing commas

### File Organization

```typescript
// 1. External imports
import * as fs from 'fs/promises';
import { FastifyInstance } from 'fastify';

// 2. Internal imports (with .js extension!)
import { ProviderAdapter } from '@ontofelia/core';
import type { ChatRequest } from '@ontofelia/core';

// 3. Types and interfaces
interface LocalType {
  // ...
}

// 4. Constants
const DEFAULT_TIMEOUT = 30000;

// 5. Implementation
export class MyClass {
  // ...
}
```

### Error Handling

Use the `Result<T>` pattern for operations that can fail predictably:

```typescript
import type { Result } from '@ontofelia/core';

function parseConfig(input: string): Result<Config> {
  try {
    return { ok: true, value: JSON.parse(input) };
  } catch (e) {
    return { ok: false, error: `Invalid JSON: ${(e as Error).message}` };
  }
}
```

Throw exceptions only for programmer errors (bugs), not for expected failures.

## Writing Tests

We use **Vitest** for testing. Every package should have a `__tests__/` directory.

### Test File Naming

- `index.test.ts` — for the main module
- `feature-name.test.ts` — for specific features

### Test Structure

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

describe('ToolRegistry', () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  describe('register()', () => {
    it('should register a tool with a unique name', () => {
      registry.register(mockTool);
      expect(registry.list()).toHaveLength(1);
    });

    it('should throw on duplicate name', () => {
      registry.register(mockTool);
      expect(() => registry.register(mockTool)).toThrow();
    });
  });
});
```

### What to Test

- **Unit tests** for pure logic (parsers, transformers, validators)
- **Integration tests** for adapter boundaries (provider calls, database queries)
- **Do not test** Fastify routes directly — those are covered by E2E tests

### Running Tests

```bash
pnpm test                           # All tests
pnpm --filter @ontofelia/tools test  # Single package
pnpm test -- --reporter=verbose     # Verbose output
```

## Commit Messages

We follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <short summary>

<optional body>

<optional footer>
```

### Types

| Type | Description |
|------|-------------|
| `feat` | A new feature |
| `fix` | A bug fix |
| `docs` | Documentation only |
| `refactor` | Code change that neither fixes a bug nor adds a feature |
| `test` | Adding or correcting tests |
| `chore` | Build process, tooling, dependencies |
| `perf` | Performance improvement |

### Scopes

Use package names as scopes: `core`, `gateway`, `agent-runtime`, `tools`, `web-ui`, `cli`, `semantic-memory`, etc.

### Examples

```
feat(tools): add web_fetch tool for HTTP requests
fix(agent-runtime): prevent infinite tool loop on provider timeout
docs(readme): add deployment section
refactor(providers): extract shared SSE parsing into base class
test(session-store): add transcript pruning tests
```

## Pull Request Process

1. **One concern per PR** — don't mix features and refactors
2. **Tests must pass** — `pnpm build && pnpm test && pnpm lint` must succeed
3. **Update docs** if you change behavior, add features, or modify interfaces
4. **Reference issues** — link the relevant issue in the PR description
5. **Keep PRs reviewable** — aim for < 500 lines of changes

### PR Template

```markdown
## What

Brief description of the change.

## Why

Context and motivation.

## How

Technical approach.

## Testing

How was this tested?

## Checklist

- [ ] Tests added/updated
- [ ] Documentation updated
- [ ] `pnpm build && pnpm test && pnpm lint` passes
- [ ] No breaking changes (or documented in PR)
```

## Architecture Decisions

Significant architectural changes require an **Architecture Decision Record (ADR)** in `docs/adrs/`.

### ADR Format

```markdown
# ADR-NNNN: Title

## Status
Proposed | Accepted | Deprecated | Superseded by ADR-XXXX

## Context
What is the issue that we're seeing that motivates this decision?

## Decision
What is the change that we're proposing?

## Consequences
What becomes easier or harder because of this change?
```

See [existing ADRs](docs/adrs/) for examples.

## Documentation

### Where to Document

| What | Where |
|------|-------|
| Public API changes | JSDoc in source + `docs/api.md` |
| New CLI commands | `docs/cli.md` |
| New config options | `docs/configuration.md` |
| Architecture changes | `docs/architecture.md` + ADR |
| Security considerations | `docs/tools-and-security.md` |
| New adapter interfaces | `docs/interfaces.md` |

### Writing Style

- Write in **English** for code, docs, and commit messages
- Use **active voice** and **present tense**
- Include **code examples** for all public APIs
- Mark experimental features with `> **Experimental:**` blocks

## Getting Help

- **Issues** — for bugs and feature requests
- **Discussions** — for questions and ideas
- **Pull Requests** — for code contributions

Thank you for helping make Ontofelia better! 🦉

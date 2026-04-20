# AGENTS.md

Guidance for Codex and other coding agents working in this repository.

## Purpose

NanoClaw was designed around Claude Code skills, but this fork should be operable with Codex alone. Treat the existing Claude-oriented docs as implementation references, not as hard runtime requirements for maintenance.

Primary goals when working here:

- preserve the host/container security boundary
- avoid leaking secrets into agent-visible context
- prefer small, reviewable code changes over broad automation
- keep local customizations intact unless the user explicitly asks to replace them

## Current Repo Reality

This repository is not a pristine upstream checkout. The current worktree contains local modifications in:

- `src/channels/whatsapp.ts`
- `src/config.ts`
- `src/index.ts`
- `src/webhook.ts`

There is also local environment state such as `.env`, `.env.bak`, `store/`, `data/`, and group directories. Assume these may contain credentials, auth state, or user-specific behavior. Do not print secrets, commit them, or rewrite them casually.

## Architecture Snapshot

- `src/index.ts`: main orchestrator, channel startup, polling loop, scheduling, container invocation
- `src/channels/*`: channel adapters that self-register through `src/channels/registry.ts`
- `src/container-runner.ts`: host-side container spawning, mounts, env passthrough, OneCLI integration
- `container/agent-runner/src/index.ts`: code executed inside the agent container
- `setup/*.ts` and `setup.sh`: modular setup steps
- `groups/*/CLAUDE.md`: per-group memory/instructions for agents running inside containers
- `store/messages.db`: SQLite state

## Safety Rules

1. Do not expose `.env`, `store/auth/*`, database contents, OAuth tokens, API keys, QR payloads, or copied secrets in agent output.
2. Do not add optional credentials during initial setup unless the user explicitly needs that integration now.
3. Do not assume all secrets are protected by OneCLI. In the current code, `GITHUB_TOKEN` and Microsoft Graph credentials are passed into containers if configured.
4. Do not perform destructive git or filesystem actions without a concrete plan and user approval when the action is risky.
5. Before changing setup, container, auth, or mount behavior, read `README.md`, `docs/SPEC.md`, `src/container-runner.ts`, and the relevant `setup/*.ts` steps.
6. Prefer adding documentation and small scripts over inventing a parallel framework.

## Codex Operating Model

Claude skills in this repository map cleanly to Codex playbooks. For Codex, treat each "skill" as a documented workflow with:

- trigger phrase or user intent
- files to inspect first
- commands to run
- constraints
- expected validation

The canonical Codex playbook for setup and maintenance is [docs/CODEX_SETUP.md](docs/CODEX_SETUP.md).

## Proposed Codex Skill Equivalents

These are proposed Codex-native playbooks, not a separate runtime system.

| Claude skill | Proposed Codex equivalent | Scope |
|---|---|---|
| `setup` | `codex:setup` | Safe bootstrap, runtime check, container build, registration, service setup |
| `debug` | `codex:debug` | Logs, container mounts, runtime triage, service status |
| `customize` | `codex:customize` | Small scoped modifications after reading affected files |
| `update-nanoclaw` | `codex:update-upstream` | Safe upstream sync with preview, backup, validation |
| `update-skills` | `codex:update-playbooks` | Refresh docs/playbooks and any mirrored skill assets |
| `migrate-nanoclaw` | `codex:migrate-layout` | Repo/layout migrations with backups |
| `migrate-from-openclaw` | `codex:migrate-openclaw` | Import identity/config from OpenClaw cautiously |
| `init-onecli` | `codex:init-onecli` | Install and verify OneCLI without pasting secrets into chat |
| `use-native-credential-proxy` | `codex:credential-proxy` | Apple-container-specific credential handling |
| `convert-to-apple-container` | `codex:apple-container` | Switch runtime and validate resulting build |
| `claw` | `codex:cli-shortcuts` | Helper CLI/script maintenance |
| `channel-formatting` | `codex:channel-formatting` | Output formatting rules across channels |
| `add-whatsapp` | `codex:add-whatsapp` | Channel addition, auth, registration, tests |
| `add-telegram` | `codex:add-telegram` | Same pattern for Telegram |
| `add-telegram-swarm` | `codex:add-telegram-swarm` | Telegram plus multi-agent orchestration changes |
| `add-slack` | `codex:add-slack` | Slack channel wiring and config |
| `add-discord` | `codex:add-discord` | Discord channel wiring and config |
| `add-gmail` | `codex:add-gmail` | Gmail/email ingestion integration |
| `add-reactions` | `codex:add-reactions` | Reaction support in channel adapters/router |
| `add-image-vision` | `codex:add-image-vision` | Vision/file handling in container runner and prompts |
| `add-pdf-reader` | `codex:add-pdf-reader` | PDF parsing tools or integrations |
| `add-voice-transcription` | `codex:add-transcription` | Audio ingestion and transcript flow |
| `use-local-whisper` | `codex:local-whisper` | Local ASR backend wiring |
| `add-ollama-tool` | `codex:add-ollama` | Local model proxy/tooling |
| `add-parallel` | `codex:parallel-agents` | Explicit concurrency additions |
| `add-compact` | `codex:context-compaction` | Session summarization/compaction tuning |
| `add-macos-statusbar` | `codex:macos-statusbar` | macOS helper app/status integration |
| `add-emacs` | `codex:add-editor-integration` | Editor integration |
| `add-karpathy-llm-wiki` | `codex:add-reference-corpus` | Local knowledge corpus wiring |
| `get-qodo-rules` | `codex:load-external-rules` | Pull org/repo coding rules before edits |
| `qodo-pr-resolver` | `codex:resolve-review-findings` | Review feedback triage and fixes |
| `x-integration` | `codex:x-integration` | X/Twitter automation integration |

### Pattern For Feature Playbooks

For `codex:add-<channel>` or other additive playbooks:

1. inspect `src/types.ts`, `src/channels/registry.ts`, `src/channels/index.ts`, `src/router.ts`, and relevant tests
2. add code in a self-registering module
3. keep credential detection host-side
4. update setup and verification steps only where necessary
5. run targeted tests plus `npm run build`

## Minimal Secret-Safe Setup Policy

Use the shortest path that gets a working install without unnecessarily placing secrets in `.env` or in container-visible environment.

Minimum safe initial setup:

1. Bootstrap dependencies and build tooling.
2. Choose Docker unless there is a specific reason to use Apple Container.
3. Configure Anthropic access through OneCLI if possible.
4. Do not set `GITHUB_TOKEN`, `MS_CLIENT_ID`, `MS_CLIENT_SECRET`, `MS_REFRESH_TOKEN`, or other optional integration secrets during first boot.
5. Add only one messaging channel initially.
6. Verify service health before adding more channels or integrations.

Detailed procedure: [docs/CODEX_SETUP.md](docs/CODEX_SETUP.md)

## Maintenance Workflow

For routine maintenance with Codex:

1. inspect `git status --short`
2. inspect relevant logs or failing tests first
3. make the smallest viable change
4. run targeted validation, then broader validation as needed
5. summarize residual risks, especially around auth, mounts, and secrets

For upstream sync:

1. require a clean worktree or create a backup branch/tag first
2. preview upstream diff before merging
3. resolve conflicts conservatively in `src/config.ts`, `src/index.ts`, `src/webhook.ts`, and channel files
4. run `npm run build` and `npm test`

## Validation Checklist

After setup or infra-sensitive changes, prefer this order:

1. `npm run build`
2. `npm test`
3. `npx tsx setup/index.ts --step environment`
4. `npx tsx setup/index.ts --step container -- --runtime docker`
5. `npx tsx setup/index.ts --step verify`

Do not run registration or auth steps automatically if they require the user to scan a QR code, paste a token, or choose a real chat destination without confirming intent first.

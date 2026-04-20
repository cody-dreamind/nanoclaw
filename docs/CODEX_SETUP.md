# Codex Setup And Maintenance

This document replaces the Claude-skill-centric setup story with a Codex-safe playbook.

## Scope

Goals:

- get NanoClaw running under Codex guidance
- keep initial setup minimal
- avoid pasting secrets into agent chat
- avoid leaking optional credentials into containers

Non-goals:

- enabling every channel on day one
- configuring Microsoft Graph, GitHub automation, or extra integrations during bootstrap
- rewriting upstream setup flow

## Security Boundaries

Read this before entering any secret.

### Safe by default

- `ONECLI_URL` can live in `.env`
- WhatsApp auth state lives on disk under `store/auth/`
- project root is mounted read-only to the main container
- `.env` is shadowed from `/workspace/project/.env` for the main agent

### Not safe to enable casually

In the current code, these values are passed into containers if set:

- `GITHUB_TOKEN`
- `MS_CLIENT_ID`
- `MS_TENANT_ID`
- `MS_CLIENT_SECRET`
- `MS_REFRESH_TOKEN`

That means the minimal safe setup should leave them unset until the user explicitly wants those integrations and accepts the exposure model.

## Recommended Minimal Setup

### 0. Preflight

Run:

```bash
git status --short
git remote -v
node --version
docker --version
```

If the worktree is dirty, do not clean it automatically. Work around local changes or create a backup branch first.

### 1. Bootstrap dependencies

Preferred:

```bash
bash setup.sh
```

Why:

- installs Node dependencies with the repo's expected path
- checks native `better-sqlite3`
- writes logs to `logs/setup.log`

Note:

- `setup.sh` emits a small anonymous PostHog event with platform metadata
- run it before adding secrets to the environment

### 2. Inspect environment

Run:

```bash
npx tsx setup/index.ts --step environment
npx tsx setup/index.ts --step timezone
```

Decide runtime:

- Linux: Docker
- macOS: Docker first, unless Apple Container is a hard requirement

Docker is the safer default for Codex maintenance here because the setup, docs, and tests assume it most often.

### 3. Build and verify the container

Run:

```bash
npx tsx setup/index.ts --step container -- --runtime docker
```

If build fails, inspect `logs/setup.log` before changing code.

### 4. Configure credentials with minimal exposure

Preferred path: OneCLI for Anthropic access.

Safe rules:

- do not paste `sk-ant-*` tokens into Codex chat
- do not commit `.env`
- do not add optional tokens during initial setup

Suggested sequence:

1. Install and verify OneCLI locally.
2. Put only `ONECLI_URL` in `.env` if needed.
3. Add the Anthropic secret through OneCLI UI or local CLI outside agent chat.
4. Verify OneCLI connectivity from the host.

Avoid this in first setup:

```bash
export GITHUB_TOKEN=...
export MS_CLIENT_SECRET=...
```

and avoid appending those values to `.env` unless that integration is being enabled right now.

### 5. Register one channel only

For the first boot, configure one channel end to end. WhatsApp is the path already present in this checkout.

Auth should be interactive and local:

- QR scan or pairing flow is acceptable
- the agent should never ask the user to paste raw tokens into chat if an out-of-band setup path exists

After auth, run only the minimum registration step needed for the selected chat.

### 6. Start service and verify

Run:

```bash
npx tsx setup/index.ts --step service
npx tsx setup/index.ts --step verify
```

Success criteria:

- service is running
- container runtime is available
- credentials are configured
- at least one channel is authenticated/configured
- at least one group is registered

## Codex Playbooks

These are the practical equivalents of the existing Claude skills.

### `codex:setup`

Use when:

- first install
- rebuilding a broken local environment
- adding the first working channel

Inspect first:

- `README.md`
- `docs/SPEC.md`
- `setup.sh`
- `setup/environment.ts`
- `setup/container.ts`
- `setup/register.ts`
- `setup/service.ts`
- `setup/verify.ts`

Rules:

- prefer direct setup steps over broad improvisation
- stop before any step that requires a real user choice or credential entry
- never print secret values back

### `codex:debug`

Inspect:

- `logs/setup.log`
- `logs/nanoclaw.log`
- `logs/nanoclaw.error.log`
- `groups/*/logs/container-*.log`
- `src/container-runner.ts`
- `container/agent-runner/src/index.ts`

Questions to answer:

- is the runtime available
- is the service loaded
- is auth present
- are mounts correct
- are credentials intentionally absent or unintentionally unreachable

### `codex:update-upstream`

Safe sequence:

1. require clean worktree or create a backup branch/tag
2. fetch upstream
3. preview changed files
4. merge conservatively
5. validate with build and tests

Hot conflict zones in this repo:

- `src/config.ts`
- `src/index.ts`
- `src/webhook.ts`
- `src/channels/whatsapp.ts`

### `codex:customize`

Use for:

- trigger/name changes
- prompt/memory changes
- one new integration
- one new channel

Rules:

- keep changes scoped
- preserve self-registration channel pattern
- update tests where behavior changes

## Proposed Mapping From Existing Claude Skills

### Operational

- `/setup` -> `codex:setup`
- `/debug` -> `codex:debug`
- `/customize` -> `codex:customize`
- `/update-nanoclaw` -> `codex:update-upstream`
- `/update-skills` -> `codex:update-playbooks`
- `/init-onecli` -> `codex:init-onecli`

### Channel and feature additions

- `/add-whatsapp` -> `codex:add-whatsapp`
- `/add-telegram` -> `codex:add-telegram`
- `/add-telegram-swarm` -> `codex:add-telegram-swarm`
- `/add-slack` -> `codex:add-slack`
- `/add-discord` -> `codex:add-discord`
- `/add-gmail` -> `codex:add-gmail`
- `/add-reactions` -> `codex:add-reactions`
- `/channel-formatting` -> `codex:channel-formatting`

### Infra and platform

- `/convert-to-apple-container` -> `codex:apple-container`
- `/use-native-credential-proxy` -> `codex:credential-proxy`
- `/migrate-from-openclaw` -> `codex:migrate-openclaw`
- `/migrate-nanoclaw` -> `codex:migrate-layout`

### Optional tooling

- `/add-ollama-tool` -> `codex:add-ollama`
- `/add-image-vision` -> `codex:add-image-vision`
- `/add-pdf-reader` -> `codex:add-pdf-reader`
- `/add-voice-transcription` -> `codex:add-transcription`
- `/use-local-whisper` -> `codex:local-whisper`
- `/add-parallel` -> `codex:parallel-agents`
- `/add-compact` -> `codex:context-compaction`
- `/add-macos-statusbar` -> `codex:macos-statusbar`
- `/add-emacs` -> `codex:add-editor-integration`
- `/x-integration` -> `codex:x-integration`
- `/add-karpathy-llm-wiki` -> `codex:add-reference-corpus`
- `/qodo-pr-resolver` -> `codex:resolve-review-findings`
- `/get-qodo-rules` -> `codex:load-external-rules`

## What Not To Automate Blindly

Do not do these without explicit confirmation:

- delete `store/auth/`
- replace `.env`
- rewrite `groups/*/CLAUDE.md`
- rotate auth credentials
- add optional secrets
- merge upstream into a dirty worktree
- switch runtimes on an existing working install

## Maintenance Baseline

For normal upkeep under Codex:

```bash
git status --short
npm run build
npm test
npx tsx setup/index.ts --step verify
```

If something fails, inspect logs before changing code. Prefer diagnosis from concrete runtime evidence over speculative edits.

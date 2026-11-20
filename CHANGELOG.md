# Changelog

## [Unreleased]

### Merged from upstream (v1.7.4 – v1.7.10, 32 commits)

The fork's 3ai patches and the upstream `zylos-hxa-connect` line were developed
in parallel after v1.7.3: upstream released 1.7.4 – 1.7.10, the fork released
1.7.11 – 1.7.14-3ai. This entry records how the two were reconciled.

Most of the conflict surface was one architectural difference. Upstream routes
every inbound message into a durable, idempotent C4 pipeline: a disk-backed
spool (`c4-delivery-queue`), authoritative periodic DM-inbox reconciliation
(`dm-inbox-reconciler`), a signed DM-policy rejection notifier
(`dm-policy-rejection`), and stable C4 request identities so a replay cannot
open a second turn. The fork answers the same "we lost a message" problem from
the other side, by watermarking and replaying the hub event log
(`catchup`, `catchup-state`, `delivery`).

Both were kept. The fork's catch-up path stays the replay authority, and every
delivery it makes — live or replayed — now goes through upstream's durable C4
queue instead of the old in-process `execFile` + retry. Practically:

- `sendToC4Awaited()` (the fork's "the watermark may only move once C4
  accepted it" primitive) is now a thin awaited wrapper over
  `c4Queue.enqueue()`. It still throws on failure, so a replay stays queued;
  the queue adds restart safety and de-duplication on top.
- DM policy is decided once, by upstream's `createDmPolicyGate` (which also
  sends the signed rejection notice). The fork's `decideDmDelivery()` keeps the
  self-echo and rate-limit decisions and takes the policy answer from the
  gate's verdict, so live and replayed DMs cannot diverge.
- Realtime DMs are observed by `DmInboxReconciler.observeLive()` and reconciled
  by its periodic `inbox()` poll; the catch-up runner still covers gaps that
  span a restart. Message ids are de-duplicated by the catch-up state store and
  again by the inbox state store, so neither path delivers a message twice.
- Threads keep the fork's single `deliverThread()` pipeline (catch-up and
  realtime share it) and only take upstream's C4 identity + durable spool.

### Upstream-only additions taken as-is
- Org-scoped `profile-verify` CLI command (#7, 1.7.7) that binds identity
  evidence to the configured org id/name and the exact runtime hostname.
- `RunFailed` terminal events are acknowledged locally instead of being
  delivered to peers as chat (#3, 1.7.6).
- Silent assistant responses stay side-effect free on every outbound route
  (#14, 1.7.8).
- `HXA_FINAL_DELIVERY_MODE` defaults to `off` (1.7.10): terminal auto-delivery
  is off unless a host opts into `canonical` or `legacy`.
- `ZYLOS_DIR`-aware runtime paths (`config-path`), also adopted by
  `ecosystem.config.cjs` and the install/upgrade hooks.
- `undici` `^7.29.0`, `ws` `^8.21.3` (1.7.4 security update).

### Fork patches preserved
- `fix(send)`: opt-in outbound org guard for non-internal orgs (#41) —
  including the env-file confirmation rule and the NUL-truncated env-key fix.
- `fix(log)`: credential redaction (#44/#45) — extended to every error log the
  merge brought in.
- Catch-up on reconnect (#38) and its `catchup-state` / `catchup-pull` CLI.

### Not merged
- PR #42 (`fix/thread-mention-by-id`: count a hub mention by `bot_id`, not only
  by `@agent_name` text) is a separate open fork PR and is **not** part of this
  merge. Upstream 1.7.4 – 1.7.10 does not change the thread mention check, so
  the fork's `mentionRe` / `extractText()` behaviour is unchanged here and the
  patch still applies on top of this branch. Merging #42 here would mix two
  unrelated reviews; it should land on `main` on its own.

## [1.7.14-3ai] - 2026-11-20

### Fixed
- **Credentials are redacted from error logs** — `agent_token`, registration
  tickets and `Authorization` header values can appear inside network error
  messages (URLs, request bodies). Every top-level error log in
  `scripts/send.js` and `src/bot.js` now passes the text through
  `redactSecrets()` (`src/lib/redact.js`), so a failing send or a dropped
  connection cannot write a live credential into the PM2 log.

  This carries the pi-runtime lab patch `0a133b7` into main. Hosts running
  v1.7.14-3ai keep the redaction that the lab builds had; hosts upgrading
  straight from upstream v1.7.11 gain it.

  Coverage: the send failure path (`Error sending to <target>`), the client
  `error` event, and connection-attempt failures. Handler-level logs already
  print fixed wording without error text.

## [1.7.12-3ai]

### Added
- **Outbound org guard (opt-in)** — `scripts/send.js` refuses to send when the
  resolved org label is not listed in
  `~/zylos/components/hxa-connect/outbound-guard.json`
  (`{ "internal_labels": ["org-1", "org-2"] }`). A blocked send prints the
  target and the org label to stderr and exits 1 without connecting to the hub;
  `HXA_CONFIRM_ORG=<label>` lets that one label through and prints one
  `CONFIRMED EXTERNAL` line. Internal labels print nothing new.
- **Off by default** — no guard file means no guard: every send behaves exactly
  as in v1.7.11, so upgrading a host that has not opted in changes nothing.
- **Confirmation must come from the call** — `HXA_CONFIRM_ORG` read from
  `~/zylos/.env` is ignored, and a blocked send says so. A value left in that
  file would approve every send from the host from then on, which is the
  failure the guard exists to prevent.
- A present but unreadable or malformed guard file fails the send instead of
  letting it through.

## [1.7.11] - 2026-11-13

### Added
- **Catch-up on reconnect** — messages sent while the bot was offline (restart,
  dropped socket, hub restart) are now recovered. The component records a
  per-org watermark of the last delivered message, calls `client.catchup()`
  after the first connect and after every reconnect, expands
  `channel_message_summary` / `thread_message_summary` events into real
  messages, and pushes them through the same delivery pipeline as realtime
  traffic (`dmPolicy`, `groupPolicy`, sender allowlist, media download, C4
  formatting, `[补收]` prefix). Message ids are de-duplicated against realtime
  deliveries, so nothing is delivered twice.
- **Nothing is dropped for volume reasons** — when a replay exceeds 50
  messages or the bot was offline longer than 24h, one summary line is sent
  first and the rest is delivered in throttled batches (25 messages, 10s
  apart). A run that hits the per-run cap (1000) keeps its watermark and
  resumes automatically a few seconds later, and again on the next reconnect.
- **State file** — `~/zylos/components/hxa-connect/catchup-state.json`
  (atomic write, mode 0600): watermark, gap flag, last delivered timestamp and
  the last 2000 message ids.
- **CLI** — `catchup-state` prints the local watermark/gap flag; `catchup-pull`
  prints everything missed since the watermark as JSON (`--limit N`), read-only
  and without touching the running bot's state.

## [1.7.10] - 2026-09-04

### Changed
- Assistant terminal auto-delivery is now disabled by default
  (`HXA_FINAL_DELIVERY_MODE=off`): the stream adapter consumes terminal
  events, exits successfully so core records the request state, and never
  initializes a Hub transport — outbound assistant replies must go through
  explicit `c4-send --request-id`. Set the mode to `canonical` or `legacy`
  to restore automatic delivery.
- Skip the startup delivery-staleness self-check while auto-delivery is
  disabled, since a quiet delivery ledger is expected in that mode.

## [1.7.9] - 2026-09-02

### Added
- Add a terminal-only final delivery adapter for assistant terminal events.
- Preserve explicit `silent` and `[SKIP]` compatibility across delivery paths.

### Fixed
- Enforce an empty/invisible output boundary so non-deliverable responses do
  not create outbound side effects.
- Persist durable delivery identity, fence stale owners, and reconcile
  ambiguous delivery outcomes safely.
- Return actionable DM policy rejection feedback and harden recovery after
  lock-owner death.

### Verification
- Converge main CI, `npm test`, and high-severity `npm audit` coverage for the
  release path.

## [1.7.8] - 2026-08-30

### Fixed
- Keep exact silent assistant responses side-effect free across every outbound
  route, without transport or response-log writes.

## [1.7.7] - 2026-08-29

### Added
- Add an org-scoped `profile-verify` command that binds release identity
  evidence to the explicit org label and configured org ID/Agent name, plus
  the expected profile ID, exact runtime hostname, and observation time. The
  verification path is read-only and never merges, replaces, or migrates
  profiles from any other org.

### Fixed
- Serialize overlapping C4 spool drain scans so one durable delivery cannot be
  invoked multiple times when enqueue and drain scheduling race under load.

## [1.7.6] - 2026-08-28

### Fixed
- `RunFailed` assistant terminal events are now acknowledged and reported
  locally instead of being delivered to peers as ordinary chat messages. This
  prevents stale-run placeholders from consuming peer turns or creating
  bot-to-bot reply storms while preserving the failure code and retryability
  for local diagnostics (#3).

## [1.7.5] - 2026-08-27

### Added
- A native C4 assistant response-stream adapter for HXA DMs and threads. Runtime
  terminal events now produce the actual Hub reply instead of closing the
  assistant request without an outbound message.
- A persistent terminal-delivery ledger. Core replays are idempotent, and an
  ambiguous Hub transport result is reconciled against the authoritative inbox
  or thread before any resend.

### Fixed
- DM response routes now retain the triggering Hub message ID, allowing
  ambiguous delivery reconciliation to prove the exact direct channel instead
  of matching only on bot name and text.

## [1.7.4] - 2026-08-27

### Added
- Periodic authoritative DM inbox reconciliation with a persistent checkpoint,
  overlap window, and message-ID deduplication. A DM missed by an otherwise
  healthy WebSocket is recovered without waiting for a reconnect.
- A bounded disk-backed C4 delivery spool. Accepted Hub events survive PM2
  restarts and C4 outages, and retry with backoff instead of being dropped at
  the old subprocess concurrency cap.

### Fixed
- DM rate-limit pressure now defers intake to inbox reconciliation instead of
  permanently dropping the message. Every self, policy, size, and rate-limit
  decision includes the Hub message ID and source in logs.
- On compatible Core versions, HXA message IDs derive stable assistant request
  and source IDs so overlap polls and crash replays cannot create a second turn.

### Security
- Update `undici` to `^7.29.0` and `ws` to `^8.21.3`; production dependency
  audit reports zero known vulnerabilities.

## [1.7.3] - 2026-05-18

### Fixed
- Post-upgrade hook now backs up `config.json` to
  `config.json.backup.<ISO-timestamp>` before mutation and uses atomic
  write (temp + rename) for the new config (#105)

### Removed
- Reverted in-config `_legacy_*` field injection
  (`_legacy_display_name`) in favor of whole-file backups; the original
  config schema is preserved (#105)

## [1.7.2] - 2026-04-12

### Added
- `peers --name <keyword>` — case-insensitive name filter for peer lookup (#101)
- DM peer-name verification reminder in SKILL.md (#102)

## [1.7.1] - 2026-03-27

### Fixed
- **Undici security update** — bump direct dependency `undici` from `^7.22.0` to `^7.24.6` to pull in fixes for the six advisories affecting `>=7.0.0 <7.24.0`

## [1.7.0] - 2026-03-25

### Changed
- **Thread lifecycle events are now silent context by default** — `thread_updated`, `thread_status_changed`, `thread_artifact`, and `thread_participant` no longer forward directly into C4 as standalone turns
- **SDK-composed lifecycle context** — thread deliveries now read `ThreadContext` lifecycle snapshots and attach them as `<thread-events>` context instead of generating separate replies
- Bump `@coco-xyz/hxa-connect-sdk` from `^1.5.0` to `^1.6.0` — declares the minimum SDK version providing lifecycle snapshots, delivery reasons, and lifecycle formatting helpers used by this release

### Fixed
- **Thread participant noise** — removing or adding a bot to a thread no longer causes every remaining bot to emit a natural-language acknowledgement into the thread
- **Invite compatibility** — `thread_created` still triggers prompt delivery through SDK `ThreadContext` invite semantics instead of requiring a separate direct lifecycle bridge

## [1.6.0] - 2026-03-19

### Added
- **`search-threads` CLI command** — `node cli.js search-threads "query"` with `--status`, `--limit`, `--cursor` options. Client-side limit validation (1–50). Outputs JSON results (#88)
- **Bot join event handling** — Listens for `bot_join_request` and `bot_status_changed` WebSocket events, formats and forwards to C4 admin endpoint (#89)
- **Structured admin tags** — `[priority:high] [action:notify-owner]` tags on bot join request messages for programmatic agent matching (#90)

### Changed
- Bump `@coco-xyz/hxa-connect-sdk` from `^1.4.0` to `^1.5.0` — declares minimum SDK version providing `searchThreads()` and bot join event types (#93)

## [1.5.0] - 2026-03-16

### Added
- **Media auto-download**: Automatically download Hub media attachments (image/file parts) to local filesystem before C4 dispatch — bots now receive local file paths instead of opaque Hub file IDs (#82)
- **`download-file` CLI command**: Proactive media retrieval via `node cli.js download-file <file_id>` with `--out`, `--max-bytes`, `--timeout` options. For on-demand downloads outside the automatic runtime path (#84, #85)
- **Non-text message part forwarding**: Image, file, and link message parts are now forwarded to C4 instead of being silently dropped (#77, #78)

### Fixed
- **@all mention recognition**: `@all` / `mention_all` now correctly triggers thread message delivery (#80)
- **Input guards and MIME defaults**: Harden input validation, add fallback MIME type, and forward reply attachments correctly (#79)
- **SDK download options**: Explicit options for SDK `downloadFile()`, async filesystem ops, tighter regex validation, sync lock file handling
- **Truncation counter**: Only counts attachment-producing parts, not all non-text parts

### Changed
- Requires `@coco-xyz/hxa-connect-sdk` `^1.4.0` for `downloadFile()` / `downloadToPath()` APIs
- Media download uses SDK methods with opaque file ID handling (no URL construction)

## [1.4.8] - 2026-03-12

### Changed
- **Config migration Phase 5**: Org-level `threadMode` migrated to per-thread `mode` field on all configured threads, then removed. Threads without explicit mode are backfilled with the org-level value or `'mention'` default.
- **Org-level `threadMode` removed**: `getThreadMode()` no longer falls back to org-level `threadMode`. All threads must have explicit `mode` field (set by migration or admin CLI). New/unconfigured threads default to `mention`.
- **SKILL.md**: Added upgrade notice — must use `zylos upgrade hxa-connect`, not manual git pull

## [1.4.7] - 2026-03-12

### Added
- **Per-thread mode**: Thread-level `mode` setting (`mention` or `smart`) with three-tier fallback: per-thread → org-level threadMode (deprecated) → `mention` default
- **[SKIP] outbound filter**: Messages starting with `[SKIP]` are suppressed in thread sends only — DMs unaffected
- Config migration: org-level `threadMode` preserved as deprecated fallback for backward compatibility

### Changed
- Rate-limit check moved after mention-mode early return — non-@mention messages no longer consume token bucket

## [1.4.6] - 2026-03-09

### Changed
- Bump `@coco-xyz/hxa-connect-sdk` from `^1.3.0` to `^1.3.1` (fix: @all / @所有人 now triggers delivery for all bots via mention_all field)

## [1.4.5] - 2026-03-07

### Added
- **Per-sender rate limiting (M-04)**: Token bucket algorithm — 10 burst capacity, 5 tokens refilled per 10s. Applied to both DM and thread mention handlers. Excess messages are dropped with a warning log.
- **C4 concurrency cap (M-07)**: Maximum 10 concurrent `execFile` calls to C4. Both initial send and retry paths enforce the cap. Excess calls are dropped with a warning log.

### Changed
- **Docs**: Emphasize @mention requirement for thread messages — without `@bot_name` in the message body, the target bot will not receive the message

### Security
- Closes #63 — rate limiting + concurrency cap prevent message flooding and subprocess exhaustion

## [1.4.4] - 2026-03-05

### Changed
- Bump `@coco-xyz/hxa-connect-sdk` from `^1.2.0` to `^1.3.0` (reply-to support)

### Supersedes
- v1.4.3 (released with old SDK dep — use v1.4.4 instead)

## [1.4.3] - 2026-03-05 (superseded by v1.4.4)

### Added
- **Reply-to send support**: Outbound thread messages automatically include `reply_to` when the trigger message ID is available (mirrors Telegram's msg: pattern)
- **Mention and reply-to documentation** in SKILL.md — usage examples for @bot-name, @all, and `<replying-to>` tag format

### Fixed
- **Reply-to tag injection hardening**: Sanitize reply content to prevent `</replying-to>` tag breakage (including whitespace variants)
- **Fallback log accuracy**: Success log now correctly reflects whether reply_to was actually used or fell back to plain send

## [1.4.2] - 2026-03-04

### Fixed
- Bump `@coco-xyz/hxa-connect-sdk` minimum version from `^1.1.1` to `^1.2.0` — v1.4.0+ depends on SDK v1.2.0 features (session_invalidated event, human provenance bypass in ThreadContext)

## [1.4.1] - 2026-03-04

### Fixed
- Write explicit `dmPolicy`/`groupPolicy` defaults in config during post-install (#48)

## [1.4.0] - 2026-03-04

### Added
- **Per-org enabled flag**: Selectively disable individual orgs without removing config (`enabled: false`)
- **Explicit enabled field migration**: Phase 3 migration auto-adds `enabled: true` to existing orgs missing the field; new orgs default to `enabled: true`
- **SDK session_invalidated handling**: Handles 4002 close code — logs event and exits for PM2 restart
- `ack` added to HANDLED_EVENTS set
- SKILL.md updated with per-org enabled flag documentation

### Changed
- Thread message formatting uses XML tags instead of plain-text markers
- SDK dependency bumped to `^1.2.0` (session_invalidated event support)

### Fixed
- Self-message filter now allows human-authored messages through (was incorrectly blocking)

## [1.3.1] - 2026-03-02

### Changed
- **groupPolicy now gates thread access**: Threads are the group chat primitive; `groupPolicy` enforcement moved from `channel_message` handler to `threadCtx.onMention` callback
- Removed `channel_message` handler — channels are exclusively DMs, group channels no longer exist
- Config key `access.channels` renamed to `access.threads`; admin CLI commands renamed (`list-channels` → `list-threads`, `add-channel` → `add-thread`, etc.)
- SDK dependency bumped to `^1.1.1` (removed `'group'` from `Channel.type`)
- Updated DESIGN.md, SKILL.md, and routing reference docs to reflect thread-only group model

### Fixed
- `groupPolicy` was incorrectly applied to channel messages instead of thread messages

## [1.3.0] - 2026-03-01

### Added
- **Per-org access control**: DM policy (`open`/`allowlist`), channel policy (`open`/`allowlist`/`disabled`), per-channel sender allowlists
- **Thread smart mode**: Per-org `threadMode` setting — `mention` (default, @mention only) or `smart` (all messages delivered, AI decides relevance via `[SKIP]`)
- `src/admin.js` CLI for managing access policies and thread mode
- `src/lib/auth.js` — DM, channel, and sender policy enforcement
- `src/lib/config.js` — shared config loader/saver for admin CLI
- Config migration Phase 2: global access fields auto-migrate to per-org `access` (per-field merge, idempotent)

### Changed
- ThreadContext setup uses `triggerPatterns: [/^/]` for smart mode (SDK-compatible catch-all)
- Mention detection mirrors SDK's `extractText` logic (checks `content` + `parts[].content`)
- DESIGN.md and SKILL.md updated with access control and thread mode documentation

## [1.2.0] - 2026-03-01

### Added
- **Multi-org support**: Connect to multiple HXA-Connect organizations simultaneously
- Config auto-migration from single-org to multi-org format (lossless, with backup)
- `org:<label>|<target>` endpoint encoding for C4 routing (channel stays `hxa-connect`)
- Per-org WebSocket clients with independent reconnect
- `--org <label>` flag for CLI and send.js (debug override)
- Explicit `channel:` endpoint error handling (server API limitation)
- DESIGN.md documenting multi-org architecture and routing decisions
- `hooks/pre-upgrade.js` for upgrade safety checks

### Changed
- `sendToC4` uses `execFile` instead of `exec` (security: no shell injection)
- CLI `VALUE_FLAGS` parsing fixes for `--reusable`/`--stdin` flags
- Failed org connections call `client.disconnect()` before cleanup
- CLI `migrateConfig()`/`resolveOrgs()` errors emit JSON instead of stack traces
- Config migration uses PID-unique temp files to avoid concurrent write races
- SKILL.md config section updated from env vars to file-based config reference
- `Promise.allSettled` for parallel org connections (one failure doesn't block others)

### Fixed
- Max-retry org connection properly disconnects WS client before removal

## [1.1.0] - 2026-03-01

### Added
- `thread-join` CLI command — self-join a thread within the same org
- `bot_renamed` added to HANDLED_EVENTS set

### Changed
- SDK dependency updated to v1.1.0 (v1.2.0 server compat)
- Removed `'open'` from thread status references in CLI help and SKILL.md
- Updated compatibility table for v1.2.0

## [1.0.2] - 2026-02-26

### Fixed
- SKILL.md frontmatter version synced with package.json (was stuck at 0.4.0)

## [1.0.1] - 2026-02-26

### Added
- `scripts/cli.js` — Full SDK CLI with 23 subcommands (queries, thread ops, artifacts, profile, admin). All JSON output.
- SKILL.md updated with complete CLI documentation

### Fixed
- SDK updated to v1.0.1: `agent_online`/`agent_offline` events renamed to `bot_online`/`bot_offline`
- Bot presence event handlers updated to use `msg.bot` field (was `msg.agent`)

## [1.0.0] - 2026-02-26

### Changed
- **Version reset**: Rebrand to HXA-Connect (from BotsHub). Reset version to 1.0.0.
- **SDK dependency pinned**: `hxa-connect-sdk` locked to `v1.0.0` tag (was floating `main`)

### Added (carried from 0.x)
- WebSocket transport with HxaConnectClient SDK
- Auto-reconnect with exponential backoff
- C4 bridge integration for DM, thread, and artifact event forwarding
- Thread message sending via `send.js thread:<id> "message"`
- ThreadContext support with @mention triggers and buffered context delivery
- Bot presence logging (online/offline events)
- HTTPS proxy support for restricted networks
- Post-install/post-upgrade hooks with auto-registration
- PM2 service configuration
- Self-message echo guard

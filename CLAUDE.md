# CLAUDE.md

Development guidelines for zylos-hxa-connect.

## Project Conventions

- **ESM by default** — Use `import`/`export` for application code. PM2's `ecosystem.config.cjs` and its shared `src/lib/config-path.cjs` adapter are the CommonJS compatibility boundary.
- **Node.js 22+** — Minimum runtime version (matches CI matrix; 20 may work but is not covered)
- **Conventional commits** — `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`
- **No `files` in package.json** — Rely on `.gitignore` to exclude unnecessary files
- **Secrets in `.env` only** — Never commit secrets. Use `${ZYLOS_DIR}/.env` when `ZYLOS_DIR` is non-empty, otherwise `~/zylos/.env`; keep non-sensitive runtime config in `config.json`.
- **English for code** — Comments, commit messages, PR descriptions, and documentation in English

## Release Process

When releasing a new version, **all four files** must be updated in the same commit:

1. **`package.json`** — Bump `version` field
2. **`package-lock.json`** — Run `npm install` after bumping package.json to sync the lock file
3. **`SKILL.md`** — Update `version` in YAML frontmatter to match package.json
4. **`CHANGELOG.md`** — Add new version entry following [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) format

Version bump commit message: `chore: bump version to X.Y.Z`

After merge, create a GitHub Release with tag `vX.Y.Z` from the merge commit.

## Architecture

This is a **communication component** for the Zylos agent ecosystem (HXA-Connect bot-to-bot messaging).

- `src/bot.js` — Main entry point (WebSocket connection to HXA-Connect hub)
- `src/admin.js` — Admin CLI (config, access control management)
- `src/env.js` — Environment variable loader
- `src/lib/` — Core library modules
- `scripts/` — C4 outbound message interface and CLI tools
- `hooks/` — Lifecycle hooks (post-install, pre-upgrade, post-upgrade)
- `ecosystem.config.cjs` — PM2 service config (CommonJS required by PM2)

## Runtime upgrades

For an owner request to upgrade this component, follow [UPGRADE.md](UPGRADE.md)
and AGENTS.md. Select only HXA unless the owner explicitly requests the full bundle.

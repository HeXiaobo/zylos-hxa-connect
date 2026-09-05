# Agent instructions

Follow the repository conventions in CLAUDE.md and preserve unrelated work.
Do not bump release versions or deploy during a feature/documentation task.

## Repository-linked upgrades

An explicit request to upgrade this repository selects `--only hxa` in the
shared Core preparation tool. Read UPGRADE.md. Fetching the shared tools does not
authorize upgrading Core or the other communication component. Preserve their
verified installed versions and full SHAs, verify compatibility and unchanged
source/configuration, and use the scoped native updater after the deployment
gate. Only an explicit request for the complete bundle selects `--only all`.
Routine preparation is the Agent's responsibility, not an extra owner approval.

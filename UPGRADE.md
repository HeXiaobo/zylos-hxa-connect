# Upgrade zylos-hxa-connect from one repository link

Ask the resident Agent to upgrade this component to latest or a specific version,
using https://github.com/HeXiaobo/zylos-hxa-connect. No separate ZIP, Markdown attachment,
or owner-written ledger is needed.

## Scope

An upgrade request for this repository means **only hxa**. Keep the other two
components at their verified installed repository/version/full commit SHA.
Do not broaden the upgrade if compatibility fails; report the required companion
version and leave the other components unchanged. An explicit request for all
three components may use the shared all-component workflow.

## Agent entrypoint

Read the [shared Core upgrade procedure](https://github.com/HeXiaobo/zylos-core/blob/main/UPGRADE.md)
and obtain its `tools/upgrade` directory in an isolated checkout of the Core
repository. This fetches operator tools; it does **not** install or upgrade Core.
Record the tool commit and read the nearest AGENTS.md.

Collect the actual host's verified component source baseline into a local
`installed.json` yourself, then prepare with:

```sh
node tools/upgrade/prepare.mjs --only hxa --hxa latest --installed /absolute/installed.json --out /absolute/new/control-directory --authorization-ref OWNER_MESSAGE_ID
```

For a named version, replace latest with that exact version (for example 1.7.10).
The paths and message reference are filled by the Agent, not the owner.
Continue with the generated WORKFLOW.md. Use `command.mjs` to obtain just the
selected component's native update command after the existing deployment gate.
Do not run a full Core/Feishu pair installation for this single-component request.

Verify compatibility with the installed companions, identity, backup, source,
communications and data. Compare the unselected components' source, versions and
configuration before and after. Report the selected component, preserved
components, execution ID and actual result. Installation alone is not acceptance.

An explicit owner upgrade request covers routine preparation, the selected
upgrade, normal service restarts, verification and supported rollback. A link
alone is not authorization. Preserve accounts, runtime provider and business
data. Ask once only for genuinely missing permissions/login, required human test
input or previously unauthorized deletion. Do not invent PASS evidence.

# release-radar plugin changelog

This changelog tracks the plugin version in `.claude-plugin/plugin.json` and the marketplace
entry. The bundled engine has a separate [changelog](CHANGELOG.md).

Entries follow [Keep a Changelog](https://keepachangelog.com/) and appear newest first.
A major release removes or renames a skill or breaks a workflow. A minor release adds a
capability. A patch release fixes existing behavior or documentation.

## [0.1.0] — 2026-11-25

Initial marketplace release. Ships Release Radar engine `0.1.0` for Node.js 20 or later.

### Added

- `deployment-status` reports container images and Git revisions across stages, compares
  targets with Azure DevOps pipeline history and runs configured application checks on request.
- `change-risk` reviews promotion or commit ranges using the workspace and component
  checklists. Settings comparisons identify changed keys and keep values out of the report.
- `promote` previews a team-owned Azure DevOps pipeline action and asks for confirmation
  before queuing it. Handoff stages produce a package for the receiving team.

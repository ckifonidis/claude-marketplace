# Release Radar engine changelog

This changelog tracks the engine version in `engine/VERSION`. The
[plugin changelog](PLUGIN_CHANGELOG.md) records marketplace releases.

## [0.1.0] — 2026-11-25

### Added

- Workspace and component configuration, an index for locating workspaces, deployment
  snapshots and comparisons between release stages.
- Container image and revision reporting for Azure App Service, Azure Container Apps,
  Kubernetes, Docker Compose and configured commands. Application checks can verify HTTP
  responses, running versions and smoke-test results.
- Azure DevOps run history, drift detection and a confirmed pipeline action tied to a
  previewed Git revision and parameter set.
- Settings comparisons by key and handoff packages with source revisions and file hashes.

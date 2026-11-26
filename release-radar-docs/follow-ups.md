# Release Radar follow-ups

## Engine changes in future marketplace releases

Extend the marketplace's `publish-release` skill and its `.agents/` mirror to recognize
`plugins/release-radar/engine/src/`. For a release that changes the engine, check for a
new `engine/VERSION`, a matching entry in the engine changelog and a clean rebuild that
reproduces the shipped `engine/dist/`. The existing vendored-library check looks for a
version under `templates/`.

## Live adapter fixtures

Capture representative output for Azure Container Apps, Kubernetes and Docker Compose
in an environment the operator owns. Remove identifying values before using a capture as
a public fixture. Compare the field paths and absence, authorization and timeout outcomes
with the synthetic cases recorded in the [adapter reference](../plugins/release-radar/skills/deployment-status/references/adapters.md).

## First Azure DevOps sandbox run

Use an operator-owned sandbox pipeline to verify the assumptions about commit pinning,
the echoed repository revision, Build and Pipelines IDs, and approval records. Record the
observed API shapes with synthetic identifiers. The [Azure DevOps research notes](research/azure-devops-pipelines-rest.md)
include the sandbox checks to run before the first live promotion.

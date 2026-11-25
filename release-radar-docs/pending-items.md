# Release Radar release verification

| Check for 0.1.0 | Result |
| --- | --- |
| Install through a fresh Claude Code marketplace configuration | The client validated both manifests, discovered all three skills and ran the bundled engine. |
| Minimum supported Node.js version and development runtime | All 561 offline engine tests passed on Node.js 20.0.0 and 24.14.0. |
| Rebuild and dependency check | TypeScript passed, a clean build reproduced every shipped JavaScript file and npm audit reported zero known vulnerabilities. |
| Public files | A local comparison against private project and deployment identifiers found no matches. The new files also passed checks for personal absolute paths and credential-shaped literals. |

The outstanding field checks are a sanitized capture of the modeled adapter responses and a run against an operator-owned Azure DevOps sandbox. The release process also needs a check for future engine version changes. Each item has a completion condition in the [follow-up record](follow-ups.md).

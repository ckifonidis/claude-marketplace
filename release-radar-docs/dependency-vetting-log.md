# Dependency vetting log — release-radar engine

The engine has **zero runtime dependencies**. Only development tooling is vetted here.

| Date | Package | Pinned | Latest available | Advisory check | Notes |
|---|---|---|---|---|---|
| 2026-11-25 | `typescript` | `^7.0.2` | 7.0.2 (2026-07-08) | `npm audit`: 0 vulnerabilities | compiler only; not shipped |
| 2026-11-25 | `@types/node` | `^20.19.43` | 26.6.10 (20.x line: 20.19.43, 2026-06-10) | `npm audit`: 0 vulnerabilities | pinned to the 20.x line on purpose: the engine supports Node >= 20, so the type checker must reject APIs newer than Node 20 |

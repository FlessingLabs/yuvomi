# FlessingLabs fork: module storage

This branch (`feat/module-storage` of [FlessingLabs/yuvomi](https://github.com/FlessingLabs/yuvomi)) is an **unofficial test build** of Yuvomi. It adds one thing: the module storage described in [MODULES.md, "Module Storage"](../MODULES.md#module-storage) and proposed in [docs/proposals/module-storage.md](proposals/module-storage.md). The Yuvomi maintainer has not agreed to it ([discussion #2452](https://github.com/ulsklyc/yuvomi/discussions/2452)); nothing here is an official Yuvomi release.

## What differs from upstream

| Area | Change |
|---|---|
| Database | Migration 274 creates `module_records` (owned by Yuvomi; only Yuvomi writes it) |
| API | `GET/POST /api/v1/modules/:moduleId/records`, `GET/PUT/DELETE .../records/:recordId`, admin `GET /api/v1/modules/storage` and `DELETE /api/v1/modules/:moduleId/records` (purge) |
| Rights | `server/scopes.js` maps `/modules/<id>/records` to `ext:<id>`; modules that declare only `capabilities.permissions.module` get token scopes too |
| Workflows | `docker-publish.yml` and `umbrel-publish.yml` run only in `ulsklyc/yuvomi`; `fork-test-image.yml` builds, tests and publishes the test image |

Module code still never runs on the server. Module storage holds JSON a module's browser code sends, behind the existing sign-in, permissions, token scopes, CSRF and backup.

## Images

- `ghcr.io/flessinglabs/yuvomi:module-storage-test` - follows the branch
- `ghcr.io/flessinglabs/yuvomi:module-storage-<sha7>` - one fixed build

Never `latest`, never a version number, never under `ulsklyc/yuvomi` or `oikos`. Each image is published only after the container test in `fork-test-image.yml` passed (QuickShop 2 acceptance test, restart, persistence, unprivileged process, healthcheck).

## Going back to the official image

Not by swapping the image. The fork's database carries migrations the official release does not know (272 and 273 from upstream `main` after v2.83.0, plus 274), and the official image refuses to start on it ("written by a newer Yuvomi"). The way back is the copy of the data folder taken **before** switching to this image.

## Maintenance duty when following upstream

Yuvomi records applied migrations one by one (`schema_migrations`) and requires gap-free numbers. Once upstream adds its own migration 274, rebasing this branch must:

1. move the module storage migration behind upstream's last number (it uses `CREATE TABLE IF NOT EXISTS`, so running it again is harmless), and
2. add a repair step for databases that already ran the fork's 274: if `schema_migrations` has version 274 with the description `Persistent household JSON records for third-party modules`, remove that row so upstream's 274 runs, and let the renumbered migration record itself.

Without step 2, upstream's own 274 would be skipped silently on every fork database. Do not publish a rebased image before that step exists and is tested.

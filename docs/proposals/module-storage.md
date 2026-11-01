# Proposal: persistent household storage for third-party modules

Status: implemented on the FlessingLabs fork, branch `feat/module-storage` (migration 274, `server/services/module-records.js`, `server/routes/module-records.js`, documented in MODULES.md under "Module Storage"). Not agreed with the Yuvomi maintainer yet - see discussion #2452.

## Problem

Browser modules can use Yuvomi's existing APIs, but cannot persist their own shared household state. Even a small catalogue currently needs a separate service, database, backup and same-origin routing. FlessingLabs QuickShop is the motivating example: its UI needs to store reusable item names, default purchase quantities and optional reference prices, while adding shopping items through the existing shopping API.

We propose a small core-managed JSON record store. This introduces no shopping catalogue logic into core and does not execute module-supplied server code. Services remain appropriate for background jobs, external integrations and secrets.

## Proposed contract (subject to maintainer feedback)

- GET /api/v1/modules/:moduleId/records: paginated records, in stable ID order.
- POST /api/v1/modules/:moduleId/records: create a record with a server-generated UUID and revision 1.
- GET /api/v1/modules/:moduleId/records/:recordId: read one record.
- PUT /api/v1/modules/:moduleId/records/:recordId: replace its JSON object, supplying the expected revision.
- DELETE /api/v1/modules/:moduleId/records/:recordId: delete, supplying the expected revision.

Each record has id, revision, data, created_at and updated_at. Writes return the new revision. A stale revision returns 409 without changing data; checks and writes run atomically. The frontend must surface conflicts rather than silently retrying stale replacements. JSON objects are opaque to core; field validation belongs to the module.

Initial proposed limits: 16 KiB of UTF-8 serialized data per record, 1,000 records and 4 MiB serialized data per module. Enforce quotas transactionally, including concurrent creation. Listing is paginated (default 100, maximum 200); do not return unlimited module contents.

## Access and lifecycle

- Require an installed, valid, enabled third-party module and an explicit permission-module declaration.
- Reuse authentication, CSRF protection and ext:<moduleId> read/write permissions.
- Check scoped API-token access explicitly for these dynamic paths; the generic /modules prefix must not bypass extension scopes. No token gains access by knowing a module ID.
- Data is household-shared. A module ID defines a namespace, not a sandbox against trusted same-origin module JavaScript acting with the user's permissions.
- Enforce reads and writes on the server. Disabled or absent modules cannot access records.
- Keep records across module updates, disablement and removal. Document retention and provide an explicit admin purge operation or workflow before release; never silently destroy the household's data on uninstall.
- Restrict access for guest/display accounts consistently with existing Yuvomi policies.
- Document that this store is not suitable for secrets.

## Persistence and backup

Add a core-owned table through an append-only migration, keyed by module ID and record ID. Only Yuvomi opens its database. Verify the existing backup/restore implementation includes the new table, add a restore round-trip test, and consider compatibility behavior when restoring into older releases. The runtime writes no files into module folders.

## Implementation and verification plan

1. Agree the scope, namespace, retention behavior and limits with the maintainer.
2. Add the migration and a small storage service with atomic revisions and quotas.
3. Add routes integrated with authentication, extension permissions and token scopes.
4. Test module isolation, unauthorized/readonly access, disabled/uninstalled modules, CSRF, token scopes, guest/display access, limits, concurrent writes, persistence and backup/restore.
5. Document the API in MODULES.md and the official API description, using a small neutral example.
6. Adapt QuickShop separately and provide explicit import of existing quickshop.db data through the APIs; retain its service until migration is verified.

## Why this change

Users installing a small module reasonably expect it to work without deploying another service. A bounded record store would let simple extensions meet that expectation while preserving Yuvomi's authentication, permission and backup model. It avoids reusing shopping lists or pantry stock as unrelated module storage.

Maintainer feedback is still requested; the implementation follows this document so it can be reviewed as a whole.

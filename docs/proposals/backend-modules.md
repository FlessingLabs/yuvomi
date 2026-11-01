# RFC: shared infrastructure for modules with backend needs

Status: discussion draft, 1 November 2026. No runtime, installer change or new API is implemented by this branch. Names, limits and examples below are proposed contracts, not current Yuvomi features. Reference checkout: upstream f7dbd295b9932d12708aa92c648b88ddcff8e384.

[German overview](backend-modules.de.md) · [Ready-to-post discussion](backend-modules-discussion.md)

Upstream discussion: https://github.com/ulsklyc/yuvomi/discussions/2452

## Problem and intended outcome

FlessingLabs QuickShop adds a reusable shopping-item catalogue. Installing its browser module succeeds, but without its separately deployed service the user sees “QuickShop service unreachable”. On a plain Unraid installation, arranging same-origin access adds a container, routing or a port change, and a separate backup. This is disproportionate for a small shared list.

The same setup gap would recur for planned Telegram/Discord integrations and receipt processing with optional AI, but their requirements differ. A JSON store alone does not run bots or process receipts. The goal is reusable infrastructure and an understandable installation experience, without putting provider-specific integrations in core or promising that every workload runs inside one container.

Desired experience: install a module, approve the capabilities it needs, configure credentials if applicable, and use it. Heavy processing may still require optional infrastructure, clearly disclosed before installation. A missing runtime should be explained during setup, not discovered as a generic network error after installation.

## Existing contract and constraints

The current MODULES.md documents browser modules plus separately operated backend services. It requires same-origin /api/extensions/<module-id>/ routing, independent service authorization, and access to core data only through /api/v1. The web installer does not execute archive contents on the server. docs/SCOPE.md deliberately leaves external provider integrations to clients rather than core.

This RFC proposes changes to that contract and asks which parts are acceptable upstream. It does not claim that a backend prefix currently starts or routes a service. It retains the prohibition on direct access to yuvomi.db by extension processes.

## Existing runtime to evaluate before building another

Discussion #746 presents https://github.com/JakeTheRabbit/yuvomi-extensions with a server runtime, Yuvomi client and browser SDK. The maintainer explicitly supports that sidecar model. This RFC does not claim those pieces are missing from the ecosystem: evaluate compatibility, licensing, deployment and security of that implementation before proposing a new runtime. The remaining question is whether a smaller core record API and a simpler supported setup/gateway are acceptable, or whether deployment improvements should live entirely in that external project.

## Capability tiers

| Tier | Example | Infrastructure needed |
| --- | --- | --- |
| Browser only | Alternative view of existing tasks | Existing browser module and REST API |
| Persistent data | QuickShop | Core-managed, bounded household record store |
| Background integration | Telegram/Discord | Optional runtime, protected credentials, scoped core access, health and restart handling |
| File processing | ReceiptScan | Authorized upload storage, durable jobs, worker, result review |
| Optional AI | Receipt extraction | Explicit local/cloud provider selection, credentials, time and spending limits |

QuickShop must not depend on ReceiptScan, AI or an optional worker runtime. ReceiptScan may offer a separate, explicit action to create catalogue items through a public module API; it must not write another module's private records directly.

## Proposed division of responsibility

**Yuvomi core** owns session authentication, permission checks, module discovery, bounded storage, and (if accepted) an authenticated gateway to registered workers. Existing APIs remain the only way extensions mutate core entities. Core need not contain a Telegram client, Discord library, OCR engine, provider SDK or model weights.

**An optional extension runtime** owns long-lived connections and processing. It may be a separately deployed companion serving several extensions, with optional external workers for heavier tasks. One operator setup can support multiple modules; this is an installation target, not a claim that separate processes or dependencies disappear.

**Deployment tooling** provisions workers and their volumes. The browser installer must not acquire a Docker socket or execute downloaded backend code. Any future install-and-start workflow requires its own explicit operator opt-in and backend-code approval, distinct from approving browser assets. Until that exists, show exact runtime prerequisites before enabling backend functionality.

For the FlessingLabs fork, a supervised local runtime packaged alongside Yuvomi is a possible experimental single-container deployment. Child processes give crash separation but are not a security sandbox; a shared Unix user may still read core files or exhaust resources. It must be labeled trusted-code operation, use separate process credentials/filesystem access where feasible, and not be presented as the recommended upstream security boundary. Container-isolated workers remain an alternative. GPU/model runtimes are optional external dependencies, not bundled into Yuvomi.

## Phase 1: bounded household records

Candidate routes under /api/v1/modules/:moduleId/records provide paginated list, create, read, replace and delete. Records carry server-generated IDs, revision and timestamps plus an opaque JSON object. Updates/deletes supply the expected revision; stale writes return 409 atomically. Proposed starting limits: 16 KiB per record, 1,000 records and 4 MiB serialized data per module, list pages of 100 with maximum 200. These values require maintainer agreement and workload tests.

Only an installed, valid, enabled module with a declared permission module can use this storage. Enforce ext:<moduleId> read/write in both session and token paths, including encoded/case-varied paths. Namespace isolation is not a sandbox against trusted same-origin browser modules acting with the member's rights. Guest/display restrictions remain in force.

Yuvomi owns the table and migration. Records survive upgrades, disablement and uninstall; explicit admin data removal is separate. Verify backup/restore round trips, quota release, pagination and competing revisions. JSON storage is for small non-secret data, not uploads, model files or queues. Modules validate their domain data. Add a feature-discovery contract so incompatible hosts can display a useful setup message.

## Phase 2: gateway and registered runtimes

An operator-controlled mapping binds an installed module ID to a fixed internal worker target. A module manifest may describe a required capability/protocol version, but cannot select arbitrary URLs. Validate destinations against SSRF, disallow redirects and enforce connection/body/time limits. Private targets require explicit operator registration. Provider webhook traffic is a separate path and must never fall back to browser session authorization.

The gateway checks the active session and current module permissions before dispatch. Strip incoming authorization/context headers, cookies and hop-by-hop headers; do not pass Yuvomi session cookies to workers. Use authenticated transport and a short-lived, audience-bound context for the registered worker (module ID, user identity, request ID, expiry and relevant scopes). This context is not permission to access another module. The worker validates it and still enforces endpoint-specific ownership and object permissions. Core rechecks authority on any callback that reads or changes core data.

Define delegated user actions separately from service actions. Background jobs use narrowly scoped, revocable service credentials; they cannot inherit an admin browser session. Provider user/chat identities are explicitly paired with a Yuvomi member, never trusted from incoming message text. Disablement blocks new dispatch, stops subscriptions and prevents background credentials from continuing work. Queued commits recheck authorization and module state. Requests already accepted by external providers may not be retractable; show this limitation and use idempotency/outbox records where supported.

The first gateway need not supervise containers or expose a plugin marketplace. Target registration, one common protocol, setup status and a reference worker are enough to prove the boundary.

## Phase 3: secrets, jobs and files

Secrets are server-only and module-scoped. Admin configuration is write-only with configured/not-configured status; never return secret values through record APIs, settings payloads or logs. Choose encrypted storage and a separately provisioned key or supported deployment secret references. Define key loss, rotation, export and restore behavior before shipping. Encryption at rest does not protect against a compromised authorized worker. Do not expose all provider credentials to every extension in a shared runtime.

Jobs are durable records with queued/running/succeeded/failed/cancelled states, bounded retries/backoff, leases/heartbeats and restart recovery. Assume at-least-once execution, not exactly once; use idempotency keys for domain effects. Limit concurrency, CPU/memory/disk use where the deployment supports it, runtime and retained history. Cancellation is cooperative until the worker can be stopped; external effects need separate handling. The browser receives status and bounded progress, not a request held open for an OCR run.

Files use opaque identifiers, authorized downloads, streaming upload and explicit size/type/page limits. Check actual content rather than trusting filenames; defend parsers against decompression/resource exhaustion. Separate temporary uploads, retained originals and derived results. Use Yuvomi's existing document-storage interfaces if an appropriate public contract can be provided; otherwise define a dedicated extension blob store rather than pretending JSON records can hold receipts. Backups must cover file data and metadata consistently, including interrupted jobs and restore behavior. Establish retention and an explicit delete workflow.

## Concrete flows

**QuickShop:** browser reads/writes catalogue records, then adds to the normal shopping list through the existing shopping API. No runtime or external service is needed.

**Telegram/Discord:** an administrator configures the provider secret; the runtime maintains the connection or verifies webhook signatures and replay protection. A paired sender can trigger only actions granted to that Yuvomi member and integration credential. A bot status page reports connection failures. Telegram polling or Discord gateway connections can avoid public inbound ports; webhook deployments need public HTTPS and provider verification. This cannot be promised away by an installer.

**ReceiptScan:** member uploads a receipt, explicitly selects local or cloud processing, then receives job status and a reviewable extraction. Cloud processing requires a visible disclosure of the recipient/provider and what leaves the server. No provider request starts merely because the module was installed. Bound per-job cost/tokens and retries; review extracted quantities and prices before committing. Treat receipt text and model output as untrusted data, not instructions or authorization. ReceiptScan and QuickShop remain independently usable.

## Installation, updates and recovery

Capability discovery distinguishes a missing core API from an unavailable worker or unconfigured credential. Show compatibility and prerequisites before enabling a feature. Browser upgrades retain today's approval rules; changing backend code, requested scopes or providers needs a separate explicit review. Pin executable artifacts by immutable digest, validate provenance according to deployment policy, and document who supplies updates.

Migrations are owned by the component storing the data. Stop/drain work before incompatible changes. Backups include record data, job state and owned files with a clear secret-key recovery policy. An older official image is not automatically a supported rollback after a fork database migration: test restore of a pre-change backup and document the route back. Core module UI and unrelated features must remain usable when a worker is down.

## Delivery and acceptance gates

1. **Agree scope:** maintainer chooses storage-only, storage plus gateway, or documented external runtime only. No assumption of upstream acceptance.
2. **Records:** a narrow core PR with API docs, scope/CSRF tests, real backup/restore, quotas, concurrency, disabled-module behavior and a QuickShop demonstration.
3. **Gateway:** separate PR with fixed-target/SSRF tests, forged-context tests, expiry/audience checks, denied/readonly access, service-credential revocation, health and failure isolation. Keep optional services optional.
4. **Reference runtime:** prove both a restartable bot and a dummy durable file job before claiming a generic runtime. Test resource exhaustion, disablement, retries and idempotent effects.
5. **Receipt processing:** file lifecycle, secret recovery, local/cloud disclosure and cost limits verified before adding a real provider. No AI/OCR library or provider integration goes into core merely to demonstrate the protocol.

This branch publishes the design only. A separate local record-store prototype exists but is not a complete backend platform or production-ready installation. No runnable image, new installer behavior or all-modules compatibility is claimed here.

## Questions for the maintainer

- Would bounded core-managed records fit the module contract, or should all persistence remain external?
- Would an optional fixed-target authenticated gateway fit the existing sidecar direction? Earlier capability work discussed a proxy (#922 / PR #919); what constraints ruled that approach out?
- Should the runtime protocol be maintained in a separate integration project, with only a narrow gateway/API in Yuvomi?
- What lifecycle, backup and approval guarantees would you require before accepting any of these phases?

## References

- MODULES.md, “Modules With A Backend Service” and “Installing From Settings”
- docs/SCOPE.md, “The shape that works: Yuvomi stays the server, the bridge is a client”
- server/services/module-capabilities.js; server/services/modules.js; server/scopes.js
- https://github.com/ulsklyc/yuvomi/discussions/746
- https://github.com/JakeTheRabbit/yuvomi-extensions
- https://github.com/ulsklyc/yuvomi/issues/922
- https://github.com/ulsklyc/yuvomi/pull/919
- https://github.com/FlessingLabs/yuvomi-quickshop

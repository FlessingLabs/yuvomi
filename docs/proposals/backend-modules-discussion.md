# RFC: simpler setup for stateful modules and optional backend integrations

Hello! We are building [FlessingLabs QuickShop](https://github.com/FlessingLabs/yuvomi-quickshop), a reusable item catalogue for the existing shopping list, and planning independent Telegram/Discord and receipt-processing extensions.

We understand and respect the documented direction: browser modules use the public API, external integrations run beside Yuvomi, and extensions never open `yuvomi.db`. We are not asking to add bots, AI providers or a product catalogue to core.

The practical difficulty is installation. A household installs QuickShop from Settings successfully, then sees “QuickShop service unreachable” because a shared catalogue requires a separate service and same-origin routing. On a basic Unraid setup this means extra deployment, routing/port changes and backup configuration. The same infrastructure would be repeated for future extensions.

Would you be open to discussing a staged approach?

1. **Small core-managed record storage** for shared module state, using existing extension permissions, bounded quotas, atomic revision checks and backup/restore support. This would let QuickShop work without a backend service.
2. **An optional authenticated gateway to operator-registered backend services**, so browser modules can use the existing Yuvomi origin without configuring a separate public proxy for each extension. Targets would be fixed by the operator, with SSRF protection, limits and explicit permissions. Workers would not receive Yuvomi session cookies.
3. **A separately maintained optional extension runtime**, rather than provider integrations in core, for long-lived bot connections, server-side secrets and durable receipt-processing jobs. File lifecycle, restart recovery, disablement and scoped service credentials need explicit contracts. This is a longer-term design question, not a request to merge an entire runtime now.

The module installer would continue not to execute arbitrary server code. Backend provisioning/approval is a separate operator decision. Heavy OCR/local AI can remain external; a single-container installation is not assumed for every workload. Existing browser modules and sidecar deployments should keep working.

We prepared a [full architecture draft in our fork](https://github.com/FlessingLabs/yuvomi/blob/proposal/backend-module-platform/docs/proposals/backend-modules.md), with use cases, trust boundaries, deployment alternatives, backup/lifecycle requirements and separate acceptance gates. A [German overview](https://github.com/FlessingLabs/yuvomi/blob/proposal/backend-module-platform/docs/proposals/backend-modules.de.md) is also available. The branch contains documentation only; it does not claim these features already exist or constitute a runnable platform.

Before turning this into implementation PRs, we would appreciate your direction:

- Would a bounded module record store fit Yuvomi, or should all module persistence remain external?
- Is a small gateway compatible with the sidecar approach? We noticed earlier proxy discussion in #922 / PR #919 and would like to understand the constraints before revisiting it.
- Would you prefer the runtime/protocol in a separate project, keeping only narrow APIs in core?

The goal is a maintainable setup that households can understand, not a provider-specific framework that Yuvomi must maintain. We are happy to narrow the scope based on your feedback.

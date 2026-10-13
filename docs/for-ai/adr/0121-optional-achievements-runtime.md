# ADR 0121: Optional achievement rules and presentation

Date: 2026-10-13. M23 P1 implementation; no npm publication.

Expose `@haiyue/extensions/achievements` with two values (`AchievementRuntime`, `AchievementGui`) and eleven types. The root export remains unchanged. Engine has no dependency on this extension, Native, Steam or GameKit.

The application reports plain game facts with durable IDs or authoritative absolute checkpoints. The runtime supports facts, saturating counters and monotonic best values. It writes values and the bounded recent-ID window atomically, then transfers retry ownership through a structurally injected Native v1 port. A receipt represents local/SDK synchronization state, never a reward or cloud consistency proof. Observers and GUI toasts only follow committed local rule transitions.

Each runtime belongs to one explicit game/environment/account profile. Hosts must dispose/recreate or fence the port when that identity changes. Guest progress is never implicitly moved to a platform account. Saves carry schema/version and a rule/target signature; changed semantics require an explicit validated migration. Operations, remembered event IDs and reporting time are bounded; disposal fences late writes/reports and releases GUI/image/i18n subscriptions.

The GPU presenter uses existing GUI and localized image bindings. Hidden names/icons are withheld until local completion; platform and game banners are opt-in display policy. This is not a general expression language, a reward wallet, cross-device additive counting or an anti-cheat authority.

Validation: focused type/runtime tests, example WebGPU verifier, API/boundary checks, and a fresh Native consumer that extracts the actual Engine/extension archives and stages the Native package export/filter without importing sibling source. Native's platform SDK and device acceptance are independent gates.

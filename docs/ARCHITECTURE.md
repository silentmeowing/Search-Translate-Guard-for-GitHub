# Architecture

## Problem model

Full-page translators modify the live DOM rather than only painting translated text. A translator can replace a text node with wrapper elements while an application framework still holds a reference to the original node. Later UI updates can then fail, disappear, or throw `removeChild` and `insertBefore` exceptions.

GitHub's global search is one instance of that wider problem. It is a dynamic `qbsearch-input` custom element with nested dialog and query-builder components. Translation timing can interfere with its initialization or expansion after a reload or Turbo navigation.

GitHub remains the only built-in site adapter. The implementation also supports data-only rules for sites the user explicitly authorizes, without copying GitHub-specific recovery behavior or granting automatic access to every site.

## Generated entry point

The extension and userscript both execute `GitHub-Search-Translate-Guard.user.js` on GitHub. A second committed artifact, `Site-Translate-Guard.content.js`, is dynamically registered only for user-authorized origins. `scripts/build.mjs` assembles them from:

1. `src/core.js` — adapter registration, early scanning, mutation handling, lifecycle events, activation rules, and recovery scheduling.
2. `src/adapters/github.js` — GitHub selectors, health check, repository scope, and fallback dialog.
3. `src/bootstrap.js` — starts the registered adapters.
4. `src/selector-tools.js` — shared selector generation, structural fingerprints, conservative fingerprint matching, and unique-candidate lookup.
5. `src/adapters/site-rules.js` — loads local selectors, protects matching subtrees, conservatively repairs selector drift, accepts live rule updates, and safely restores attributes when rules are cleared.

Run `npm run build` after editing source files. CI runs `npm run build:check` and rejects a stale generated userscript.

## Guard adapter contract

The JSDoc `GuardAdapter` interface in `src/core.js` defines the integration boundary:

- `id` and `matches(url)` identify the adapter and its supported origin.
- `protection.select(root)` returns the smallest stable subtrees that translation must not mutate.
- `beforeAttachEvents` can protect detached replacement content before a framework attaches it.
- `rescanEvents` handles site navigation lifecycle signals.
- Optional `recovery` activation rules schedule a delayed health check and invoke site-owned recovery only when the native component is unusable.

The core applies both:

```html
translate="no" class="notranslate"
```

The standard attribute communicates the boundary to translation tools. The class remains for translators that recognize the established compatibility convention.

## GitHub adapter

The GitHub adapter selects `qbsearch-input` and both React search triggers used by the authenticated redesigned header. Logged-out pages expose the classic `qbsearch-input` trigger directly, while logged-in pages can keep multiple hidden search templates beside separate desktop and compact responsive buttons. A document-wide MutationObserver covers initial parsing and later additions, while `turbo:before-render` protects the detached replacement body before attachment. `turbo:render` and `turbo:load` provide follow-up scans.

Activation of either GitHub header by pointer or `/` schedules one deduplicated check after approximately 550 ms. The adapter checks every `qbsearch-input` instance because GitHub can render hidden templates alongside the live component. Native search is healthy when any instance is expanded and its query input has a visible size. A healthy native search is left untouched.

If the check fails, the adapter creates a local Shadow DOM dialog. It preserves the current `data-scope` value when present and navigates directly to GitHub's `/search?q=...` endpoint on submit.

## User-authorized site rules

The optional site workflow has six extension contexts:

1. `popup/` displays the current origin and asks the user to grant, inspect, or remove protection.
2. `src/background/service-worker.js` validates messages, stores versioned data-only rules, and registers one persistent `document_start` script per authorized origin.
3. `src/risk-detector.js` performs a bounded, user-initiated scan of visible structural interaction signals and returns ranked in-memory candidates.
4. `src/selector-tools.js` gives creation and recovery one implementation for selectors and fingerprints.
5. `src/picker.js` presents suggested candidates or lets the user choose a component boundary manually. It generates a structural selector and a fingerprint containing only tag, role, type, name, and landmark metadata.
6. `Site-Translate-Guard.content.js` reads rules from local extension storage and activates the generic adapter. It observes later DOM additions through the same core.

The browser permission prompt is initiated from the popup. `activeTab` supports the one-time picker, while HTTP and HTTPS origins remain in `optional_host_permissions`. Dynamic content scripts require Chrome/Edge 96 or later.

Rules are keyed by exact origin, even though Chromium match patterns grant a hostname across ports. When a dynamically registered script runs on a different port, the adapter finds no matching exact-origin configuration and performs no protection.

The detector scores custom elements, composite ARIA roles, dialogs and popovers, editable controls, ARIA relationships, and selected framework state attributes. It visits at most 3,000 visible elements per invocation and keeps at most 24 raw candidates. It deliberately excludes visible text and input values, and its scores are never persisted or transmitted.

The picker maps candidates to bounded component roots, deduplicates them, and displays at most 12 ranked suggestions. It favors IDs and stable data attributes, then builds a bounded structural selector from roles, names, types, stable classes, and ancestry. Users can cycle suggestions, move the selected boundary to a parent, or return to manual selection before confirming.

When a confirmed selector stops matching, or matches an element that no longer agrees with its stored fingerprint, the site-rule adapter may repair the binding. Rebinding requires a sufficiently strong fingerprint, exactly one compatible candidate across the complete document, and the same candidate remaining unique for at least 250 ms without intervening DOM additions. A lightweight observer schedules re-evaluation for removals and selector/fingerprint attribute changes. Existing non-empty identity fields must match exactly. Ambiguous, weak, transient, cross-origin, missing-rule, and duplicate-selector updates are rejected. A successful update stores only the new structural selector, compatible fingerprint, and a `reboundAt` timestamp.

```text
Page or framework adds candidate content
        |
        +--> Core asks the active adapter for protection targets
        |        |
        |        +--> mark the smallest stable subtree as not translatable
        |
User activates GitHub search
        |
        +--> native search healthy ------> keep native UI
        |
        +--> native search unhealthy ----> GitHub Shadow DOM fallback

User opens extension on another site
        |
        +--> browser grants current hostname permission
                 |
                 +--> local structural risk scan
                          |
                          +--> user confirms a suggestion or selects manually
                          |
                          +--> local structural rule
                                   |
                                   +--> persistent document_start protection
                                            |
                                            +--> stale selector
                                                    |
                                                    +--> stable unique fingerprint match --> local selector repair
```

## Security and scope

- The manifest statically matches only `https://github.com/*`. `activeTab`, `scripting`, and `storage` support the explicit user workflow; other HTTP and HTTPS hosts remain optional permissions.
- The extension does not patch global DOM prototypes. Silencing invalid `removeChild` or `insertBefore` calls can leave stale or missing UI without repairing application state.
- There is no developer server, analytics endpoint, remote script, or runtime dependency.
- Local extension storage contains only origin-scoped structural rules and rule timestamps, never page text, field values, or ephemeral candidate scores.
- Playwright is a development-only dependency and is not referenced by the extension manifest or generated userscript.

## Limitations

- Future GitHub redesigns may require adapter selector or health-check updates.
- The fallback intentionally provides direct query submission, not native suggestions or saved searches.
- `translate="no"` is a request to translation systems, not a guarantee that every third-party translator will respect the boundary.
- Generic scoring is a best-effort structural heuristic, not proof that every risky component was found. Generic rules prevent translation inside a confirmed boundary; they do not infer business semantics or provide automatic recovery UI.
- Selector rebinding is deliberately conservative; ambiguous or weak rules remain unresolved and require user confirmation through the picker.
- Closed shadow roots and cross-origin frames cannot be selected from the top-level page without separate support and permissions.

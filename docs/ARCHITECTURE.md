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
4. `src/composed-tree.js` — bounded traversal, querying, observation, and parent lookup across light DOM and nested open shadow roots.
5. `src/risk-detector.js` — structural interaction scoring and shared component-boundary selection.
6. `src/mutation-risk-observer.js` — bounded, non-text observation of recent DOM text-wrapper rewrites inside interactive component boundaries.
7. `src/selector-tools.js` — light/deep selector generation, structural fingerprints, conservative fingerprint matching, and unique-candidate lookup.
8. `src/adapters/site-rules.js` — loads frame-scoped local selectors, protects matching subtrees, conservatively repairs top-document selector drift, reports ephemeral frame health, accepts live rule updates, and safely restores attributes when rules are cleared.

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

The dialog ignores backdrop clicks and closes only on Esc. Its host explicitly maps `[hidden]` to `display: none` so the closed Shadow DOM backdrop cannot intercept pointer input. A debounced, child-list-only monitor checks for visible native search triggers after DOM readiness, Turbo mutations, and viewport changes. When none remain, a protected floating launcher keeps compatibility search reachable across result navigation and repeated dismissal without polling.

## User-authorized site rules

The optional site workflow has eight extension contexts:

1. `popup/` displays the current origin, reads ephemeral health from the active tab, and lets the user grant, repair, or remove protection.
2. `src/background/service-worker.js` validates messages, stores versioned data-only rules, and registers one persistent `document_start` script per authorized origin.
3. `src/composed-tree.js` discovers and queries nested open shadow roots with explicit traversal and result bounds.
4. `src/risk-detector.js` defines shared component boundaries and performs a bounded, user-initiated scan of visible structural interaction signals.
5. `src/mutation-risk-observer.js` keeps bounded, expiring evidence when visible interactive boundaries undergo a text-node-to-wrapper rewrite.
6. `src/selector-tools.js` gives creation and recovery one implementation for light DOM selectors, deep selector paths, and fingerprints.
7. `src/picker.js` combines structural and observed candidates or lets the user choose a component boundary manually. It generates a structural selector and a fingerprint containing only tag, role, type, name, and landmark metadata.
8. `Site-Translate-Guard.content.js` reads rules from local extension storage and activates the generic adapter. It observes later DOM additions through the same core.

The browser permission prompt is initiated from the popup. `activeTab` supports the one-time picker, while HTTP and HTTPS origins remain in `optional_host_permissions`. Dynamic content scripts require Chrome/Edge 96 or later.

Rules are keyed by exact origin, even though Chromium match patterns grant a hostname across ports. When a dynamically registered script runs on a different port, the adapter finds no matching exact-origin configuration and performs no protection.

Each authorized dynamic content script is registered with `allFrames: true`. Chromium evaluates the registered match pattern independently for every frame, so directly loaded HTTP/HTTPS child documents receive the script only when their own URL matches the authorized hostname. The adapter then checks the exact origin again. Opaque fallback documents such as `about:blank`, `srcdoc`, `data:`, `blob:`, and `filesystem:` are deliberately excluded because the extension retains a Chrome/Edge 96 minimum and does not enable the newer origin-fallback matching mode.

Stored rules include a minimal `frameScope` of `top` or `child`. Legacy rules default to `top`. Top-document rules never run inside a child frame, and child rules never run in the top document. The same selector may therefore be confirmed once in each scope without one rule replacing the other. A child rule applies to matching components in responding same-origin child frames, but automatic selector rebinding is disabled there: sibling frames can share an origin while representing different applications, so only a new explicit selection may repair a child rule.

Runtime frame discovery does not call programmatic `executeScript({allFrames: true})`. Such a call can be rejected when a tab also contains an inaccessible cross-origin frame. Instead, the service worker broadcasts a request to already loaded site-rule content scripts; each matching frame returns its browser-assigned frame ID and a bounded payload. The worker accepts at most 64 responses for the requested tab and exact origin during a short collection window. Picker files are then injected into each confirmed frame separately, so a stale or navigated frame cannot cancel injection into every other eligible frame. No frame URL, frame ID, response, or page content is persisted.

The detector scores custom elements, composite ARIA roles, dialogs and popovers, editable controls, ARIA relationships, and selected framework state attributes. It visits at most 3,000 visible elements per invocation across the light DOM and discovered open shadow roots, and keeps at most 24 raw candidates. It deliberately excludes visible text and input values, and its scores are never persisted or transmitted.

Open Shadow DOM rules use a packaged data selector path such as `#host >>> custom-search[role="combobox"]`. Each segment is ordinary CSS scoped to one document or open shadow root. Paths are limited to eight segments, queries return at most 5,000 elements, and separators inside quoted CSS attribute values are not treated as boundaries. The picker uses the composed event path to reach an inner element without activating the page. The same path implementation is used for initial protection, later insertions, health checks, attribute restoration, observed rewrites, and conservative selector rebinding. Existing observers are refreshed at rule load, DOM readiness, popup health checks, and picker activation; the extension neither polls continuously nor patches `attachShadow` or page DOM methods.

On an authorized origin, the mutation-risk observer looks for a conservative structural pattern: one bounded callback batch removes a text node and adds an element containing a text node at the same target inside a visible interactive component boundary. The evidence may arrive in one replacement record or separate removal and insertion records. It does not read either text node's data. Background tabs, passive content, hidden elements, and existing `translate="no"` boundaries are ignored. The observer inspects at most 200 records per callback, 100 added or removed nodes per record, and 200 wrapper descendants; it retains at most 24 candidates for 15 minutes. Disabling the site, including through a local configuration change, disconnects the observer and clears retained candidates in the existing tab. These signals only raise picker priority and popup awareness. They never create a rule automatically and do not prove that a translator caused the rewrite.

The picker maps candidates to bounded component roots, deduplicates them, and displays at most 12 ranked suggestions. It favors IDs and stable data attributes, then builds a bounded structural selector from roles, names, types, stable classes, and ancestry. Users can cycle suggestions, move the selected boundary to a parent, or return to manual selection before confirming.

When a confirmed selector stops matching, or matches an element that no longer agrees with its stored fingerprint, the site-rule adapter may repair the binding. Rebinding requires a sufficiently strong fingerprint, exactly one compatible candidate across the complete document and discovered open shadow roots, and the same candidate remaining unique for at least 250 ms without intervening DOM additions. A lightweight observer schedules re-evaluation for removals and selector/fingerprint attribute changes. Existing non-empty identity fields must match exactly. Ambiguous, weak, transient, cross-origin, missing-rule, and duplicate-selector updates are rejected. A successful update stores only the new structural selector or deep selector path, compatible fingerprint, and a `reboundAt` timestamp.

The popup requests health snapshots from responding frames in the active authorized tab only while it is open. Each applicable rule is classified as healthy, recovering, missing, ambiguous, weak, invalid, or unavailable, and each response includes only a bounded observed-risk count. The service worker aggregates enumerated states and combines rule IDs with already stored structural selectors and scopes for display. Responses contain no page text or candidate details; health snapshots, frame IDs, observed candidates, and page content are not persisted. An unresolved rule can be explicitly repaired by reopening the local picker with that rule ID in its stored scope. This user-confirmed replacement may change the fingerprint identity, is validated against the sender origin and frame scope, and stores a `repairedAt` timestamp. Automatic rebinding remains top-document-only, identity-preserving, and uses at most three exponentially delayed retries after transient background failures.

All configuration mutations share one service-worker queue. Concurrent picker confirmations, selector rebinds, removals, permission changes, and startup reconciliation therefore perform their read-modify-write cycles in order instead of overwriting another rule with stale storage state.

After a rule mutation, the service worker broadcasts the complete local rule set to open tabs matching the authorized hostname. Each content script verifies the exact origin before applying it, so same-host tabs on other ports ignore the update. This keeps existing tabs synchronized without requesting the broad `tabs` permission.

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
                          +--> local top-document or child-frame rule
                                   |
                                   +--> persistent document_start protection
                                            |
                                            +--> stale selector
                                                    |
                                                    +--> top: stable unique fingerprint match --> local selector repair
                                                    |
                                                    +--> child or unresolved --> popup diagnosis --> scoped user-confirmed replacement
```

## Security and scope

- The manifest statically matches only `https://github.com/*`. `activeTab`, `scripting`, and `storage` support the explicit user workflow; other HTTP and HTTPS hosts remain optional permissions.
- The extension does not patch global DOM prototypes. Silencing invalid `removeChild` or `insertBefore` calls can leave stale or missing UI without repairing application state.
- There is no developer server, analytics endpoint, remote script, or runtime dependency.
- Local extension storage contains only origin-scoped structural rules, a `top`/`child` scope, and rule timestamps, never frame IDs or URLs, page text, field values, structural or observed candidate scores, or runtime health snapshots.
- Playwright is a development-only dependency and is not referenced by the extension manifest or generated userscript.

## Limitations

- Future GitHub redesigns may require adapter selector or health-check updates.
- The fallback intentionally provides direct query submission, not native suggestions or saved searches.
- `translate="no"` is a request to translation systems, not a guarantee that every third-party translator will respect the boundary.
- Generic scoring is a best-effort structural heuristic, not proof that every risky component was found. Generic rules prevent translation inside a confirmed boundary; they do not infer business semantics or provide site-specific fallback UI.
- Selector rebinding is deliberately conservative; the popup reports ambiguous or weak rules and requires user confirmation through the targeted repair picker.
- Open shadow roots and direct HTTP/HTTPS same-origin child frames are supported after site authorization and reload. Closed roots, cross-origin frames, and opaque or inherited-origin fallback documents remain inaccessible.
- Observed DOM rewriting is evidence for ranking, not proof that translation caused a failure; user confirmation remains required.

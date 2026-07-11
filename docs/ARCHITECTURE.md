# Architecture

## Problem model

Full-page translators modify the live DOM rather than only painting translated text. A translator can replace a text node with wrapper elements while an application framework still holds a reference to the original node. Later UI updates can then fail, disappear, or throw `removeChild` and `insertBefore` exceptions.

GitHub's global search is one instance of that wider problem. It is a dynamic `qbsearch-input` custom element with nested dialog and query-builder components. Translation timing can interfere with its initialization or expansion after a reload or Turbo navigation.

The production extension remains deliberately limited to GitHub. The implementation separates reusable translation protection from GitHub-specific selectors and recovery behavior so that new sites can be evaluated without copying the entire script.

## Generated entry point

The extension and userscript both execute `GitHub-Search-Translate-Guard.user.js`. This is a committed generated artifact assembled by `scripts/build.mjs` from:

1. `src/core.js` — adapter registration, early scanning, mutation handling, lifecycle events, activation rules, and recovery scheduling.
2. `src/adapters/github.js` — GitHub selectors, health check, repository scope, and fallback dialog.
3. `src/bootstrap.js` — starts the registered adapters.

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

The GitHub adapter selects `qbsearch-input`. A document-wide MutationObserver covers initial parsing and later additions, while `turbo:before-render` protects the detached replacement body before attachment. `turbo:render` and `turbo:load` provide follow-up scans.

Activation of GitHub search by pointer or `/` schedules one deduplicated check after approximately 550 ms. The native search is healthy only when the component is expanded and its query input has a visible size. A healthy native search is left untouched.

If the check fails, the adapter creates a local Shadow DOM dialog. It preserves the current `data-scope` value when present and navigates directly to GitHub's `/search?q=...` endpoint on submit.

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
```

## Security and scope

- The manifest still matches only `https://github.com/*` and requests no browser API or host permissions.
- The extension does not patch global DOM prototypes. Silencing invalid `removeChild` or `insertBefore` calls can leave stale or missing UI without repairing application state.
- There is no developer server, analytics endpoint, storage layer, remote script, or runtime dependency.
- Playwright is a development-only dependency and is not referenced by the extension manifest or generated userscript.
- A future opt-in site mode would require separate permission, UI, privacy, and store review. It is not part of version 2.1.0.

## Limitations

- Future GitHub redesigns may require adapter selector or health-check updates.
- The fallback intentionally provides direct query submission, not native suggestions or saved searches.
- `translate="no"` is a request to translation systems, not a guarantee that every third-party translator will respect the boundary.

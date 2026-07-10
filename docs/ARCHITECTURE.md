# Architecture

## Problem model

GitHub's global search is a dynamic custom element (`qbsearch-input`) with nested dialog and query-builder components. Microsoft Edge full-page translation modifies the live DOM rather than merely painting translated text. Depending on refresh, cache, network, account state, and component timing, translation can interfere with GitHub's initialization or expansion of the search UI.

The extension deliberately avoids changing Edge translation settings. It limits intervention to GitHub's search component.

## Layer 1: early translation isolation

The content script runs at `document_start` and marks `qbsearch-input` with:

```html
translate="no" class="notranslate"
```

A MutationObserver covers nodes added after initial parsing. GitHub Turbo events are also observed, including `turbo:before-render`, so replacement content can be marked before attachment when GitHub exposes it.

This layer keeps Edge translation out of the search subtree while allowing the rest of the page to remain translated.

## Layer 2: runtime recovery

Early isolation reduces the race but cannot assume that a normal extension always executes before a browser-internal translator on every Edge version and loading path.

The script therefore observes activation of GitHub's search entry and the `/` shortcut without replacing a working native search. After approximately 550 ms it verifies that:

- the `qbsearch-input` component entered its expanded state; and
- a query input has a non-zero visible size.

If native search is usable, the extension does nothing further. If not, it creates a local Shadow DOM dialog. Shadow DOM isolates the fallback from GitHub styles and page translation. The dialog preserves the current `data-scope` value where available and navigates directly to GitHub's `/search?q=...` endpoint on submit.

## Data flow

```text
User activates search
        |
        +--> Native GitHub search usable --> keep native UI
        |
        +--> Native search unavailable ----> local Shadow DOM input
                                                 |
                                                 +--> browser navigates directly to github.com/search
```

There is no developer server, analytics endpoint, storage layer, remote script, or third-party SDK.

## Scope and limitations

- The extension matches only `https://github.com/*`.
- It relies on GitHub's current search entry and `qbsearch-input` selectors; future GitHub redesigns might require selector updates.
- Network access to GitHub is still required to load pages and search results.
- The fallback provides direct query submission, not all native suggestions or saved-search features.

# Translation Compatibility Research

## Evidence that the problem is cross-site

Browser translation and other text-rewriting extensions can invalidate DOM references held by modern web applications. Public reports include:

| Project or component | Reported failure | Reference |
|---|---|---|
| React | Translated text nodes later cause `removeChild` failures | [facebook/react#11538](https://github.com/facebook/react/issues/11538) |
| Remix | The translated application can crash while updating | [remix-run/remix#3807](https://github.com/remix-run/remix/issues/3807) |
| Next.js documentation | Client navigation can fail after page translation | [vercel/next.js#66313](https://github.com/vercel/next.js/discussions/66313) |
| Radix Select | A translated select trigger can crash during state changes | [radix-ui/primitives#2578](https://github.com/radix-ui/primitives/issues/2578) |

The HTML `translate` attribute is the standards-based way to identify content that translation tools should leave unchanged. See the [W3C internationalization guidance](https://www.w3.org/International/questions/qa-translate-flag.en.html) and [MDN reference](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Global_attributes/translate).

## Chosen strategy

The guard protects the smallest stable interactive subtree before a translator mutates it. This lets the rest of the page remain translated and avoids changing browser translation settings.

Prevention and recovery are intentionally separate:

- The generic core discovers and marks adapter-selected subtrees.
- A site adapter understands whether its native component is healthy.
- A site adapter may provide a narrowly scoped fallback when prevention loses a timing race.

The project does not monkey-patch `Node.prototype.removeChild` or `insertBefore`. That workaround can suppress a crash while leaving stale translated content or preventing new content from appearing. A detailed discussion is available in [Everything about Google Translate crashing React](https://martijnhols.nl/blog/everything-about-google-translate-crashing-react).

## Deterministic validation

Tests do not depend on mutable production websites or on an automation API for browser-native translation. Local fixtures reproduce the relevant mutation by replacing text nodes with `<font>` wrappers:

- The React/Next-style fixture conditionally removes a text node retained by application state.
- The Radix-style fixture replaces select trigger text during a loading transition and inserts dynamic options.

Each fixture first proves that the unprotected version fails, then proves that the guard prevents the mutation inside the selected subtree while outside copy remains translatable. GitHub-specific tests separately cover initial and dynamic nodes, Turbo pre-render content, healthy native search, editable-field shortcuts, fallback scope, reloads, and multiple tabs.

## Product boundary

Version 2.6.0 provides an opt-in path with local structural risk suggestions, bounded recent DOM-rewrite evidence, conservative selector-drift repair, user-visible rule health, and targeted explicit repair for user-authorized sites. GitHub remains the only statically matched site. Other HTTP or HTTPS sites require an explicit browser permission prompt, a user-confirmed component boundary, and a data-only local rule. The generic path provides best-effort candidate discovery, stable unique-candidate rebinding, translation isolation, and local diagnostics but does not claim to understand or recover arbitrary site behavior.

Community rules and additional recovery adapters remain future work. They must not convert optional access into automatic all-site access or introduce remotely executable rules.

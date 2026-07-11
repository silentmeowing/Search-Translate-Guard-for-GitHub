# Microsoft Edge Add-ons Store Audit

Audit date: July 11, 2026

## Manifest

| Field | Value | Result |
|---|---|---|
| `manifest_version` | `3` | Pass |
| `name` | localized `__MSG_extensionName__` | Pass |
| `version` | `2.8.1` | Pass |
| `description` | localized `__MSG_extensionDescription__` | Pass |
| `default_locale` | `en` | Pass |
| Locales | `en`, `zh_CN` | Pass |
| `minimum_chrome_version` | `96` | Required for dynamic content scripts |
| Icons | 16/32/48/128 PNG | Pass |
| Built-in site scope | `https://github.com/*` | Narrow and disclosed |
| Browser API permissions | `activeTab`, `scripting`, `storage` | User-initiated site-rule workflow |
| Optional hosts | `http://*/*`, `https://*/*` | Requested one hostname at a time |
| Required host permissions | none | Pass |
| `update_url` | omitted | Pass; store updates use Partner Center |
| Development `key` | omitted | Pass |

## Code and policy

- Single purpose: prevent page translation from breaking selected interactive components, with a verified GitHub search recovery adapter.
- No remote code, dynamic import, `eval`, XMLHttpRequest, or `fetch`.
- No obfuscation or runtime dependency.
- Playwright is used only in development and is not included in the extension runtime.
- No advertising, analytics, telemetry, account system, payment, or notification feature.
- No developer-side collection, sale, sharing, or transmission of user data.
- Local structural risk candidates are computed only when the authorized-site picker opens and are not persisted or transmitted.
- Recent DOM rewrite signals on authorized sites are bounded, structural, expire in memory, and expose only a count to the popup.
- Open Shadow DOM traversal is packaged, bounded, and activated only on authorized sites; closed roots are not accessed.
- Direct HTTP/HTTPS same-origin frames receive independently URL-matched protection after reload; cross-origin and opaque fallback frames are not accessed.
- Frame discovery is limited to responses from authorized content scripts, capped at 64, and never persists frame IDs, frame URLs, or health responses.
- Local storage contains only enabled origins, user-confirmed, explicitly repaired, or conservatively rebound structural selectors, non-text fingerprints, `top`/`child` scopes, and rule timestamps; it never contains structural or observed candidate scores, runtime health snapshots, field values, or visible page text.
- Search scope and query are processed locally; submission navigates directly to GitHub.
- Original icon; no GitHub, Microsoft, or Edge logo.
- Non-affiliation statement is present in the README, privacy policy, and store description.
- No test account is required; public GitHub repositories are sufficient for certification.

## Required Partner Center disclosures

### Single purpose

Keeps interactive components usable while Microsoft Edge automatic page translation is active. GitHub search has built-in protection and a verified local fallback. On other sites, the extension acts only after the user grants access to the current site and confirms a suggested or manually selected component boundary.

### Site access justification

Static access to `https://github.com/*` is required to protect GitHub search and display a local compatibility dialog when the native input fails to open.

`activeTab` is used only after the user opens the extension on the current tab. `scripting` injects the component picker into individually confirmed frames and registers the packaged protection script. `storage` keeps the user's local origin, selector, and top/child scope rules. HTTP and HTTPS wildcard patterns are optional host permissions: the extension requests only the current hostname through a browser consent prompt and does not receive automatic access to all websites at installation.

The extension does not request browser history, `webNavigation`, cookies, identity, downloads, or clipboard permissions.

### Remote code and data

- Remote code: No.
- User data collected or transmitted to the developer: None.
- Local rule storage: enabled origins, confirmed, explicitly repaired, or conservatively rebound selectors, non-text fingerprints, top/child scopes, and timestamps only.
- Data sold or shared: None.
- Analytics or telemetry: None.

## Submission assets

- Extension source and manifest icons are in the repository root.
- A 300×300 listing logo and two 1280×800 screenshots are under `store-assets/`.
- Promotional tiles are optional and are not included.
- Store listing descriptions and certification notes are entered separately in Partner Center.

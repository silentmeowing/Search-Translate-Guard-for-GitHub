# Microsoft Edge Add-ons Store Audit

Audit date: July 11, 2026

## Manifest

| Field | Value | Result |
|---|---|---|
| `manifest_version` | `3` | Pass |
| `name` | localized `__MSG_extensionName__` | Pass |
| `version` | `2.0.0` | Pass |
| `description` | localized `__MSG_extensionDescription__` | Pass |
| `default_locale` | `en` | Pass |
| Locales | `en`, `zh_CN` | Pass |
| `minimum_chrome_version` | `88` | Pass |
| Icons | 16/32/48/128 PNG | Pass |
| Site scope | `https://github.com/*` | Narrow and disclosed |
| Browser API permissions | none | Pass |
| `update_url` | omitted | Pass; store updates use Partner Center |
| Development `key` | omitted | Pass |

## Code and policy

- Single narrow purpose: protect and recover GitHub search during page translation.
- No remote code, dynamic import, `eval`, XMLHttpRequest, or `fetch`.
- No obfuscation or runtime dependency.
- No advertising, analytics, telemetry, account system, payment, or notification feature.
- No collection, storage, sale, sharing, or developer-side transmission of user data.
- Search scope and query are processed locally; submission navigates directly to GitHub.
- Original icon; no GitHub, Microsoft, or Edge logo.
- Non-affiliation statement is present in the README, privacy policy, and store description.
- No test account is required; public GitHub repositories are sufficient for certification.

## Required Partner Center disclosures

### Single purpose

Keeps GitHub's search interface usable while Microsoft Edge automatic page translation is active. It protects the native search component and provides a local fallback search dialog only when the native component fails to open.

### Site access justification

Access to `https://github.com/*` is required to inspect and mark GitHub's search component, observe its activation, and display a local compatibility search dialog when the native input fails to open. The extension does not access other websites or request browser history, tabs, cookies, storage, identity, downloads, or clipboard permissions.

### Remote code and data

- Remote code: No.
- User data collected: None.
- Data sold or shared: None.
- Analytics or telemetry: None.

## Submission assets

- Extension source and manifest icons are in the repository root.
- A 300×300 listing logo and two 1280×800 screenshots are under `store-assets/`.
- Promotional tiles are optional and are not included.
- Store listing descriptions and certification notes are entered separately in Partner Center.

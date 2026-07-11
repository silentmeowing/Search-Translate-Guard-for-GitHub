# Privacy Policy

Effective date: July 11, 2026

Search Translate Guard for GitHub keeps GitHub search usable when automatic page translation interferes with GitHub's search interface. It can also isolate components that the user explicitly selects on other sites after granting access to that site.

## Data collection

The extension does not collect, store, sell, share, or transmit personal information, browsing history, authentication information, analytics, or telemetry to the developer or any third party.

## Local processing

The built-in adapter runs on `https://github.com/*`. It locally inspects GitHub's search component, the current repository search scope, and whether the search input opened successfully. When the compatibility search dialog is used, the query remains in the browser until the user submits it. The browser then navigates directly to GitHub Search.

For other HTTP or HTTPS sites, the extension runs only after the user opens the extension, grants access to the current site, and enables protection. When the user opens the component picker, a bounded local scan scores visible structural signals such as element tags, ARIA roles and relationships, popup attributes, and framework state attributes. It does not read visible text or field values. Candidate elements and scores remain in memory only and are discarded when the picker closes.

Locally stored rules contain the site's origin, a user-confirmed structural CSS selector, a non-text element fingerprint, and rule timestamps. They do not contain candidate scores, input values, passwords, cookies, page contents, visible text, or runtime health snapshots. These rules are used only to reapply `translate="no"` protection on that site. If a selector stops matching, the extension may locally compare its fingerprint with structural candidates; it updates the stored selector and `reboundAt` timestamp only when one compatible candidate remains globally unique for a stability window.

When the extension popup is open, it can request an ephemeral rule-health snapshot from the active authorized tab. The page returns only rule IDs and enumerated states such as healthy, missing, or ambiguous. These states are not saved. If the user explicitly repairs a rule, the newly selected structural selector and non-text fingerprint replace that rule locally and receive a `repairedAt` timestamp.

## Permissions

The extension uses `activeTab` to work with the current tab only after the user clicks the extension, `scripting` to run the component picker and protection script, and `storage` to keep the user's local site rules. GitHub remains the only statically matched site. HTTP and HTTPS origins are declared as optional host permissions and are requested one site at a time through a browser-controlled consent prompt. The user can remove a site's permission at any time.

The extension does not request browser history, cookies, downloads, identity, or clipboard access.

## Remote code and third-party services

The extension contains no remote executable code, advertising, analytics, or third-party SDKs. Use of GitHub and GitHub Search remains subject to GitHub's own terms and privacy policy.

## Retention and deletion

There is no developer-held user data to retain or delete. Users can clear a site's component rules in the extension popup, remove that site's permission, or remove all local extension data by uninstalling the extension in Microsoft Edge.

## Changes and contact

If the extension's data practices change, this policy will be updated before the changed version is published. Questions may be submitted through this repository's Issues page. Do not include passwords, tokens, private repository content, or other sensitive information in a public issue.

This is an independent project and is not affiliated with, endorsed by, or sponsored by GitHub, Microsoft, or Microsoft Edge.

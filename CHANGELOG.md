# Changelog

All notable changes to this project are documented here.

## [2.2.1] - 2026-07-11

### Fixed

- Protected the separate React search trigger used by GitHub's authenticated redesigned header.
- Recognized authenticated-header clicks as recovery activations so the compatibility search still opens when the native dialog fails.
- Checked every `qbsearch-input` instance when GitHub renders hidden templates alongside the live search component.

### Validation

- Added deterministic logged-in and logged-out header fixtures that reproduce the translation DOM mismatch without protection and verify both native and fallback paths with protection.

## [2.2.0] - 2026-07-11

### Added

- User-initiated, per-site optional access for HTTP and HTTPS pages.
- A localized popup for enabling, inspecting, clearing, and disabling site protection.
- An on-page component picker that stores structural selectors and non-text fingerprints.
- Persistent `document_start` registration for origins that the user explicitly authorizes.
- A generated generic site-rule content script that coexists with the built-in GitHub adapter.

### Validation

- Added service-worker state-machine, late-adapter, rule restoration, selector privacy, picker, and unpacked-extension tests.

### Permissions and privacy

- Added `activeTab`, `scripting`, and `storage` for the user-authorized workflow.
- Declared HTTP/HTTPS origins as optional host permissions; no non-GitHub site is granted automatically.
- Stored rules remain local and contain no input values or visible page text.

## [2.1.0] - 2026-07-11

### Changed

- Extracted reusable translation protection, lifecycle handling, and recovery scheduling into a documented guard core.
- Moved GitHub selectors, native-search health checks, scope handling, and fallback UI into a site adapter.
- Made the extension/userscript entry point a deterministic generated artifact assembled from readable source files.

### Validation

- Added Playwright coverage for React/Next-style and Radix-style translation DOM mutations.
- Added GitHub regression coverage for dynamic nodes, Turbo pre-render content, native and fallback search, reloads, shortcuts, and multiple tabs.
- Added generated-artifact and cross-file version checks to CI.

### Permissions and privacy

- Retained the GitHub-only match pattern, zero browser API permissions, no remote code, and no data collection.

## [2.0.0] - 2026-07-11

### Added

- Early `translate="no"` protection for GitHub's search component.
- MutationObserver and GitHub Turbo navigation handling.
- Automatic compatibility search dialog when native search fails to open.
- Repository-scope preservation in the fallback query.
- English and Simplified Chinese localization.
- Original extension icons and Microsoft Edge Add-ons submission assets.
- Privacy, architecture, security, contribution, and store-audit documentation.
- Automated manifest/package validation through GitHub Actions.

### Privacy

- No data collection, storage, analytics, telemetry, advertising, or remote code.

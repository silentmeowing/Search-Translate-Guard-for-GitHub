# Changelog

All notable changes to this project are documented here.

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

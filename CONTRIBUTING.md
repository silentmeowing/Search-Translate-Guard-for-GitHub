# Contributing

Contributions that improve compatibility, accessibility, tests, documentation, or localization are welcome.

## Development

1. Fork and clone the repository.
2. Install development dependencies with `npm ci` and Chromium with `npx playwright install chromium`.
3. Edit files under `src/` and `popup/`; do not edit either generated root content script directly.
4. Run `npm run build` to regenerate the GitHub userscript and opt-in site content script.
5. Run `npm run check` before opening a pull request.
6. Run `npm run package` before a release and confirm the generated ZIP has `manifest.json` at its root.
7. Load the repository root as an unpacked Edge or Chrome extension.
8. Manually test initial navigation, F5 reload, `/`, mouse activation, GitHub Turbo navigation, automatic page translation, and multiple tabs.

## Requirements

- Do not add remote executable code, analytics, advertising, or telemetry.
- Do not add permissions without a concrete user-facing need and documentation.
- Keep all code readable and unobfuscated.
- Keep Playwright and other development tools out of the extension manifest and generated runtime.
- Store only data-only structural rules; never persist input values, passwords, or visible page text.
- Keep non-GitHub access optional and initiated by an explicit user gesture.
- Update both `_locales/en/messages.json` and `_locales/zh_CN/messages.json` when changing visible text.
- Keep versions in `manifest.json`, `package.json`, userscript metadata, and `CHANGELOG.md` aligned for a release.
- Never commit `.pem`, `.crx`, Partner Center credentials, cookies, tokens, or private test data.

## Pull requests

Describe the problem, the change, test coverage, and any impact on permissions or data handling. UI changes should include a screenshot where practical. Pull requests must include an up-to-date generated userscript and pass the required CI checks.

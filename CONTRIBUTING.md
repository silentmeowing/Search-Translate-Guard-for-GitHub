# Contributing

Contributions that improve compatibility, accessibility, tests, documentation, or localization are welcome.

## Development

1. Fork and clone the repository.
2. Install development dependencies with `npm ci` and Chromium with `npx playwright install chromium`.
3. Edit files under `src/`; do not edit `GitHub-Search-Translate-Guard.user.js` directly.
4. Run `npm run build` to regenerate the extension/userscript entry point.
5. Run `npm run check` before opening a pull request.
6. Load the repository root as an unpacked Edge extension.
7. Manually test initial navigation, F5 reload, `/`, mouse activation, GitHub Turbo navigation, automatic page translation, and multiple tabs.

## Requirements

- Do not add remote executable code, analytics, advertising, or telemetry.
- Do not add permissions without a concrete user-facing need and documentation.
- Keep all code readable and unobfuscated.
- Keep Playwright and other development tools out of the extension manifest and generated runtime.
- Update both `_locales/en/messages.json` and `_locales/zh_CN/messages.json` when changing visible text.
- Keep versions in `manifest.json`, `package.json`, userscript metadata, and `CHANGELOG.md` aligned for a release.
- Never commit `.pem`, `.crx`, Partner Center credentials, cookies, tokens, or private test data.

## Pull requests

Describe the problem, the change, test coverage, and any impact on permissions or data handling. UI changes should include a screenshot where practical. Pull requests must include an up-to-date generated userscript and pass the required CI checks.

# Contributing

Contributions that improve compatibility, accessibility, tests, documentation, or localization are welcome.

## Development

1. Fork and clone the repository.
2. Make focused changes that preserve the extension's single purpose.
3. Run `node scripts/validate.mjs`.
4. Load the repository root as an unpacked Edge extension.
5. Test initial navigation, F5 reload, `/`, mouse activation, GitHub Turbo navigation, and multiple tabs.

## Requirements

- Do not add remote executable code, analytics, advertising, or telemetry.
- Do not add permissions without a concrete user-facing need and documentation.
- Keep all code readable and unobfuscated.
- Update both `_locales/en/messages.json` and `_locales/zh_CN/messages.json` when changing visible text.
- Increment `manifest.json` version for a release and update `CHANGELOG.md`.
- Never commit `.pem`, `.crx`, Partner Center credentials, cookies, tokens, or private test data.

## Pull requests

Describe the problem, the change, test coverage, and any impact on permissions or data handling. UI changes should include a screenshot where practical.

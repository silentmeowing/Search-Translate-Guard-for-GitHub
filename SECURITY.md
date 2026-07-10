# Security Policy

## Supported version

Security fixes are applied to the latest published version.

## Reporting a vulnerability

Prefer GitHub's private vulnerability reporting feature from the repository's **Security** tab when available. Include a concise description, affected version, reproduction steps, and expected impact.

If private reporting is unavailable, open a minimal public issue requesting a private contact channel. Do not publish tokens, passwords, private repository content, exploit details, or personal information in a public issue.

## Security design

- The extension contains no remote executable code or third-party runtime dependency.
- It makes no `fetch` or XMLHttpRequest calls.
- It requests no browser API permissions.
- Its only site scope is `https://github.com/*`.
- User queries are sent directly to GitHub through normal browser navigation.

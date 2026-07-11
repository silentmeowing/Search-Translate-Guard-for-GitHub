# Security Policy

## Supported version

Security fixes are applied to the latest published version.

## Reporting a vulnerability

Prefer GitHub's private vulnerability reporting feature from the repository's **Security** tab when available. Include a concise description, affected version, reproduction steps, and expected impact.

If private reporting is unavailable, open a minimal public issue requesting a private contact channel. Do not publish tokens, passwords, private repository content, exploit details, or personal information in a public issue.

## Security design

- The extension contains no remote executable code or third-party runtime dependency.
- It makes no `fetch` or XMLHttpRequest calls.
- Its built-in site scope remains `https://github.com/*`; access to any other HTTP or HTTPS origin is optional and requested only after a user gesture.
- `activeTab`, `scripting`, and `storage` are limited to the component-selection and local-rule workflow.
- Site rules are data-only and contain no executable code, input values, passwords, or visible page text.
- Dynamically registered scripts are removed when the user disables a site or revokes its permission.
- User queries are sent directly to GitHub through normal browser navigation.

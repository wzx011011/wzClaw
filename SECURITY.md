# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in wzxClaw, please report it responsibly:

1. **Do not** open a public GitHub issue for security vulnerabilities.
2. Email the maintainer directly or use [GitHub's private vulnerability reporting](https://github.com/wzx011011/wzClaw/security/advisories/new).
3. Include as much detail as possible:
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact
   - Any suggested fixes

## Response Timeline

- **Acknowledgment** — Within 48 hours
- **Initial assessment** — Within 7 days
- **Fix or mitigation** — Depends on severity, typically within 14 days

## Security Considerations

wzxClaw runs AI-generated commands on your local machine. Be aware of the following:

- **Bash tool** — Can execute arbitrary shell commands. The permission system controls auto-approval.
- **File write/edit tools** — Can modify any file within the workspace. Path traversal is blocked.
- **API keys** — Stored locally in Electron's app data. Never committed to the repository.
- **Relay server** — Uses token-based authentication. Ensure `AUTH_TOKEN` is kept secret.

## Supported Versions

| Version | Supported |
| ------- | --------- |
| 1.2.x   | Yes       |
| 1.1.x   | Yes       |
| 1.0.x   | Yes       |
| < 1.0   | No        |

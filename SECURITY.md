# Security policy

EveryOS is pre-release software (0.x). Only the latest commit on `main` receives fixes.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's
[private vulnerability reporting](https://github.com/goktugcy/everyos/security/advisories/new) for this
repository. Do not open public issues, pull requests or discussions about unfixed vulnerabilities.

Include the affected version or commit, the impact, and reproduction steps. We aim to acknowledge
reports within 7 days.

## Scope

In scope: the API, the privileged agent, the web client, the build and packaging scripts, and the
default configuration. Especially relevant are authentication bypasses, privilege escalation
through the agent, CSRF, XSS, SSRF, path traversal and command injection.

The design and its known residual risks are documented in
[docs/security-model.md](docs/security-model.md).

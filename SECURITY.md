# Security policy

## Supported versions

Only the latest release on [npm](https://www.npmjs.com/package/proton-mail-bridge-client) receives security fixes.

## Reporting a vulnerability

Please report vulnerabilities privately, not in a public issue or pull request.

- **GitHub:** the repository's [Security tab](https://github.com/googlarz/proton-mail-bridge-client/security/advisories/new) (private vulnerability reporting).
- **Email:** googlarz@gmail.com, with the subject `SECURITY: proton-mail-bridge-client`.
- Include the version (`proton-mail-bridge-client version`), what you did, what you expected and what happened, and the impact you see. A reproducing input helps most.

This is maintained by one person, so replies are best effort and there is no fixed response time. Reports are credited in the release notes unless you ask not to be.

What the project protects and where it stops is described in [docs/threat-model.md](docs/threat-model.md).

## Scope

In scope: the MCP server and CLI in this repository, including the handling of received mail (HTML, headers, calendar invitations, attachments), the policy gates for sending and deleting, and multi-account routing.

Out of scope: Proton Mail Bridge itself, Proton's servers, and third-party dependencies (please report those upstream). Findings that need local write access to the data directory or a malicious Bridge are low severity.

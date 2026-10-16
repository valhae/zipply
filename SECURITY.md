# Security policy

Zipply is a personal, pre-release project. It has **not** been independently audited, and no version is currently deployed or supported for real use.

## Reporting a vulnerability

Please report suspected vulnerabilities privately through GitHub's **"Report a vulnerability"** button (private security advisories) on this repository once it is published. Do not open a public issue for security problems.

Include what you found, how to reproduce it, and the impact you expect. Please use only test peers and synthetic files — never real personal data.

## Scope and honest limits

The intended security model is documented in [`docs/SECURITY_DECISIONS.md`](docs/SECURITY_DECISIONS.md). In particular, Zipply does not claim to protect against a compromised device, malicious browser extensions, a compromised hosting origin serving malicious JavaScript, or users who approve a peer without comparing the verification phrase. Direct WebRTC connections can reveal network-address metadata to the other peer and to STUN servers.

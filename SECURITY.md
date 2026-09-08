# Security Policy

## Reporting a vulnerability

Report vulnerabilities privately through the repository's GitHub Security
Advisories page. Do not open a public issue for an unpatched vulnerability.

Include the affected endpoint or tool, the expected and observed behavior, and
minimal reproduction steps. Never include a real esa token, OAuth credential,
GitHub private key, or Cloudflare secret.

## Deployment responsibility

Each deployment has its own trust boundary. Restrict OAuth callback hosts,
limit the GitHub App to the intended repository, keep secrets in Cloudflare
encrypted secrets, and rotate credentials after suspected exposure.

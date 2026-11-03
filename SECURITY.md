# Security Policy

`naked-eye` is a security control: it stands between attacker-written HTML and
a language model. A way to get hidden text past it is a vulnerability, and it is
handled as one.

## Supported versions

| Version | Supported |
|---|---|
| Latest `0.x` minor | Yes |
| Older `0.x` minors | No. Upgrade to the latest minor. |

## Reporting a vulnerability

Report privately through GitHub Security Advisories:

**<https://github.com/sean1093/naked-eye/security/advisories/new>**

**Do not open a public issue, discussion, or pull request for a suspected
vulnerability.** A bypass published before a fix exists shows every attacker
how to get instructions past every pipeline that uses this library.

Please include:

- the `naked-eye` version and the runtime: Node.js, Deno, Bun or Workers, and
  for browser mode the browser and its version;
- the mode you used, static or browser, and the options you passed;
- the smallest HTML document that reproduces the problem;
- the text that reached `text`, and why a human looking at the page would not
  see it.

You will get an acknowledgement within **5 business days**. If the report is
accepted we will agree a disclosure timeline with you, publish a fixed release,
and credit you in the advisory unless you ask us not to.

## Scope

In scope:

- Text that reaches `text` through a technique the
  [threat model](docs/threat-model.md#hiding-techniques) marks as covered for
  the mode you used.
- A technique the threat model does not mention at all. Report it privately as
  well, and we will decide together whether it is a vulnerability or a
  documented limitation.
- Input that makes the extractor crash, overflow the stack, or take far longer
  than a browser needs to style the same document.
- A vulnerability in a runtime dependency that affects the output or
  availability of `naked-eye`. Please report it to the dependency as well.

Out of scope:

- Techniques the threat model lists under
  [Known limitations](docs/threat-model.md#known-limitations).
- Visible text that is malicious. `naked-eye` does not judge visible text.
- Vulnerabilities in development-only dependencies that cannot affect the
  published package.
- Missing hardening that has no demonstrated impact.

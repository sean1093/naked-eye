# Contributing to naked-eye

Thanks for helping. `naked-eye` is a security control: its job is to make sure
a model never reads text that a human could not see. Every change is judged
first by whether it keeps that promise, and then by everything else.

- Questions and ideas: [Discussions](https://github.com/sean1093/naked-eye/discussions).
- Bugs and feature requests: [issues](https://github.com/sean1093/naked-eye/issues/new/choose).
- **Hidden text that gets through is a vulnerability.** Report it privately as
  described in [SECURITY.md](SECURITY.md), never in a public issue.

This project follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## Prerequisites

- Node.js 22 for development (see `.nvmrc`). CI also tests 20, 24 and 26.
- npm. The lockfile is `package-lock.json`; install with `npm ci`.

## Getting started

```sh
git clone https://github.com/sean1093/naked-eye.git
cd naked-eye
npm ci
npm test
```

## Scripts

| Command | What it does |
|---|---|
| `npm run build` | Builds `dist/` with tsup: ESM, CJS and type declarations. |
| `npm run dev` | Rebuilds `dist/` on every change. |
| `npm test` | Runs the test suite once. |
| `npm run test:watch` | Runs the test suite in watch mode. |
| `npm run test:coverage` | Runs the test suite with v8 coverage and enforces the thresholds. |
| `npm run lint` | Checks formatting and lint rules with Biome. |
| `npm run lint:fix` | Applies Biome's formatting and safe fixes. |
| `npm run typecheck` | Type-checks sources and tests with `tsc --noEmit`. |
| `npm run check:exports` | Packs the package and validates its entry points with attw and publint. |
| `npm run size` | Checks the bundle-size budget of the built entry points, dependencies included. |
| `npm run check:docs` | Checks links, anchors and code fences in the documentation, offline. |

## Project layout

```text
src/        library source
test/       Vitest suites
docs/       the threat model and reference documentation
scripts/    repository tooling: the documentation gate
.github/    CI workflows, issue forms and the pull request template
```

## Making a change

1. For anything larger than a typo, open an issue first, so the approach is
   agreed before code is written.
2. Branch from `main` and name the branch `<type>/<issue>-<slug>`, for example
   `fix/42-clip-path-inset`.
3. Write the test first. A bug fix comes with a test that fails without it.
4. Keep the pull request to one issue.
5. Title the pull request in [Conventional Commits](https://www.conventionalcommits.org/)
   style (`feat:`, `fix:`, `docs:`, `test:`, `chore:`, `ci:`). Pull requests are
   squash-merged, so the title becomes the commit message.
6. Fill in the pull request template, including `Closes #<issue>`.

### Adding a hiding technique

A hiding technique is any way to put text into a document that a human looking
at the rendered page cannot see.

1. Check the [threat model's catalogue](docs/threat-model.md#hiding-techniques).
   If the technique is listed as covered and text still gets through, stop
   here: that is a vulnerability, so report it privately.
2. Write a failing test: add a case to the shared corpus in `test/cases.ts`
   with the smallest HTML document that uses the technique, the visible text
   you expect, and the reason code you expect for the removed text. Static mode
   and browser mode both run every case.
3. Add the opposite case: the same markup without the hiding declaration keeps
   its text. That is what stops a rule from quietly removing visible content.
4. Make both pass, in static mode and, where the browser can tell, in browser
   mode.
5. Update the catalogue in the threat model, or move the technique out of
   [Known limitations](docs/threat-model.md#known-limitations).

## Quality gates

CI runs these on every pull request, and all of them must pass before a merge:

| Gate | Command |
|---|---|
| Formatting and lint | `npm run lint` |
| Types | `npm run typecheck` |
| Documentation | `npm run check:docs` |
| Tests and coverage thresholds | `npm run test:coverage` |
| Build | `npm run build` |
| Published entry points | `npm run check:exports` |
| Bundle size | `npm run size` |

A test matrix then runs the suite and the build on Node.js 20, 22, 24 and 26 on
Linux, and on Node.js 24 on Windows and macOS.

Coverage thresholds are 90% for lines, functions and statements and 85% for
branches. Raise them when you can; never lower them to get a change through.

## Runtime dependencies

The library parses attacker-controlled HTML and CSS, so every runtime
dependency is part of its attack surface and ships to every user. A pull
request that adds one explains why the existing dependencies cannot do the job.

## What does not belong in this library

These are settled non-goals, explained in the
[threat model](docs/threat-model.md#non-goals):

- Judging whether visible text is malicious: keyword lists, classifiers, allow
  and deny lists.
- Reading text in pixels (OCR), or converting other formats such as PDF.
- Sanitizing HTML for rendering. The output is plain text.
- Fetching anything. Static mode never touches the network; callers pass
  stylesheets in.
- Launching or managing browsers. Browser mode works with a page the caller
  already has open.

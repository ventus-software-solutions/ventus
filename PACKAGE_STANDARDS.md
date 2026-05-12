# Package standards for extractions

Status: accepted draft; operator decision locked 2026-05-12  
Scope: packages under `extractions/`, currently `@ventus-software-solutions/task-queue`

## Purpose

This document captures the release and maintenance rules for packages extracted from AIDE so future packages inherit the same discipline instead of rediscovering it.

## Package identity

- Package names must use the locked `@ventus-software-solutions/*` namespace and remain stable after first publication.
- Each package must have a short README that explains the problem, the public API, install/build/test commands, and the current maturity level.
- Before external publication, package metadata must include `license`, `repository`, and `bugs`; `funding` is optional and npm provenance is deferred until CI supports it reliably.
- Extracted packages should stay small and dependency-light unless a dependency is core to the package's value.
- Avoid AIDE-specific runtime assumptions in extracted code; AIDE may consume the package, but the package should be useful independently.
- Packages cannot import from `aide/backend`, `aide/frontend`, AIDE runtime state files, or other extracted packages unless declared as a dependency. They must build and run with only their declared dependencies.

## Versioning

- Use SemVer.
- Patch releases are bug fixes, documentation corrections, or test-only hardening that do not change public behavior.
- Minor releases add backward-compatible APIs or behavior.
- Major releases remove or rename public APIs, change persistence formats incompatibly, or alter documented semantics.
- Once a package reaches `1.x`, removals should follow a deprecation cycle: mark the API `@deprecated` with a replacement hint, ship one or more minor releases with visible deprecation notes, then remove in the next major release. In `0.x`, clearly documented breaking changes are sufficient.
- Update `package.json`, `package-lock.json`, README examples, and any design notes in the same version-change commit.
- Keep a short design/change note when a package crosses a meaningful milestone such as `v0.2.0`.

## Public API discipline

- Export only intentional public types and functions from the package entry point.
- Prefer small explicit option objects over positional parameters once an API has more than two inputs.
- Public errors should be deterministic enough for callers to handle or test.
- Do not leak internal file layouts, AIDE task IDs, or EventLedger details unless they are the explicit package contract.
- When adding a new exported API, add at least one README example or test that demonstrates intended usage.

## Persistence and state

- Packages that write durable state must document the owning writer and the expected file format.
- Avoid multiple writers to the same file unless the package provides the merge/locking behavior itself.
- State files must remain strict JSON when documented as JSON.
- Version any durable schema once external callers could depend on it.

## Testing and verification

- Every package should have `npm test`, `npm run typecheck`, and `npm run build` commands when TypeScript is used.
- Run package-local tests/typecheck/build before a package release commit.
- For behavior changes, add or update regression tests before calling the package reliable.
- README examples should compile conceptually against the exported API; if they drift, update them with the code.
- Root AIDE typecheck is required when the main repo consumes the changed package or when shared config changes.

## Release checklist

1. Confirm the package has a clear owner and purpose.
2. Update code, tests, README, design notes, and version metadata together.
3. Run package-local verification: tests, typecheck, build.
4. Run root verification when AIDE integration or repo-level config is touched.
5. Inspect `git diff` for accidental AIDE runtime state, credentials, logs, or scratch files.
6. Commit one logical change with verification notes and `Co-authored-by: AIDE <aide@agent>`.
7. Do not publish externally unless the operator explicitly requests publication.

## Resolved review decisions

- Namespace is locked to `@ventus-software-solutions/*`.
- External-publication metadata requires `license`, `repository`, and `bugs`; defer `funding` and npm provenance until they are useful and reliable.
- Defer a shared changelog format until a second package exists.
- Package verification remains package-local (`npm test`, `npm run typecheck`, `npm run build`) and may borrow AIDE testing vocabulary without mirroring the full AIDE tier stack.

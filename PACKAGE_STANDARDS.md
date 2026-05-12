# Package standards

Scope: every package under `packages/` in this repository.

## Purpose

Release and maintenance rules for `@ventus-software-solutions/*` packages so future packages inherit the same discipline instead of rediscovering it.

## Package identity

- Package names use the `@ventus-software-solutions/*` namespace and remain stable after first publication.
- Each package has a short README that explains the problem, the public API, install/build/test commands, and the current maturity level.
- Before external publication, package metadata must include `license`, `repository`, and `bugs`. `funding` is optional. npm provenance is deferred until CI supports it reliably.
- Packages stay small and dependency-light unless a dependency is core to the package's value.
- Packages must build and run with only their declared dependencies. They cannot import from sibling packages in this monorepo, nor from any host application that consumes them, unless declared as an explicit dependency.

## Versioning

- Use [SemVer](https://semver.org/).
- **Patch** — bug fixes, documentation corrections, or test-only hardening that do not change public behavior.
- **Minor** — backward-compatible API or behavior additions.
- **Major** — public API removal or rename, persistence-format incompatibility, or documented semantics changes.
- Once a package reaches `1.x`, removals follow a deprecation cycle: mark the API `@deprecated` with a replacement hint, ship one or more minor releases with visible deprecation notes, then remove in the next major release. In `0.x`, clearly documented breaking changes are sufficient.
- `package.json`, lockfile, README examples, and any design notes update together in the same version-change commit.

## Public API discipline

- Export only intentional public types and functions from the package entry point. Anything not exported from `index` is internal and may change without a version bump.
- Prefer small explicit option objects over positional parameters once an API has more than two inputs.
- Public errors should be deterministic enough for callers to handle or test.
- Do not leak internal implementation details (file layouts, internal IDs, runtime state shapes) unless they are part of the explicit package contract.
- When adding a new exported API, add at least one README example or test that demonstrates intended usage.

## Persistence and state

- Packages that write durable state must document the owning writer and the expected file format.
- Avoid multiple writers to the same file unless the package provides the merge/locking behavior itself.
- State files must remain strict JSON when documented as JSON.
- Version any durable schema once external callers could depend on it.

## Testing and verification

- Every TypeScript package provides `npm test`, `npm run typecheck`, and `npm run build` (or the pnpm equivalents).
- Package-local tests, typecheck, and build must all pass before a release commit.
- For behavior changes, add or update regression tests before calling the package reliable.
- README examples should compile conceptually against the exported API; if they drift, update them with the code.

## Release checklist

1. Confirm the package has a clear owner and purpose.
2. Update code, tests, README, design notes, and version metadata together.
3. Run package-local verification: tests, typecheck, build.
4. Inspect `git diff` for accidental credentials, logs, or scratch files before commit.
5. Commit one logical change per release with verification notes in the message.
6. Do not publish externally unless explicitly approved.

## Changelog

A shared changelog format will be defined when a second package exists. Until then, each package keeps a short design or change note when crossing a meaningful version milestone (such as `v0.2.0`).

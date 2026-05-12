# Contributing to Ventus

Thank you for considering a contribution. This monorepo houses multiple independent npm packages under the `@ventus-software-solutions` scope.

## Development setup

Requirements:

- Node.js 20 LTS or 22 LTS
- pnpm 9.x (the repo pins a version in `package.json` `packageManager` field; Corepack will pick it up automatically)

```sh
git clone https://github.com/ventus-software-solutions/ventus.git
cd ventus
corepack enable
pnpm install
pnpm test
```

## Repository layout

```
ventus/
├── packages/          # individual publishable packages
│   └── <name>/
│       ├── src/
│       ├── tests/
│       ├── package.json
│       ├── tsconfig.json
│       └── README.md
├── .changeset/        # changeset entries for pending releases
├── .github/workflows/ # CI + release automation
├── biome.json         # lint + format config
├── tsconfig.base.json # shared TypeScript config
├── turbo.json         # task orchestration
└── pnpm-workspace.yaml
```

## Making a change

1. Open an issue first for anything non-trivial. Quick fixes can go straight to a PR.
2. Fork (or branch if you have write access). Branch names: `fix/...`, `feat/...`, `chore/...`.
3. Write a test that fails before your change and passes after.
4. Run `pnpm lint`, `pnpm typecheck`, `pnpm test` locally.
5. **Add a changeset** if your change affects a published package:
   ```sh
   pnpm changeset
   ```
   Pick the affected package(s), pick the bump type (`patch` for bug fixes, `minor` for additive features, `major` for breaking changes), describe the change in user-facing terms.
6. Push and open a PR.

## Triage and review

We aim to respond to issues and PRs within 72 hours. Issues are labeled by the maintainer; please don't self-assign labels.

Some triage and review is performed autonomously by an automated assistant; responses are reviewed by a human before posting during early operation.

## Release process

Releases are automated via [Changesets](https://github.com/changesets/changesets):

1. PRs with changeset files merge into `master`.
2. A "Release PR" is auto-opened by the Changesets bot, aggregating all pending changesets with proposed version bumps.
3. Merging the Release PR triggers `pnpm changeset publish` in CI, which publishes to npm and tags the release.

No manual `npm publish` is performed from a developer machine.

## Code of conduct

Be kind, be direct, focus on the work. Personal attacks and harassment are not tolerated.

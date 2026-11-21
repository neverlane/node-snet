# changesets

add a changeset with `pnpm changeset` in every pr that changes the published package.
on release: `pnpm version-packages` bumps `package.json` + writes `CHANGELOG.md`, commit, push to master —
ci goes green → `release.yml` publishes the new version to npm and cuts a github release.

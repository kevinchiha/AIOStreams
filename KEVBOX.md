# Kevbox fork notes

This fork tracks [Viren070/AIOStreams](https://github.com/Viren070/AIOStreams) with
custom edits for a private family deployment.

## Branch model

| Branch   | Role                                                              |
| -------- | ----------------------------------------------------------------- |
| `main`   | Pristine mirror of upstream. Never commit here.                   |
| `kevbox` | `main` + custom edits. All work and deployments happen here.      |

Remotes: `origin` = kevinchiha/AIOStreams (this fork), `upstream` = Viren070/AIOStreams.

## Pulling in a new AIOStreams release

```sh
git fetch upstream --tags
git checkout kevbox
git merge v2.31.0        # merge a tagged release (stable), or upstream/main for bleeding edge
# resolve conflicts if any — should be rare, see "keeping conflicts rare" below
pnpm install && pnpm build && pnpm test
git push
```

Merging (rather than rebasing) means no force-pushes: the server/deploy can always
plain `git pull`, and each upstream sync is a single conflict-resolution pass.

Optionally keep the fork's `main` synced too (cosmetic — kevbox merges straight from
`upstream`, so this is never required):

```sh
git checkout main && git merge --ff-only upstream/main && git push origin main && git checkout kevbox
```

(or just use GitHub's "Sync fork" button.)

## Keeping conflicts rare

- Put custom code in **new files** (new middleware, new route module) wherever possible.
- Keep edits to upstream files down to a few lines (imports, route registration).
- Never reformat or restructure upstream files.

## Seeing exactly what this fork changes

```sh
git diff upstream/main...kevbox
```

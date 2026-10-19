---
name: edgegap-mcp-update
description: Change, release and ship @edgegap/mcp (this repo: the Edgegap MCP server on npm, mcp.edgegap.dev and the MCP registry) end to end from a chat request. Use whenever a maintainer asks for anything to change in "the MCP", "our MCP", "edgegap-mcp" or the hosted Edgegap connector — a new or changed tool, a fix, wording in instructions, a skills-pack sync, a dependency bump, telemetry — or asks to release, publish or ship it. Covers branch, code, tests, version bump, PR, CI, merge, the automated release and the post-release check, without asking for go-aheads.
---

# Ship a change to @edgegap/mcp

This is meant to be hands-off: the maintainer's chat message describing the change is the go-ahead to branch, commit, push, open the PR, merge it once CI is green, and let it release. Do not stop to ask "should I merge / publish?". Stop and ask only when:
- the request is ambiguous enough that two reasonable readings ship different behavior;
- the change removes or renames a tool or a tool parameter (breaks clients that pinned it);
- the change would make the hosted server log, store or forward an Edgegap API token anywhere new;
- CI or the release fails for a reason you cannot fix in the repo (missing secret, npm/Cloudflare/registry outage).

## Where things are

- Always pass `-R edgegap/edgegap-mcp` to `gh`.
- Read `DESIGN.md` before changing tool behavior; match the style of `src/` and the tests in `test/*.mjs`.
- Releases run in GitHub Actions (`.github/workflows/release.yml`) on every push to `main`. Merging a version bump IS the release: npm (trusted publishing), the Cloudflare Worker at mcp.edgegap.dev, the MCP registry entry `dev.edgegap/mcp`, tag + GitHub release, versioned Docker image. Steps already live are skipped, so a failed run can just be re-run.
- Nothing is published from a local machine.

## Steps

1. **Start clean.** `git fetch origin --prune`. If the working tree has uncommitted changes, they belong to other work: leave them and do this change in a worktree (`git worktree add ../edgegap-mcp-<slug> -b <branch> origin/main`). Otherwise `git switch -c <branch> origin/main`. Branch names: `feat/…`, `fix/…`, `chore/…`.
   Check `gh pr list -R edgegap/edgegap-mcp` for open PRs touching the same files; mention any overlap in the PR body.

2. **Make the change.** Add or update a test in `test/` that fails without it. For a skills sync: `npm run sync-skills -- --ref main` (rewrites `scripts/skills-pin.txt` and `src/skills.generated.ts`).

3. **Bump the version**: `node scripts/bump-version.mjs patch` (fixes, wording, skills sync, deps) or `minor` (new tools, new parameters, behavior changes). Bump from `origin/main`'s version even if another open PR claims the next number; whichever merges second re-bumps (step 6).

4. **Check locally** (`npm ci` first if `node_modules` is missing or the lockfile changed):
   `npm run typecheck && npm run typecheck:worker && npm run build && npm test && npm run test:worker`
   Build before testing: the tests run `dist/`.

5. **Commit, push, PR.** Subject in the repo's style: imperative, ends with the version, e.g. `Add edgegap_list_locations (0.6.0)`. Body: why, what changes for users, which test covers it. Then `git push -u origin <branch>` and
   `gh pr create -R edgegap/edgegap-mcp --base main --title "<subject>" --body-file <file>`.

6. **CI, then merge.** Run `gh pr checks <n> -R edgegap/edgegap-mcp --watch --fail-fast` in the background and wait for it. On failure read `gh run view <run> -R edgegap/edgegap-mcp --log-failed`, fix, push, repeat.
   Before merging, if `main` moved: merge `origin/main` into the branch; if `main`'s version is now ≥ yours, run `bump-version.mjs` to one above it and re-run the checks.
   Merge: `gh pr merge <n> -R edgegap/edgegap-mcp --merge --delete-branch`.

7. **Watch the release.** `gh run list -R edgegap/edgegap-mcp --workflow release.yml --commit <merge-sha> --json databaseId,status`, then `gh run watch <id> -R edgegap/edgegap-mcp --exit-status` in the background.
   On failure: `gh run view <id> -R edgegap/edgegap-mcp --log-failed`. External or flaky: `gh run rerun <id> -R edgegap/edgegap-mcp --failed`. A repo bug: fix it in a new PR with a patch bump; each release step only fills in what is missing.

8. **Confirm and report.** On an up-to-date `main`: `node scripts/release-state.mjs` must show npm, registry, hosted and tag live (exit 0). Report in a few lines: what changed, the version, the PR link, live everywhere. Existing Claude sessions cache the connector's tool list, so new tools show up after reconnecting the Edgegap connector.

## Gotchas

- The release job runs in the `release` environment, and npm's trusted publisher is bound to workflow `release.yml` + environment `release`. Renaming either breaks npm publishing.
- `CLOUDFLARE_ACCOUNT_ID` is pinned in the workflow (the Edgegap account; the Cloudflare login sees two).
- `release-state.mjs` reads the hosted version from the `initialize` response, which needs no token.

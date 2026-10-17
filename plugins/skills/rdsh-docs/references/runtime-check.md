# Spec vs runtime reconciliation

Use this when the task depends on what an installed DSH or rdsh actually
supports, not only on what a document says. The goal is a short, dated diff
between the verified baseline, the installed packages, and this host's
configuration.

Never copy credentials, tokens, authentication files, or raw environment
dumps into a record. Record names, versions, counts, and states only.

## What is safe to record

| Fact | Command | Record only |
| --- | --- | --- |
| Installed DSH | `dsh --version` | The version string |
| Installed rdsh | `rdsh --version` | The version string |
| Published DSH | `npm view @deepseek-ai/dsh@latest version` | The version string |
| Profile names | `rdsh profiles` | Directory names, and that this is not the active profile |
| Skill names | `rdsh skills` | Directory names, and that this does not prove model visibility |
| Feature switches | `rdsh features --json` | `id`, `enabled`, `default`, `explicit`, `summary` |
| Catalog sync state | `rdsh models` | Per profile and provider: up to date, skipped, or the reason |
| Route and key state | `rdsh provider list --json` | Route ids, `apiKeyEnv` names, `key` state, model counts |
| Host summary | `rdsh doctor` | The summary lines alone |

`rdsh doctor` reads authentication state on its current path. Run it only
when the task authorizes that read, and record the summary rather than the
raw output. Do not use the delegated `rdsh dump-config` as a routine probe:
it emits a broad effective configuration and calls the authentication sync.
Never read or quote `.credentials.yaml`, provider keys, or token caches.

## Measured baseline

Checked 2026-10-17 on one Linux host with `rdsh 0.7.0` at `/usr/bin/rdsh`
and `dsh 0.2.0-rc.2`. Treat this as an observation of that host, not as a
claim about another install.

| Fact | Observed |
| --- | --- |
| `dsh --version` | `0.2.0-rc.2` |
| `npm view @deepseek-ai/dsh@latest version` | `0.2.0-rc.2` |
| `rdsh --version` | `rdsh 0.7.0` |
| `rdsh profiles` | `headless`, `migration`, `sdk`, `tui`, `web` (5 profiles) |
| `rdsh skills` | Directory names only; no frontmatter or load check |
| `rdsh features --json` | `config` plus `features[]` with `id`, `enabled`, `default`, `explicit`, `summary` |
| `rdsh models` | `openai-codex` up to date (9 listed) on `headless`, `migration`, `sdk`; `openai-codex` and `kimi-coding` skipped on `tui` and `web` as "unsupported inline or aliased mapping" |
| `rdsh provider list --json` | `schema: 1`; presets `hai`, `local-openai`, `sarashina`; `headless` also reports a configured `opencode-free` route with `key: present`; `migration`, `sdk`, `tui`, `web` report only the presets |
| `rdsh doctor` | `dsh` 0.2.0-rc.2, Node 22.x, 5 local profiles, desktop app not found, Fedora optional tools present, authentication summary only |

The last two rows are the kind of mismatch this procedure exists to catch:
a profile can declare routes that the native readers do not list, so
"not listed" must not be reported as "not configured".

## Procedure

1. Read `dsh --version` and `rdsh --version`, and note the host.
2. Compare them with the verified baseline in
   [the source index](source-index.md). If they differ, the baseline's
   statements are no longer presumed to hold.
3. Pick the authority for each claim, in this order:
   the installed package's own documentation or source for that exact
   version; then the version-pinned upstream tag for DSH; then this
   repository's implementation and tests for rdsh. Treat upstream `main`
   as possibly ahead of the installed version, not as the installed version.
4. Classify each claim as documented, configured, succeeded, or unknown.
5. Record a diff row for every mismatch: the claim, its source, the runtime
   observation, the classification, and the effect on the task. Do not
   resolve a mismatch by assuming the newer document is already installed.
6. When versions or configuration change, repeat from step 1 and update the
   measured baseline.

## Recorded mismatches

Checked 2026-10-17:

- The original skill baseline named only the DSH version. The installed
  rdsh version is now recorded above.
- `rdsh models` reports `skipped: the patch entry uses an unsupported inline
  or aliased mapping` for `tui` and `web` even though `web` declares
  provider model lists, so a skip is not evidence that no models are declared.
- `rdsh provider list --json` lists configured non-preset routes for
  `headless` but not for `web`. Use it with `rdsh models` and the profile's
  own `cordis.patch.yml` before concluding that a route is absent.

---
'@polyrouter/frontend': patch
---

Release images are now built on native runners per architecture instead of emulating
arm64, so a release publishes reliably. The `linux/arm64` half of every image used to be
cross-built under QEMU, which is a nondeterministic-failure generator: it broke two of the
last three releases by crashing with `qemu: uncaught target signal 4 (Illegal instruction)`
inside `npm ci` and then **wedging** — the build never failed, it emitted progress
heartbeats for 88 more minutes until the job timeout killed it. v0.9.1 shipped half a
release because of it: the `-semantic` variant published while the baseline did not, leaving
`latest` pointing at 0.9.0 for two hours.

Each architecture now builds on its own native runner, pushes an untagged digest, and a
merge job assembles the manifest list — so tagging happens once, at the end, and no
architecture can clobber another's `latest`. The published contract is unchanged: same
tags, same two platforms (`linux/amd64` + `linux/arm64`), same plain manifest list with no
attestation entries. The `-semantic` variant's ORT smoke test is strictly stronger now,
because it exercises the real arm64 kernel dispatch on real hardware rather than validating
QEMU's softfloat.

Measured on the first native run, all caches cold: the arm64 leg that used to wedge for 88
minutes finished in 1m45s, and the entire release — both variants — took 3m40s against
20m42s on the best previous run.

Also fixed: every image's `org.opencontainers.image.licenses` **annotation** reported the
deprecated `AGPL-3.0` while its **label** correctly said `AGPL-3.0-only`. A custom label
does not propagate to annotations in `docker/metadata-action`; both lists now carry the
same value.

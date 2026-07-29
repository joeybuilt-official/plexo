# Licensing

Plexo is licensed under the [MIT License](LICENSE).

Copyright is held by **Joeybuilt LLC**.

## The one exception: `apps/gmessages`

The `apps/gmessages` subtree is licensed under the **GNU Affero General Public
License v3.0 (AGPL-3.0-only)**, not MIT. It statically links
[`go.mau.fi/mautrix-gmessages`](https://github.com/mautrix/gmessages), which is
AGPL-3.0; that copyleft extends to the linked work. The subtree carries its own
[LICENSE](apps/gmessages/LICENSE) and every file in it retains an AGPL-3.0
SPDX header. If you distribute `apps/gmessages` (or a derivative), or offer it
as a network service, AGPL-3.0's Section 13 source-disclosure obligation applies
to that component.

Everything else in this repository is MIT: use, modify, and distribute freely,
provided the copyright notice and permission notice are retained.

## Contributions

By submitting a pull request you license your contribution under the same terms
as the file(s) you change — MIT for the repository at large, AGPL-3.0 for
`apps/gmessages`. Contributions are accepted under the
[Developer Certificate of Origin](https://developercertificate.org/); add a
`Signed-off-by` line with `git commit -s`.

## Joeybuilt Managed Service

Joeybuilt operates a managed SaaS instance of Plexo from a separate private
codebase. That overlay is not part of this repository.

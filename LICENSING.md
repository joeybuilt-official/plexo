# Licensing

Plexo is licensed under the [MIT License](LICENSE).

Copyright is held by **Joeybuilt LLC**.

The entire repository — every app, package, extension, and service — is MIT.
There is no copyleft subtree and no dual-licensing arrangement. Use, modify, and
distribute freely, provided the copyright notice and permission notice are
retained.

## Do not introduce copyleft dependencies

MIT is only meaningful if the tree stays MIT. Do not add a GPL- or
AGPL-licensed dependency to any package here, whether as a direct dependency, a
transitive one you pin, or vendored source. Copyleft terms propagate into the
combined work and would silently strip downstream users of the permissive
license this repository promises. If a dependency you need is copyleft-licensed,
raise it in a discussion or PR before adding it — a permissive alternative, an
optional out-of-process integration, or an explicit decision to restructure is
almost always available.

## Former AGPL subtree (removed)

This repository once carried an AGPL-3.0-only subtree at `apps/gmessages`, a Go
sidecar wrapping [mautrix-gmessages](https://github.com/mautrix/gmessages)
(itself AGPL-3.0) as a phone-text connector. That subtree was deleted in
`716234ed` and is not part of the published tree; nothing in this repository is
AGPL-licensed today. Older releases and the CHANGELOG describe it, and those
historical entries are accurate for their time.

If a future AGPL component is genuinely wanted, it must not live in this tree.
Ship it in a separate repository, or a clearly separated subtree with its own
`LICENSE` and SPDX headers, and keep the MIT tree linking to it as an optional
external service rather than building against it. An optional integration an
operator may run does not taint the MIT codebase; a linked copyleft component
does.

## Contributions

By submitting a pull request you license your contribution under the same terms
as the file(s) you change — MIT throughout. Contributions are accepted under the
[Developer Certificate of Origin](https://developercertificate.org/); add a
`Signed-off-by` line with `git commit -s`.

## Joeybuilt Managed Service

Joeybuilt previously operated a managed SaaS instance of Plexo from a separate
private codebase. That overlay is not part of this repository, and the managed
service is no longer running. This repository is self-host only.

"""RediSearch group_id escape patch for graphiti-core==0.29.0 (PINNED).

WHY
    graphiti-core builds a RediSearch fulltext query that injects the raw,
    hyphenated workspace-UUID group_id into the query string. RediSearch parses
    '-' as a negation operator -> "RediSearch: Syntax error ... near <uuid8>" ->
    every /v1/search 500s -> ALL Graphiti recall (lessons + memory) is dead.
    (Prod log: /v1/search 24x 200 vs 539x 500.)

WHAT
    graphiti-core 0.29.0 has TWO fulltext-query builders, both with the same
    unescaped bug. The RUNTIME path is FalkorDriver.build_fulltext_query
    (search_utils.fulltext_query -> driver.build_fulltext_query); the other,
    search_ops._build_falkor_fulltext_query, is patched defensively. Both are
    wrapped to backslash-escape '-'/'\' in group_ids ONLY for the fulltext
    query string. Callers keep passing RAW group_ids to the cypher
    `group_id IN $group_ids` param, which is param-bound and REQUIRES the raw
    value (escaping it returns 0 hits; verified empirically against FalkorDB).

CLOBBER RISK  (see services/graphiti-sidecar/requirements.txt pin)
    Reaches into vendored graphiti_core internals; valid ONLY for
    graphiti-core==0.29.0. Asserts both targets exist and logs the running
    version loudly so a bump cannot land silently. Upstream PR + bump tracked
    under Phase 11; remove this module when the fix lands upstream.
"""

import logging
from importlib.metadata import PackageNotFoundError
from importlib.metadata import version as _pkg_version

from graphiti_core.driver import falkordb_driver as _fd
from graphiti_core.driver.falkordb.operations import search_ops as _so

logger = logging.getLogger("plexo-graphiti")

_EXPECTED_VERSION = "0.29.0"
try:
    _actual_version = _pkg_version("graphiti-core")
except PackageNotFoundError:
    _actual_version = "unknown"

_missing = [
    name
    for name, present in (
        ("FalkorDriver.build_fulltext_query", hasattr(_fd.FalkorDriver, "build_fulltext_query")),
        ("search_ops._build_falkor_fulltext_query", hasattr(_so, "_build_falkor_fulltext_query")),
    )
    if not present
]
if _missing:
    raise RuntimeError(
        f"redisearch_groupid_patch: vendored target(s) missing {_missing} "
        f"(graphiti-core=={_actual_version}). Internals changed — re-validate BEFORE deploy."
    )

if _actual_version != _EXPECTED_VERSION:
    logger.error(
        "redisearch_groupid_patch: graphiti-core==%s but patch validated for ==%s — "
        "CLOBBER RISK, re-validate group_id escaping before trusting recall.",
        _actual_version,
        _EXPECTED_VERSION,
    )


def _escape_group_id(value: str) -> str:
    # validate_group_id() restricts group_ids to [A-Za-z0-9_-]; only '-' (and a
    # defensive '\') are RediSearch-special. Backslash-escape so the fulltext
    # query parses instead of reading '-' as a negation operator.
    return value.replace("\\", "\\\\").replace("-", "\\-")


def _escape_in_query(built: str, group_ids) -> str:
    # POST-process: the builders run validate_group_id() (which rejects '\'),
    # so we cannot pre-escape the inputs. Instead let the builder run with RAW
    # group_ids, then escape each group_id value inside the returned RediSearch
    # string. Only the quoted group_id token (`"<uuid>"`) is rewritten; the
    # query-text portion never contains the UUID so it is untouched.
    if not built or not group_ids:
        return built
    for gid in group_ids:
        built = built.replace(f'"{gid}"', f'"{_escape_group_id(gid)}"')
    return built


# --- primary: the RUNTIME builder (FalkorDriver.build_fulltext_query) ---
_orig_driver_build = _fd.FalkorDriver.build_fulltext_query


def _patched_driver_build(self, query, group_ids=None, max_query_length=128):
    return _escape_in_query(_orig_driver_build(self, query, group_ids, max_query_length), group_ids)


if getattr(_fd.FalkorDriver.build_fulltext_query, "__name__", "") != "_patched_driver_build":
    _fd.FalkorDriver.build_fulltext_query = _patched_driver_build

# --- defensive: the module-level builder (search_ops._build_falkor_fulltext_query) ---
_orig_so_build = _so._build_falkor_fulltext_query


def _patched_so_build(query, group_ids=None, max_query_length=_so.MAX_QUERY_LENGTH):
    return _escape_in_query(_orig_so_build(query, group_ids, max_query_length), group_ids)


if getattr(_so._build_falkor_fulltext_query, "__name__", "") != "_patched_so_build":
    _so._build_falkor_fulltext_query = _patched_so_build

logger.info(
    "redisearch_groupid_patch: applied to FalkorDriver.build_fulltext_query + "
    "search_ops._build_falkor_fulltext_query (graphiti-core==%s)",
    _actual_version,
)

"""RediSearch group_id escape patch for graphiti-core==0.29.0 (PINNED).

WHY
    graphiti_core.driver.falkordb.operations.search_ops._build_falkor_fulltext_query
    injects the raw group_id (a hyphenated workspace UUID) into a RediSearch fulltext
    query. RediSearch parses '-' as a negation operator -> "RediSearch: Syntax error
    ... near <uuid8>" -> every /v1/search returns 500 -> ALL Graphiti recall (lessons
    + memory) is dead. (Prod log: /v1/search 24x 200 vs 539x 500.)

WHAT
    Wrap _build_falkor_fulltext_query so group_ids are backslash-escaped ONLY when
    building the RediSearch query string. The callers (node_fulltext_search /
    edge_fulltext_search) keep passing the RAW group_ids to the cypher
    `n.group_id IN $group_ids` param — param binding is safe and REQUIRES the raw
    value (escaping it returns 0 hits; proven empirically against FalkorDB).

CLOBBER RISK  (see services/graphiti-sidecar/requirements.txt pin)
    This reaches into vendored graphiti_core internals. It is valid ONLY for
    graphiti-core==0.29.0. If the pin is bumped this module asserts the target still
    exists and logs the running version loudly so the change cannot land silently.
    Upstream fix + version bump tracked under Phase 11; remove this module when the
    fix lands upstream.
"""

import logging
from importlib.metadata import PackageNotFoundError
from importlib.metadata import version as _pkg_version

from graphiti_core.driver.falkordb.operations import search_ops as _so

logger = logging.getLogger("plexo-graphiti")

_EXPECTED_VERSION = "0.29.0"
try:
    _actual_version = _pkg_version("graphiti-core")
except PackageNotFoundError:
    _actual_version = "unknown"

if not hasattr(_so, "_build_falkor_fulltext_query"):
    raise RuntimeError(
        "redisearch_groupid_patch: search_ops._build_falkor_fulltext_query is missing "
        f"(graphiti-core=={_actual_version}). Vendored internals changed — re-validate "
        "the group_id escape fix BEFORE deploy."
    )

if _actual_version != _EXPECTED_VERSION:
    logger.error(
        "redisearch_groupid_patch: graphiti-core==%s but patch validated for ==%s — "
        "CLOBBER RISK, re-validate group_id escaping before trusting recall.",
        _actual_version,
        _EXPECTED_VERSION,
    )

_orig_build_falkor_fulltext_query = _so._build_falkor_fulltext_query


def _escape_group_id(value: str) -> str:
    # validate_group_id() restricts group_ids to [A-Za-z0-9_-]; only '-' (and a
    # defensive '\') are RediSearch-special. Backslash-escape so the fulltext query
    # parses instead of reading '-' as a negation operator.
    return value.replace("\\", "\\\\").replace("-", "\\-")


def _patched_build_falkor_fulltext_query(query, group_ids=None, max_query_length=_so.MAX_QUERY_LENGTH):
    safe_group_ids = [_escape_group_id(g) for g in group_ids] if group_ids else group_ids
    return _orig_build_falkor_fulltext_query(query, safe_group_ids, max_query_length)


if getattr(_so._build_falkor_fulltext_query, "__name__", "") != "_patched_build_falkor_fulltext_query":
    _so._build_falkor_fulltext_query = _patched_build_falkor_fulltext_query
    logger.info(
        "redisearch_groupid_patch: applied (graphiti-core==%s) — group_id escaped for RediSearch fulltext",
        _actual_version,
    )

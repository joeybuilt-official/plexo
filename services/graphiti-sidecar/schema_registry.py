# SPDX-License-Identifier: MIT
# Copyright (C) 2026 Joeybuilt LLC

"""
Phase F per-app schema registry (ADR 0029, addresses ADR 0016 Failure B).

Loads YAML schema files from `schemas/<app>.yaml` at module import. Exposes
validate(app, label, properties) so the sidecar's write paths can check
every node/edge against the registered shape BEFORE acquiring the heavy
per-workspace lock.

Default behavior (STRICT_SCHEMA env var, default "false"):
- false: unknown app, unknown label, unknown property, OR missing required
  property — log a warning and ALLOW the write (rollout-safe). The nightly
  cardinality report surfaces unregistered labels so we can register them
  before flipping the flag.
- true: same conditions raise ValidationError. Upstream code (main.py)
  translates this into HTTPException(422).

Both registered_apps() and registered_labels(app) are exported so tooling
(e.g., scripts/cardinality_report.py) can diff observed vs registered
without re-parsing YAML.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

logger = logging.getLogger("plexo-graphiti.schema")


SCHEMA_DIR = Path(__file__).resolve().parent / "schemas"


def _truthy(value: str | None) -> bool:
    return (value or "").strip().lower() in {"1", "true", "yes", "on"}


def _strict_default() -> bool:
    return _truthy(os.environ.get("STRICT_SCHEMA"))


class ValidationError(Exception):
    """Raised when STRICT_SCHEMA=true and a write violates the registry."""


@dataclass(frozen=True)
class LabelSchema:
    required: tuple[str, ...] = ()
    optional: tuple[str, ...] = ()

    @property
    def allowed(self) -> set[str]:
        return set(self.required) | set(self.optional)


@dataclass(frozen=True)
class EdgeSchema:
    from_label: str
    to_label: str
    props: tuple[str, ...] = ()


@dataclass(frozen=True)
class AppSchema:
    app: str
    graph_template: str
    node_labels: dict[str, LabelSchema] = field(default_factory=dict)
    edge_types: dict[str, EdgeSchema] = field(default_factory=dict)
    predicate_vocabulary: tuple[str, ...] = ()


def _coerce_label_schema(raw: dict[str, Any] | None) -> LabelSchema:
    raw = raw or {}
    return LabelSchema(
        required=tuple(raw.get("required") or ()),
        optional=tuple(raw.get("optional") or ()),
    )


def _coerce_edge_schema(raw: dict[str, Any]) -> EdgeSchema:
    return EdgeSchema(
        from_label=str(raw.get("from", "")),
        to_label=str(raw.get("to", "")),
        props=tuple(raw.get("props") or ()),
    )


def _load_app_schema(path: Path) -> AppSchema:
    with path.open("r", encoding="utf-8") as fh:
        data = yaml.safe_load(fh) or {}
    app = str(data.get("app") or path.stem)
    return AppSchema(
        app=app,
        graph_template=str(data.get("graph_template", f"{app}:<workspace_id>")),
        node_labels={
            str(name): _coerce_label_schema(spec)
            for name, spec in (data.get("node_labels") or {}).items()
        },
        edge_types={
            str(name): _coerce_edge_schema(spec or {})
            for name, spec in (data.get("edge_types") or {}).items()
        },
        predicate_vocabulary=tuple(data.get("predicate_vocabulary") or ()),
    )


def _load_all(schema_dir: Path = SCHEMA_DIR) -> dict[str, AppSchema]:
    registry: dict[str, AppSchema] = {}
    if not schema_dir.is_dir():
        logger.warning("schema.dir_missing dir=%s", schema_dir)
        return registry
    for path in sorted(schema_dir.glob("*.yaml")):
        try:
            schema = _load_app_schema(path)
        except Exception as e:  # noqa: BLE001 — surface but don't crash import
            logger.error("schema.load_failed path=%s err=%s", path, e)
            continue
        registry[schema.app] = schema
    return registry


_REGISTRY: dict[str, AppSchema] = _load_all()


def reload(schema_dir: Path = SCHEMA_DIR) -> None:
    """Re-read YAML files. Test fixtures use this; production reloads on
    container restart only."""
    global _REGISTRY
    _REGISTRY = _load_all(schema_dir)


def registered_apps() -> list[str]:
    return sorted(_REGISTRY.keys())


def registered_labels(app: str) -> list[str]:
    spec = _REGISTRY.get(app)
    if spec is None:
        return []
    return sorted(spec.node_labels.keys())


def registered_edge_types(app: str) -> list[str]:
    spec = _REGISTRY.get(app)
    if spec is None:
        return []
    return sorted(spec.edge_types.keys())


def graph_name(app: str, workspace_id: str) -> str:
    """Resolve the FalkorDB Cypher graph name for an (app, workspace_id) pair.

    Default convention is "<app>:<workspace_id>". App-level schemas may set a
    different template; the literal "<workspace_id>" token gets substituted.
    Apps not in the registry fall back to plexo's bare-workspace convention
    so back-compat callers (the legacy plexo writes that name graphs by
    workspace_id alone) still resolve.
    """
    spec = _REGISTRY.get(app)
    if spec is None:
        return workspace_id
    template = spec.graph_template or f"{app}:<workspace_id>"
    return template.replace("<workspace_id>", workspace_id)


def validate(
    app: str,
    label: str,
    properties: dict[str, Any] | None,
    *,
    strict: bool | None = None,
) -> None:
    """Check a node-write against the registered schema for `app`.

    Behavior matrix:
    - app not registered → warn (allow) | raise (strict)
    - label not registered → warn (allow) | raise (strict)
    - required property missing → warn (allow) | raise (strict)
    - unknown property key → warn (allow) | raise (strict)
    - everything OK → no-op

    `properties` is the merged attribute dict (graphiti-side `attributes`
    + any top-level fields that become node columns). Pass an empty dict
    if the caller has none.
    """
    if strict is None:
        strict = _strict_default()
    props = dict(properties or {})

    spec = _REGISTRY.get(app)
    if spec is None:
        return _report(
            strict,
            "schema.unknown_app",
            f"app '{app}' has no registered schema",
            app=app,
            label=label,
        )

    label_spec = spec.node_labels.get(label)
    if label_spec is None:
        return _report(
            strict,
            "schema.unknown_label",
            f"app '{app}' has no registered label '{label}'",
            app=app,
            label=label,
        )

    missing = [k for k in label_spec.required if k not in props]
    if missing:
        return _report(
            strict,
            "schema.missing_required",
            f"app '{app}' label '{label}' missing required props: {sorted(missing)}",
            app=app,
            label=label,
            missing=missing,
        )

    allowed = label_spec.allowed
    extra = [k for k in props.keys() if k not in allowed]
    if extra:
        return _report(
            strict,
            "schema.unknown_property",
            f"app '{app}' label '{label}' has unregistered props: {sorted(extra)}",
            app=app,
            label=label,
            extra=extra,
        )


def validate_edge(
    app: str,
    edge_type: str,
    *,
    from_label: str | None = None,
    to_label: str | None = None,
    properties: dict[str, Any] | None = None,
    strict: bool | None = None,
) -> None:
    """Check an edge-write against the registered schema.

    Edge endpoints are optional — many call sites construct edges from
    EntityNodes whose .labels list is already validated by validate(). Pass
    from_label/to_label only when you want endpoint shape enforced.
    """
    if strict is None:
        strict = _strict_default()
    props = dict(properties or {})

    spec = _REGISTRY.get(app)
    if spec is None:
        return _report(
            strict,
            "schema.unknown_app",
            f"app '{app}' has no registered schema",
            app=app,
            edge_type=edge_type,
        )

    edge_spec = spec.edge_types.get(edge_type)
    if edge_spec is None:
        return _report(
            strict,
            "schema.unknown_edge_type",
            f"app '{app}' has no registered edge type '{edge_type}'",
            app=app,
            edge_type=edge_type,
        )

    if from_label is not None and edge_spec.from_label and from_label != edge_spec.from_label:
        return _report(
            strict,
            "schema.edge_from_mismatch",
            f"edge '{edge_type}' expects from={edge_spec.from_label}, got {from_label}",
            app=app,
            edge_type=edge_type,
        )

    if to_label is not None and edge_spec.to_label and to_label != edge_spec.to_label:
        return _report(
            strict,
            "schema.edge_to_mismatch",
            f"edge '{edge_type}' expects to={edge_spec.to_label}, got {to_label}",
            app=app,
            edge_type=edge_type,
        )

    if edge_spec.props:
        allowed = set(edge_spec.props)
        extra = [k for k in props.keys() if k not in allowed]
        if extra:
            return _report(
                strict,
                "schema.unknown_edge_property",
                f"edge '{edge_type}' has unregistered props: {sorted(extra)}",
                app=app,
                edge_type=edge_type,
                extra=extra,
            )


def _report(strict: bool, event: str, message: str, **fields: Any) -> None:
    if strict:
        raise ValidationError(message)
    logger.warning("%s %s", event, message, extra={"schema_event": event, **fields})

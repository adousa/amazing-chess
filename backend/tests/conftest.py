"""Shared fixtures: temp game store, placeholder engine, short move time, contract validator."""
from __future__ import annotations

import pathlib
import shutil
from typing import Any, List

import pytest
import yaml
from jsonschema import Draft202012Validator
from referencing import Registry, Resource

REPO = pathlib.Path(__file__).resolve().parents[2]
SPEC = yaml.safe_load((REPO / "contracts" / "openapi.yaml").read_text())
REGISTRY = Registry().with_resource("urn:api", Resource.opaque(SPEC))

# Back-rank mate in one for the side to move: our engine (white) plays Ra8#.
MATE_IN_ONE_WHITE = "6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1"


def contract_errors(instance: Any, component: str, array: bool = False) -> List[str]:
    ref = {"$ref": f"urn:api#/components/schemas/{component}"}
    schema = {"type": "array", "items": ref} if array else ref
    v = Draft202012Validator(schema, registry=REGISTRY)
    return [f"{'/'.join(map(str, e.path)) or '<root>'}: {e.message}" for e in v.iter_errors(instance)]


def assert_contract(instance: Any, component: str, array: bool = False) -> None:
    errs = contract_errors(instance, component, array)
    assert not errs, f"{component} contract violations:\n" + "\n".join(errs)


@pytest.fixture(scope="session", autouse=True)
def _need_stockfish():
    if not shutil.which("stockfish"):
        pytest.skip("stockfish binary not on PATH", allow_module_level=True)


@pytest.fixture
def env(tmp_path, monkeypatch):
    """Isolated settings: temp games dir, placeholder engine, 300 ms/move, no Claude agents."""
    games = tmp_path / "games"
    monkeypatch.setenv("AC_GAMES_DIR", str(games))
    monkeypatch.setenv("AC_ENGINE_PATH", "python -m amazing.placeholder_engine")
    monkeypatch.setenv("AC_MOVE_TIME_MS", "300")
    monkeypatch.setenv("AC_ANALYSIS_DEPTH", "6")
    monkeypatch.setenv("AC_AGENTS", "0")
    monkeypatch.setenv("AC_PARALLEL", "2")
    return games


def settings_with(**env_overrides):
    import os

    from amazing.config import load_settings

    old = {k: os.environ.get(k) for k in env_overrides}
    try:
        os.environ.update({k: str(v) for k, v in env_overrides.items()})
        return load_settings()
    finally:
        for k, v in old.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

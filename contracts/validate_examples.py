"""Validate contracts/examples/*.json (and events.sse) against contracts/openapi.yaml.

Run: pip install jsonschema pyyaml && python contracts/validate_examples.py
"""
import json
import pathlib
import sys

import yaml
from jsonschema import Draft202012Validator
from referencing import Registry, Resource

ROOT = pathlib.Path(__file__).parent
spec = yaml.safe_load((ROOT / "openapi.yaml").read_text())
registry = Registry().with_resource("urn:api", Resource.opaque(spec))

# example file -> schema (a component name, or ("array", component))
EXAMPLES = {
    "match.json": "Match",
    "match-page.json": "MatchPage",
    "analysis.json": "Analysis",
    "ladder.json": "Ladder",
    "stats.json": "Stats",
    "create-match-request.json": "CreateMatchRequest",
}


def validator(component: str) -> Draft202012Validator:
    schema = {"$ref": f"urn:api#/components/schemas/{component}"}
    return Draft202012Validator(schema, registry=registry)


def check(name: str, instance, component: str) -> int:
    errors = sorted(validator(component).iter_errors(instance), key=lambda e: list(e.path))
    for err in errors:
        print(f"✗ {name}: {'/'.join(map(str, err.path)) or '<root>'}: {err.message}")
    return len(errors)


failures = 0
for file, component in EXAMPLES.items():
    failures += check(file, json.loads((ROOT / "examples" / file).read_text()), component)

for block in (ROOT / "examples" / "events.sse").read_text().strip().split("\n\n"):
    data = next(line[6:] for line in block.splitlines() if line.startswith("data: "))
    event = json.loads(data)
    failures += check(f"events.sse seq={event['seq']}", event, "MatchEvent")

if failures:
    sys.exit(f"{failures} contract violation(s)")
print("✓ all examples match the contract")

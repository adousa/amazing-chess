"""Stand-in for the `claude` CLI in tests: behaves like `/analyze-game <id> --agents-only` by
saving one report per agent through the real scripts/save_agent_report.py."""
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import time

repo = pathlib.Path(__file__).resolve().parents[2]
prompt = sys.argv[sys.argv.index("-p") + 1]
match_id = prompt.split()[1]
assert "--agents-only" in prompt and "bypassPermissions" in sys.argv
agents = ["gm-coach"] if os.environ.get("FAKE_CLAUDE_ONLY_GM") else ["gm-coach", "engine-dev"]
for agent in agents:
    report = {"summary": f"{agent} says hi", "keyMoments": [{"ply": 1, "comment": "first move"}],
              "suggestions": [{"title": "Do better", "detail": "Concrete thing", "priority": "high",
                               "category": "search" if agent == "engine-dev" else "opening",
                               "relatedPlies": [1]}]}
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as fh:
        json.dump(report, fh)
    subprocess.run([sys.executable, str(repo / "scripts" / "save_agent_report.py"), match_id, agent, fh.name],
                   check=True)
    time.sleep(1.6)  # let the backend's watcher see the intermediate state
print("fake claude done")

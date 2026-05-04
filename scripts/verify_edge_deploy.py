#!/usr/bin/env python3
"""
Byte-exact verification that a deployed Supabase edge function matches local
source. Reads the saved get_edge_function output, compares each runtime file
against the local repo, and prints a pass/fail report.

Usage:
    python3 scripts/verify_edge_deploy.py <function_name> <get_edge_function_output_json>

Example:
    python3 scripts/verify_edge_deploy.py fetch-ehr-data /tmp/deployed_v70.json

The deployed bundle paths look like:
    user_fn_<project>_<id>_<version>/source/index.ts
    user_fn_<project>_<id>_<version>/source/adapters/duke.ts
    user_fn_<project>_<id>_<version>/_shared/cors.ts

Type-only imports (`import type {…}`) get tree-shaken by Deno's bundler, so a
local _shared file that's referenced only via `import type` is allowed to be
absent from the deployed bundle. This script reports "tree-shaken (OK)" in
that case rather than failing.

Exit code: 0 on full match (including allowed tree-shake), 1 on any real
mismatch.
"""

import hashlib
import json
import re
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parent.parent
FUNCTIONS_DIR = REPO_ROOT / "supabase" / "functions"

# Match `import type {…} from "...path..."` — type-only imports
TYPE_IMPORT_RE = re.compile(
    r'''import\s+type\s*\{[^}]*\}\s*from\s+["']([^"']+)["']''',
)
# Match runtime imports (with `from` keyword)
RUNTIME_IMPORT_RE = re.compile(
    r'''import\s+(?!type\s)[^;]*?from\s+["']([^"']+)["']''',
)
# Side-effect imports: `import "./foo.ts";`
SIDE_EFFECT_IMPORT_RE = re.compile(
    r'''import\s+["']([^"']+)["']''',
)


def sha256_short(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()[:16]


def find_local_for_deployed(deployed_name: str, function_name: str) -> Path | None:
    """Map a deployed bundle path to its local source path."""
    # Common deployed path forms:
    #   user_fn_…_<v>/source/index.ts            -> functions/<fn>/index.ts
    #   user_fn_…_<v>/source/adapters/duke.ts    -> functions/<fn>/adapters/duke.ts
    #   user_fn_…_<v>/_shared/cors.ts            -> functions/_shared/cors.ts
    # Also: simpler forms used by some deploys:
    #   functions/<fn>/index.ts
    #   functions/_shared/cors.ts
    name = deployed_name
    if "/source/" in name:
        rel = name.split("/source/", 1)[1]
        return FUNCTIONS_DIR / function_name / rel
    if "/_shared/" in name:
        rel = name.split("/_shared/", 1)[1]
        return FUNCTIONS_DIR / "_shared" / rel
    if name.startswith("functions/_shared/"):
        return FUNCTIONS_DIR / name.removeprefix("functions/_shared/").removeprefix("_shared/")
    if name.startswith(f"functions/{function_name}/"):
        rel = name.removeprefix(f"functions/{function_name}/")
        return FUNCTIONS_DIR / function_name / rel
    return None


def collect_local_inventory(function_name: str) -> tuple[set[str], dict[str, set[Path]]]:
    """Return (all_runtime_local_files, type_only_referenced)."""
    fn_dir = FUNCTIONS_DIR / function_name
    if not fn_dir.is_dir():
        sys.exit(f"ERROR: function folder not found: {fn_dir}")

    runtime: set[Path] = set()
    type_only_refs: set[Path] = set()

    # Add every non-test .ts inside the function folder as runtime
    for p in fn_dir.rglob("*.ts"):
        if not p.name.endswith(".test.ts"):
            runtime.add(p.resolve())

    # Walk imports to find _shared/*.ts split by import kind
    for p in list(runtime):
        text = p.read_text(encoding="utf-8")
        for m in TYPE_IMPORT_RE.findall(text):
            sm = re.search(r"_shared/([^/'\"]+\.ts)", m)
            if sm:
                type_only_refs.add((FUNCTIONS_DIR / "_shared" / sm.group(1)).resolve())
        for m in RUNTIME_IMPORT_RE.findall(text) + SIDE_EFFECT_IMPORT_RE.findall(text):
            sm = re.search(r"_shared/([^/'\"]+\.ts)", m)
            if sm:
                runtime.add((FUNCTIONS_DIR / "_shared" / sm.group(1)).resolve())

    # Anything that's both runtime and type-only — runtime wins
    type_only_refs -= runtime

    return ({str(p) for p in runtime}, type_only_refs)


def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    function_name = sys.argv[1]
    deployed_json = Path(sys.argv[2])

    if not deployed_json.exists():
        sys.exit(f"ERROR: file not found: {deployed_json}")

    data = json.loads(deployed_json.read_text(encoding="utf-8"))
    # Some saved files wrap in {"result": …}, some don't
    if "files" not in data and "result" in data and isinstance(data["result"], dict):
        data = data["result"]
    files = data.get("files", [])
    version = data.get("version", "?")

    if not files:
        sys.exit(f"ERROR: no 'files' in {deployed_json}")

    runtime_local, type_only_refs = collect_local_inventory(function_name)
    print(f"\n=== Verifying deployed {function_name} v{version} vs local ===\n")
    print(f"  Local runtime .ts files: {len(runtime_local)}")
    print(f"  Local type-only _shared refs (allowed to tree-shake): {len(type_only_refs)}\n")

    passes = 0
    fails: list[str] = []
    seen_local: set[str] = set()

    print(f"{'deployed file':<70} {'chars':>7}  {'check':<8}")
    print("-" * 95)
    for f in files:
        name = f["name"]
        content = f["content"]
        local_path = find_local_for_deployed(name, function_name)

        if not local_path or not local_path.exists():
            label = "ORPHAN"
            fails.append(f"{name}: no matching local file")
            print(f"  {name:<68} {len(content):>7}  {label}")
            continue

        local_text = local_path.read_text(encoding="utf-8")
        seen_local.add(str(local_path.resolve()))

        if local_text == content:
            passes += 1
            label = "OK"
        else:
            fails.append(
                f"{name}: local {len(local_text)} chars / sha {sha256_short(local_text)} "
                f"vs deployed {len(content)} chars / sha {sha256_short(content)}"
            )
            label = "MISMATCH"
        print(f"  {name:<68} {len(content):>7}  {label}")

    # Files in local runtime that DIDN'T appear in deployed
    missing = runtime_local - seen_local
    # Allowed: type-only-only files that bundler stripped
    type_only_paths = {str(p) for p in type_only_refs}
    truly_missing = missing - type_only_paths
    tree_shaken = missing & type_only_paths

    print()
    if tree_shaken:
        for p in sorted(tree_shaken):
            print(f"  • tree-shaken (OK): {p}")
    if truly_missing:
        for p in sorted(truly_missing):
            print(f"  ✗ MISSING in deployed bundle: {p}")
            fails.append(f"missing in deployed: {p}")

    print()
    print(f"  Passes: {passes}/{len(files)}  Failures: {len(fails)}")
    if fails:
        print("\n=== FAILURES ===")
        for f in fails:
            print(f"  - {f}")
        sys.exit(1)
    print("\n✓ Deploy is byte-identical to local source. Safe to use.")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
Build a Supabase edge-function deploy payload from local source files,
with byte-exact integrity checks baked in.

Usage:
    python3 scripts/build_edge_deploy_payload.py <function_name> <output_json> \
        [--verify-jwt] [--no-verify-jwt]

Convention:
    - Local function entrypoint:  supabase/functions/<function_name>/index.ts
    - Adapter folder (optional):  supabase/functions/<function_name>/adapters/*.ts
    - Shared modules (optional):  supabase/functions/_shared/*.ts

This script:
    1. Reads index.ts and any sibling .ts files inside the function folder
       (recursively, excluding *.test.ts).
    2. Parses runtime imports (NOT 'import type') from those files and pulls in
       referenced ../_shared/*.ts files only — no stale or unused shared files.
    3. Computes Python char-len + SHA-256 for each file, prints the manifest.
    4. Writes the deploy args JSON to <output_json>.

Usage from Python (NOT shell):
    The output JSON has shape:
        {
            "project_id":      "<filled later>",
            "name":            "<function_name>",
            "entrypoint_path": "index.ts",
            "verify_jwt":      true,
            "files": [{"name": "...", "content": "..."}, ...]
        }
    Open it, fill project_id, then pass the entire dict as the `arguments`
    parameter to call_external_tool(source_id="supabase",
    tool_name="deploy_edge_function").

After deploy:
    Use scripts/verify_edge_deploy.py to byte-verify deployed vs local.
"""

import argparse
import hashlib
import json
import os
import re
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parent.parent
FUNCTIONS_DIR = REPO_ROOT / "supabase" / "functions"
SHARED_DIR = FUNCTIONS_DIR / "_shared"

# Match runtime imports — exclude `import type {…}` which the bundler tree-shakes.
# Captures the module path.
RUNTIME_IMPORT_RE = re.compile(
    r'''^\s*import\s+(?!type\s)[^"';]+from\s+["']([^"']+)["']''',
    re.MULTILINE,
)
# Side-effect imports: `import "./foo.ts";` — also runtime.
SIDE_EFFECT_IMPORT_RE = re.compile(
    r'''^\s*import\s+["']([^"']+)["']''',
    re.MULTILINE,
)


def sha256_short(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()[:16]


def collect_function_files(function_name: str) -> dict[str, str]:
    """Return {name_in_payload: content} for every non-test .ts file inside the
    function folder, plus referenced _shared/*.ts files."""
    fn_dir = FUNCTIONS_DIR / function_name
    if not fn_dir.is_dir():
        sys.exit(f"ERROR: function folder not found: {fn_dir}")

    payload: dict[str, str] = {}

    # 1. Walk function folder
    for path in sorted(fn_dir.rglob("*.ts")):
        if path.name.endswith(".test.ts"):
            continue
        rel = path.relative_to(fn_dir).as_posix()
        payload[rel] = path.read_text(encoding="utf-8")

    if "index.ts" not in payload:
        sys.exit(f"ERROR: missing entrypoint {fn_dir}/index.ts")

    # 2. Find _shared/*.ts files referenced by RUNTIME imports across all files
    needed_shared: set[str] = set()
    for content in payload.values():
        for module in RUNTIME_IMPORT_RE.findall(content) + SIDE_EFFECT_IMPORT_RE.findall(content):
            if "_shared/" in module:
                # Extract just the .ts filename
                m = re.search(r"_shared/([^/'\"]+\.ts)", module)
                if m:
                    needed_shared.add(m.group(1))

    # 3. Add only those — under the "../_shared/" prefix the deploy connector expects
    for fname in sorted(needed_shared):
        spath = SHARED_DIR / fname
        if not spath.exists():
            sys.exit(f"ERROR: imported shared file missing: {spath}")
        if spath.name.endswith(".test.ts"):
            continue
        payload[f"../_shared/{fname}"] = spath.read_text(encoding="utf-8")

    return payload


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("function_name", help="e.g. fetch-ehr-data")
    ap.add_argument("output_json", help="path to write deploy args JSON, e.g. /tmp/deploy_fetch_ehr_v71.json")
    ap.add_argument("--no-verify-jwt", action="store_true", help="set verify_jwt=false (rare; only for webhooks)")
    ap.add_argument("--project-id", default="", help="optional; can be filled in later")
    args = ap.parse_args()

    files = collect_function_files(args.function_name)

    print(f"=== Building payload for {args.function_name} ===\n")
    print(f"{'name':<55} {'chars':>8}   {'sha256[:16]':<16}")
    print("-" * 90)
    for name in sorted(files):
        c = files[name]
        print(f"{name:<55} {len(c):>8}   {sha256_short(c)}")
    print()

    payload = {
        "project_id":      args.project_id,
        "name":            args.function_name,
        "entrypoint_path": "index.ts",
        "verify_jwt":      not args.no_verify_jwt,
        "files":           [{"name": k, "content": v} for k, v in files.items()],
    }

    out_path = Path(args.output_json)
    out_path.write_text(json.dumps(payload), encoding="utf-8")

    # Round-trip verify: re-read and confirm sizes survive JSON encoding.
    rt = json.loads(out_path.read_text(encoding="utf-8"))
    bad = []
    for original, sent in zip(payload["files"], rt["files"], strict=True):
        if original["name"] != sent["name"]:
            bad.append(f"name mismatch: {original['name']} vs {sent['name']}")
        if len(original["content"]) != len(sent["content"]):
            bad.append(f"{original['name']}: {len(original['content'])} → {len(sent['content'])} after JSON round-trip")
        if original["content"] != sent["content"]:
            bad.append(f"{original['name']}: content differs after JSON round-trip")
    if bad:
        sys.exit("ROUND-TRIP CHECK FAILED:\n  " + "\n  ".join(bad))

    print(f"✓ Wrote {out_path} ({out_path.stat().st_size} bytes)")
    print(f"✓ Round-trip integrity check passed for all {len(files)} files")
    if not args.project_id:
        print("\nNEXT: open the JSON, set project_id, then pass the dict to call_external_tool")
        print("      (source_id='supabase', tool_name='deploy_edge_function')")


if __name__ == "__main__":
    main()

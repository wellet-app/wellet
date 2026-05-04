# Edge Function Deploy Runbook

**Why this exists:** Twice in 2 days, edge-function deploys silently truncated
file content during the LLM → tool argument-marshaling step. The deploy "succeeded"
(version incremented) but the deployed bundle was ~25% the size of local source.
We caught it the second time only because we checked SHA-256 byte-exact.

This runbook makes byte-exact verification non-optional.

## The Rules (in force)

1. **Materialize the payload to disk first.** Never construct the deploy args
   inline as a Python dict that the LLM passes through. Always write JSON to
   `/tmp/...` and round-trip-verify before deploying.

2. **Always SHA-256 verify after deploy.** A version increment is NOT proof of
   success.

3. **A subagent is allowed to deploy, but verification MUST happen in the parent
   loop.** Don't trust the subagent's report.

4. **If verify fails → it's a failed deploy.** Re-run; do not paper over.

## The Workflow

### Step 1 — Build the payload

```bash
cd /home/user/workspace/wellet-repo
python3 scripts/build_edge_deploy_payload.py <function-name> /tmp/deploy_<fn>_v<N>.json --project-id nrpdhxygzyfmyljzfexv
```

The script:
- Walks `supabase/functions/<fn>/**/*.ts` (excludes `*.test.ts`)
- Pulls in any `_shared/*.ts` files referenced by RUNTIME imports
  (NOT `import type`, which the bundler tree-shakes)
- Prints char-counts and sha256 for every file
- Round-trip verifies that JSON encoding didn't lose any content

### Step 2 — Deploy

Read the JSON file you just wrote. Pass its full content as the `arguments`
parameter to `call_external_tool(source_id="supabase", tool_name="deploy_edge_function")`.

**The agent MUST NOT paraphrase or summarize file contents.** If a subagent
constructs the args, it must read the JSON from disk and pass it through unmodified.

### Step 3 — Pull deployed bundle

```python
call_external_tool(
    source_id="supabase",
    tool_name="get_edge_function",
    arguments={"project_id": "nrpdhxygzyfmyljzfexv", "function_slug": "<fn>"}
)
```

Save the response to `/tmp/deployed_<fn>_v<N>.json`. If the response has a
`{"result": ...}` wrapper, unwrap it so the JSON has top-level `files` and
`version` keys.

### Step 4 — Byte-verify

```bash
cd /home/user/workspace/wellet-repo
python3 scripts/verify_edge_deploy.py <function-name> /tmp/deployed_<fn>_v<N>.json
```

The script:
- Maps each deployed-bundle file path back to its local source counterpart
- Compares byte-for-byte
- Allows `_shared/*.ts` referenced ONLY via `import type {…}` to be absent
  from the deployed bundle (Deno bundler correctly tree-shakes them)
- Exits 0 only on full match. Non-zero exit = real failure.

## Known false-positive: type-only imports

If a `_shared/*.ts` file is referenced ONLY via `import type {…}`, Deno's
bundler tree-shakes it. The verifier reports `tree-shaken (OK)` and continues.
This is correct behavior, not a bug.

## What broke before, and how this catches it

| Failure mode | Before | After |
|---|---|---|
| Subagent silently truncates index.ts content | Deploy "succeeds" with version bump; runtime returns wrong errors | Step 1 round-trip fails before deploy; or Step 4 catches MISMATCH |
| Stale shared file deployed | Function appears to work but uses old logic | Step 4 catches MISMATCH on the shared file |
| Missing runtime file (not type-only) | Function 500s on first call | Step 4 catches MISSING in deployed |
| New runtime import added but shared file not redeployed | Function 500s on import resolution | Step 1 walks imports automatically and includes referenced shared files |

## When NOT to use this

- Hot-fixing a single env var → use Supabase dashboard
- A function with imports the helper doesn't understand (e.g. import maps,
  remote URLs other than `_shared/`) → fall back to manual build, but still
  run Step 4 to verify

## Adding a new function

The helpers are convention-based:
- Local: `supabase/functions/<fn>/index.ts` is the entrypoint
- Adapters: `supabase/functions/<fn>/adapters/*.ts` are auto-included
- Shared: `supabase/functions/_shared/*.ts` referenced via runtime import

If your function uses a different layout, edit `collect_function_files()` in
`build_edge_deploy_payload.py`.

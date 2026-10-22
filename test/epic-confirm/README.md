# epic-auth confirm step test

Runs epic-auth against an in-memory Supabase and a fake hospital. No network
apart from the first download of @std/assert.

    deno test --no-check --allow-env --allow-net --allow-read test/epic-confirm/confirm_test.ts

The fixtures are fictional (Ann Sample, Sample Health).

# stripe-webhook local test

Runs the real function against local stand-ins for Stripe and PostgREST. Nothing touches production.

```
deno run -A test/stripe-webhook/mock.ts &
SUPABASE_URL=http://localhost:9999 SUPABASE_SERVICE_ROLE_KEY=test \
STRIPE_SECRET_KEY=sk_test_x STRIPE_WEBHOOK_SECRET=whsec_test_local \
STRIPE_API_BASE=http://localhost:9999/v1 \
deno run -A supabase/functions/stripe-webhook/index.ts &
deno run -A test/stripe-webhook/run.ts
```

The run covers 11 checks: signature, duplicates, rotation header, stale payload, retry after failure, unknown price, cancel, and concurrent delivery.

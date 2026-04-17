#!/bin/bash
# Apply notification migrations and deploy edge function
# Usage: SUPABASE_ACCESS_TOKEN=sbp_xxx ./supabase/apply-migrations.sh

set -e

PROJECT_REF="nrpdhxygzyfmyljzfexv"

if [ -z "$SUPABASE_ACCESS_TOKEN" ]; then
  echo "Error: Set SUPABASE_ACCESS_TOKEN environment variable"
  echo "Get your token from: https://supabase.com/dashboard/account/tokens"
  exit 1
fi

echo "Linking project..."
supabase link --project-ref "$PROJECT_REF"

echo "Pushing migrations..."
supabase db push

echo "Deploying send-notification-email edge function..."
supabase functions deploy send-notification-email --project-ref "$PROJECT_REF"

echo "Setting SMTP secrets (you'll need the Brevo SMTP key)..."
echo "Run: supabase secrets set BREVO_SMTP_HOST=smtp-relay.brevo.com BREVO_SMTP_PORT=587 BREVO_SMTP_USER=a86cea001@smtp-brevo.com BREVO_SMTP_KEY=<your-brevo-smtp-key> --project-ref $PROJECT_REF"

echo "Done! Migrations applied and edge function deployed."

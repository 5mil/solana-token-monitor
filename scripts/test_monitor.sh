#!/bin/bash
# Fire a single monitor cycle manually and print the response
# Usage: bash scripts/test_monitor.sh YOUR_PROJECT_REF

PROJECT_REF="${1:-YOUR_PROJECT_REF}"

if [ "$PROJECT_REF" = "YOUR_PROJECT_REF" ]; then
  echo "Usage: bash scripts/test_monitor.sh YOUR_PROJECT_REF"
  exit 1
fi

echo "Triggering mim-monitor for project: $PROJECT_REF"
echo ""

curl -s -X POST \
  "https://${PROJECT_REF}.supabase.co/functions/v1/mim-monitor" \
  -H "Content-Type: application/json" \
  -d '{}' | python3 -m json.tool

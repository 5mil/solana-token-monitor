#!/usr/bin/env bash
# =============================================================================
# historical_scan.sh
# Walks backwards through the entire transaction history for the token,
# paginating the wallet-tracker edge function until no more pages remain.
# Usage: bash scripts/historical_scan.sh YOUR_PROJECT_REF
# =============================================================================

set -euo pipefail

PROJECT_REF="${1:-}"
if [[ -z "$PROJECT_REF" ]]; then
  echo "Usage: bash scripts/historical_scan.sh YOUR_PROJECT_REF"
  exit 1
fi

BASE_URL="https://${PROJECT_REF}.supabase.co/functions/v1/wallet-tracker"
LIMIT=100
PAGE=1
NEXT="?limit=${LIMIT}"
TOTAL_TRADES=0
TOTAL_TXS=0

echo "Starting historical scan for project: $PROJECT_REF"
echo "----------------------------------------------------"

while [[ -n "$NEXT" ]]; do
  URL="${BASE_URL}${NEXT}"
  echo "[Page $PAGE] Fetching: $URL"

  RESPONSE=$(curl -s -X GET "$URL" \
    -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}" \
    -H "Content-Type: application/json")

  OK=$(echo "$RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('ok','false'))" 2>/dev/null || echo "false")
  if [[ "$OK" != "True" && "$OK" != "true" ]]; then
    echo "Error on page $PAGE: $RESPONSE"
    break
  fi

  TRADES=$(echo "$RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('trades_found',0))" 2>/dev/null || echo 0)
  TXS=$(echo "$RESPONSE"    | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('txs_checked',0))" 2>/dev/null || echo 0)
  NEXT=$(echo "$RESPONSE"   | python3 -c "import sys,json; d=json.load(sys.stdin); v=d.get('next_page'); print(v if v else '')" 2>/dev/null || echo "")

  TOTAL_TRADES=$((TOTAL_TRADES + TRADES))
  TOTAL_TXS=$((TOTAL_TXS + TXS))

  echo "  txs checked: $TXS | trades found: $TRADES | next: ${NEXT:-none}"

  PAGE=$((PAGE + 1))

  # Polite rate limit: 1 second between pages
  if [[ -n "$NEXT" ]]; then
    sleep 1
  fi
done

echo "----------------------------------------------------"
echo "Scan complete."
echo "  Total pages    : $((PAGE - 1))"
echo "  Total txs      : $TOTAL_TXS"
echo "  Total trades   : $TOTAL_TRADES"
echo "Results are in: trades, wallet_profiles, wallet_relationships, bundles tables"

#!/usr/bin/env bash
# =============================================================================
# historical_scan.sh v2
# Walks backwards through the entire transaction history for the token.
# Fixes: resume from state file, exponential backoff on errors,
#        RPC endpoint warning, clear progress output.
#
# Usage:
#   export SUPABASE_SERVICE_ROLE_KEY=your_key
#   bash scripts/historical_scan.sh YOUR_PROJECT_REF
#
# To resume an interrupted scan:
#   The script automatically saves its cursor to .scan_state
#   Just re-run the same command — it picks up where it left off.
#   To force a fresh scan: rm .scan_state
# =============================================================================

set -euo pipefail

PROJECT_REF="${1:-}"
if [[ -z "$PROJECT_REF" ]]; then
  echo "Usage: bash scripts/historical_scan.sh YOUR_PROJECT_REF"
  exit 1
fi

if [[ -z "${SUPABASE_SERVICE_ROLE_KEY:-}" ]]; then
  echo "Error: SUPABASE_SERVICE_ROLE_KEY is not set."
  exit 1
fi

BASE_URL="https://${PROJECT_REF}.supabase.co/functions/v1/wallet-tracker"
LIMIT=100
STATE_FILE=".scan_state"
MAX_RETRIES=5

# ── Resume state ────────────────────────────────────────────────────────────
PAGE=1
NEXT="?limit=${LIMIT}"
TOTAL_TRADES=0
TOTAL_TXS=0

if [[ -f "$STATE_FILE" ]]; then
  SAVED_CURSOR=$(cat "$STATE_FILE")
  if [[ -n "$SAVED_CURSOR" ]]; then
    NEXT="?before=${SAVED_CURSOR}&limit=${LIMIT}"
    echo "Resuming scan from cursor: $SAVED_CURSOR"
  fi
fi

echo "====================================================="
echo "Historical scan for project: $PROJECT_REF"
echo "Endpoint: $BASE_URL"
echo "====================================================="

# ── Main loop ───────────────────────────────────────────────────────────────
while [[ -n "$NEXT" ]]; do
  URL="${BASE_URL}${NEXT}"
  echo "[Page $PAGE] $URL"

  # Exponential backoff retry loop
  ATTEMPT=0
  RESPONSE=""
  while [[ $ATTEMPT -le $MAX_RETRIES ]]; do
    HTTP_CODE=$(curl -s -o /tmp/scan_response.json -w "%{http_code}" -X GET "$URL" \
      -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}" \
      -H "Content-Type: application/json")
    RESPONSE=$(cat /tmp/scan_response.json)

    if [[ "$HTTP_CODE" == "200" ]]; then
      break
    elif [[ "$HTTP_CODE" == "429" || "$HTTP_CODE" -ge 500 ]]; then
      ATTEMPT=$((ATTEMPT + 1))
      if [[ $ATTEMPT -gt $MAX_RETRIES ]]; then
        echo "  ERROR: HTTP $HTTP_CODE after $MAX_RETRIES retries. Saving state and exiting."
        # Save cursor so we can resume
        OLDEST=$(echo "$RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('oldest_sig') or '')" 2>/dev/null || echo "")
        [[ -n "$OLDEST" ]] && echo "$OLDEST" > "$STATE_FILE"
        exit 1
      fi
      DELAY=$((2 ** ATTEMPT))
      DELAY=$((DELAY > 60 ? 60 : DELAY))
      echo "  HTTP $HTTP_CODE — retry $ATTEMPT/$MAX_RETRIES in ${DELAY}s..."
      sleep "$DELAY"
    else
      echo "  ERROR: Unexpected HTTP $HTTP_CODE. Response: $RESPONSE"
      exit 1
    fi
  done

  # Parse response fields
  OK=$(echo "$RESPONSE"     | python3 -c "import sys,json; d=json.load(sys.stdin); print(str(d.get('ok',False)).lower())" 2>/dev/null || echo "false")
  SKIPPED=$(echo "$RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('skipped',''))" 2>/dev/null || echo "")

  # Handle advisory lock collision (another instance running)
  if [[ "$SKIPPED" == "lock_held" ]]; then
    echo "  Lock held by another instance — waiting 10s and retrying..."
    sleep 10
    continue
  fi

  if [[ "$OK" != "true" ]]; then
    ERROR=$(echo "$RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('error','unknown'))" 2>/dev/null || echo "unknown")
    echo "  ERROR from function: $ERROR"
    # If DB functions not deployed, fail fast with clear message
    if echo "$ERROR" | grep -q "migration"; then
      echo "  Run supabase/migrations/20260608000002_wallet_tracking_fixes.sql first."
      exit 1
    fi
    exit 1
  fi

  TRADES=$(echo "$RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('trades_found',0))" 2>/dev/null || echo 0)
  TXS=$(echo "$RESPONSE"    | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('txs_checked',0))" 2>/dev/null || echo 0)
  NEXT=$(echo "$RESPONSE"   | python3 -c "import sys,json; d=json.load(sys.stdin); v=d.get('next_page'); print(v if v else '')" 2>/dev/null || echo "")
  OLDEST=$(echo "$RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('oldest_sig') or '')" 2>/dev/null || echo "")
  WARNING=$(echo "$RESPONSE"| python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('warning',''))" 2>/dev/null || echo "")

  # Show public RPC warning on first page only
  if [[ -n "$WARNING" && $PAGE -eq 1 ]]; then
    echo "  ⚠️  WARNING: $WARNING"
  fi

  TOTAL_TRADES=$((TOTAL_TRADES + TRADES))
  TOTAL_TXS=$((TOTAL_TXS + TXS))

  echo "  txs: $TXS | trades: $TRADES | total_txs: $TOTAL_TXS | total_trades: $TOTAL_TRADES | next: ${NEXT:-DONE}"

  # Save resume cursor after every successful page
  [[ -n "$OLDEST" ]] && echo "$OLDEST" > "$STATE_FILE"

  PAGE=$((PAGE + 1))

  if [[ -n "$NEXT" ]]; then
    sleep 1
  fi
done

# Clean up state file on successful completion
[[ -f "$STATE_FILE" ]] && rm "$STATE_FILE"

echo "====================================================="
echo "Scan complete."
echo "  Pages scanned  : $((PAGE - 1))"
echo "  Total txs      : $TOTAL_TXS"
echo "  Total trades   : $TOTAL_TRADES"
echo "Results: trades, wallet_profiles, wallet_relationships, bundles tables"
echo "====================================================="

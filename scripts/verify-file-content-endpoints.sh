#!/usr/bin/env bash
set -euo pipefail

# Quick local validation plan for file content endpoints.
# 1) Obtain a valid bearer token and file ID that belongs to that user.
# 2) Run:
#    ./scripts/verify-file-content-endpoints.sh http://127.0.0.1:3101 "$TOKEN" "$FILE_ID"
# 3) Optional admin route check:
#    ./scripts/verify-file-content-endpoints.sh http://127.0.0.1:3101 "$TOKEN" "$FILE_ID" "$TARGET_USER_ID"

BASE_URL="${1:-http://127.0.0.1:3101}"
TOKEN="${2:-}"
FILE_ID="${3:-}"
TARGET_USER_ID="${4:-}"

if [[ -z "$TOKEN" || -z "$FILE_ID" ]]; then
  echo "Usage: $0 <base_url> <bearer_token> <file_id> [target_user_id]" >&2
  exit 2
fi

check_endpoint() {
  local url="$1"
  local body_file
  local header_file
  body_file="$(mktemp)"
  header_file="$(mktemp)"
  trap 'rm -f "$body_file" "$header_file"' RETURN

  local status
  status="$(curl -sS -D "$header_file" -o "$body_file" -w '%{http_code}' \
    -H "Authorization: Bearer ${TOKEN}" \
    "$url")"

  local body_bytes
  body_bytes="$(wc -c < "$body_file" | tr -d '[:space:]')"
  local content_length
  content_length="$(awk -F': ' 'tolower($1)=="content-length" {print $2}' "$header_file" | tr -d '\r' | tail -n1)"

  echo "URL: $url"
  echo "HTTP: $status"
  echo "Body bytes: $body_bytes"
  echo "Header Content-Length: ${content_length:-<missing>}"

  if [[ "$status" != "200" ]]; then
    echo "FAIL: expected HTTP 200" >&2
    return 1
  fi

  if [[ "$body_bytes" -le 0 ]]; then
    echo "FAIL: expected non-empty body" >&2
    return 1
  fi

  if [[ -n "$content_length" && "$content_length" != "$body_bytes" ]]; then
    echo "FAIL: Content-Length does not match body size" >&2
    return 1
  fi

  echo "PASS"
}

check_endpoint "${BASE_URL}/v1/files/${FILE_ID}/content"

if [[ -n "$TARGET_USER_ID" ]]; then
  check_endpoint "${BASE_URL}/admin/users/${TARGET_USER_ID}/files/${FILE_ID}/content"
fi

# Abuse Detection Manual Tests

## 1) Concurrent streaming cap (`max 2`)
1. Login as one user and capture session cookie.
2. Start 2 parallel streaming requests to `/v1/responses` (or `/v1/chat/completions`) with `"stream": true`.
3. Start a 3rd stream immediately with the same cookie.
4. Expected: 3rd request returns `429` with `"Too many concurrent streams for this user"`, and an `abuse.stream_concurrency_blocked` audit event is written.

## 2) Login brute-force escalation (throttle -> temp ban)
1. Use a known user email and submit wrong password repeatedly (`>= 6` in ~10 minutes).
2. Expected: user score increases; throttle action appears in suspicious list (`abuse.action.throttle_auto`).
3. Continue wrong logins to keep score high (`>= ban threshold` while throttle is active).
4. Expected: temporary ban is applied (`users.status='banned'`, `ban_expires_at` set) and `/auth/login` returns `403`.

## 3) High TPM abuse escalation (throttle -> temp ban)
1. Send repeated large prompts quickly for one user to push TPM above threshold.
2. Expected: user is auto-throttled (lower effective RPM/TPM).
3. Continue traffic to trigger repeated violations under throttle.
4. Expected: temporary ban is applied and authenticated requests return `403` until `ban_expires_at`.

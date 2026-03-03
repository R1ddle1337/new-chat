# Admin Provider Management Manual Tests

## 1) Admin-only access
1. Login as a non-admin user.
2. Open `GET /api/admin/providers`.
3. Expected: request is rejected by admin guard (current pattern is `404 Not found`).

## 2) List providers returns metadata only
1. Login as admin.
2. Open `GET /api/admin/providers`.
3. Expected:
   - each item has `id`, `code`, `name`, `base_url`, `enabled`, `has_secret`, `secret_updated_at`.
   - no API key/secret value is returned.

## 3) Create provider
1. In Admin -> Providers, create a provider with:
   - `code`: `openai_alt`
   - `name`: `OpenAI Alt`
   - `base_url`: `https://api.openai.com/v1/` (with trailing slash)
   - `enabled`: checked
2. Expected:
   - provider is created.
   - list shows normalized base URL without trailing slash: `https://api.openai.com/v1`.

## 4) Validation checks
1. Try creating provider with duplicate `code` (existing code).
2. Expected: rejected (client-side and/or API conflict error).
3. Try invalid `base_url` values:
   - `not-a-url`
   - `ftp://example.com/v1`
   - `https://example.com/v1?x=1`
4. Expected: rejected with validation error.

## 5) Edit provider fields
1. Edit an existing provider `code`, `name`, and `base_url`.
2. Click `Save provider`.
3. Expected: updated values appear in provider list.

## 6) Enable/disable provider
1. Click `Disable` on a provider used by a published model.
2. Send chat request using that model to:
   - `POST /api/v1/responses`
   - `POST /api/v1/chat/completions`
3. Expected: model is not selectable/published for live traffic (request fails with model unavailable/not published behavior).
4. Re-enable the provider.
5. Expected: requests succeed again (assuming model + secret are configured).

## 7) Write-only provider secret endpoint
1. Set API key from Admin -> Providers (`Save API key`).
2. Expected:
   - request uses `POST /api/admin/providers/:id/secret`.
   - returns success without exposing the key.
3. Re-check `GET /api/admin/providers`.
4. Expected:
   - `has_secret` is `true`.
   - `secret_updated_at` is populated.
   - secret value is still never returned.

## 8) Gateway upstream base URL + secret usage
1. Configure provider base URL + secret.
2. Publish a model for that provider and set user default model to that published `public_id`.
3. Send one request to each endpoint:
   - `POST /api/v1/responses`
   - `POST /api/v1/chat/completions`
4. Expected:
   - both requests are proxied to `provider_base_url + /responses` and `provider_base_url + /chat/completions`.
   - upstream auth uses configured provider secret as Bearer token.

# Admin Users + Chat Viewer Manual Tests

## 1) Admin-only protection
1. Login as a non-admin user.
2. Try each endpoint:
   - `POST /api/admin/users/:userId/delete`
   - `POST /api/admin/users/:userId/restore`
   - `GET /api/admin/users/:userId/threads`
   - `GET /api/admin/users/:userId/threads/:threadId/messages`
   - `GET /api/admin/users/:userId/files/:fileId/content`
3. Expected: all are rejected by admin guard (current pattern returns `404 Not found`).

## 2) Soft delete user
1. Login as admin and open `/admin`.
2. In **Users**, click `Delete` for a target user.
3. In confirmation prompt, type the target user's email or UUID exactly.
4. Expected:
   - API `POST /api/admin/users/:userId/delete` succeeds.
   - User row shows `status=banned` and soft-delete metadata (`deleted_at`, `deleted_reason=admin_delete`).
   - Active sessions for that user are revoked (status message includes revoked session count).
   - Audit event `admin.users.deleted` is written with `target_user_id` and `revoked_session_count`.

## 3) Restore user
1. In **Users**, click `Restore` for a soft-deleted user.
2. Expected:
   - API `POST /api/admin/users/:userId/restore` succeeds.
   - User becomes `status=active`.
   - `deleted_at` and `deleted_reason` are cleared.
   - Audit event `admin.users.restored` is written with `target_user_id`.

## 4) Browse user threads/messages
1. In **Users**, click `View chats` for a user.
2. Expected:
   - UI loads thread list from `GET /api/admin/users/:userId/threads`.
   - Each thread shows message count.
   - Audit event `admin.users.threads_viewed` is written with `result_count`.
3. Click a thread.
4. Expected:
   - UI loads messages from `GET /api/admin/users/:userId/threads/:threadId/messages?limit=100`.
   - Response contains sanitized message fields (`id`, `role`, `content`, `created_at`) plus attachment metadata.
   - No raw `raw_content` blob is exposed.
   - Audit event `admin.users.messages_viewed` is written with `target_user_id`, `thread_id`, and counts.

## 5) Message pagination guardrail
1. Call `GET /api/admin/users/:userId/threads/:threadId/messages?limit=500`.
2. Expected:
   - Server caps page size to `200`.
   - Response includes `paging.has_more`/`paging.next_cursor` when additional messages exist.
3. Call again with `cursor` from previous response.
4. Expected: next page is returned without duplicate first-page results.

## 6) Admin attachment viewing
1. In admin message viewer, click an attachment link.
2. Expected:
   - URL opens `GET /api/admin/users/:userId/files/:fileId/content` in a new tab.
   - File streams successfully when `file.user_id == :userId`.
   - Audit event `admin.users.file_viewed` is written with `target_user_id` and `file_id`.

## 7) Ownership checks
1. For a valid `fileId` owned by User A, request `/api/admin/users/<UserB>/files/<fileId>/content`.
2. Expected: `404 File not found`.
3. For a valid thread ID of User A, request `/api/admin/users/<UserB>/threads/<threadId>/messages`.
4. Expected: `404 Thread not found`.

## 8) UUID validation checks
1. Request endpoints with invalid `userId`, `threadId`, or `fileId` (e.g. `abc`).
2. Expected: `400` validation errors (`must be a valid UUID`).

## 9) Delete confirmation UX safety
1. Click `Delete` in UI and enter incorrect confirmation text.
2. Expected: no delete request is sent and UI reports confirmation mismatch.

## 10) Regression checks
1. Verify existing admin actions still work:
   - ban/unban
   - user limits
   - abuse monitor actions
2. Verify normal user chat flow still works (`/chat`, `/api/v1/files/:fileId/content` for owner).

# Release prerequisites

Status: **implementation complete and locally verified; live account verification pending.**

## Verified

- [x] `npm run typecheck` passes.
- [x] `npm test` passes: 26 tests across two files.
- [x] `npm run build` emits `lib/`; `npm pack --dry-run` produces 18 files, 66.4 kB.
- [x] The plugin installs into a fresh DSH profile with `dsh plugin --profile web add .`.
- [x] `dsh --profile web --dump-config` shows the `nexscope` row.
- [x] `dsh --profile web --dump-config-schema` resolves the entry as `status: schema` and adds **no** new diagnostics compared with a plugin-free baseline.
- [x] The installed package resolves from the profile's `node_modules` and exports `name`, `inject`, `Config`, `apply`.
- [x] A real-Cordis integration test mounts the plugin beside the real `dsh-tools`, `dsh-skill`, `dsh-credentials-local`, and `dsh-skill-filesystem` services, then asserts the `nexscope` skill and all seven tools are registered.
- [x] The authorization server advertises `client_id_metadata_document_supported`; the authorize endpoint accepts a CIMD client and a loopback redirect URI and returns the login redirect.
- [x] The token endpoint accepts the CIMD client identity for `authorization_code` and returns `invalid_grant` for a fake code, proving client authentication and PKCE parameters are accepted.
- [x] The token endpoint requires the RFC 8707 `resource` parameter on refresh (`invalid_target` when absent, `invalid_grant` when present); the MCP SDK sends `resource` on both the code exchange and the refresh path.
- [x] The OAuth callback listener accepts a valid code, rejects a state mismatch, rejects a denial, and times out.
- [x] The market index validates with `parseMarketIndex` from `@deepseek-ai/dsh-plugin-market-index`.

## Pending

- [ ] **Publish the client metadata document.** Serve `public/dsh-nexscope-client.json` at `https://www.nexscope.ai/.well-known/dsh-nexscope-client.json` as `application/json`, status 200, no redirects. Sign-in cannot complete until this exists.
- [ ] Run one real browser sign-in against production; confirm the grant is stored and silently refreshed.
- [ ] Call one low-cost published tool and one asynchronous tool; verify polling and credit accounting.
- [ ] Confirm large results stay within the harness spill budget.
- [ ] Verify sign-out and re-sign-in.
- [ ] Verify `nexscope_account` with a user-supplied API key; the OAuth-only path correctly reports that a key is required.
- [ ] Exercise the workflow tools against the test environment (`api-test.nexscope.ai`), where `nexscope_workflow_*` is published.
- [ ] Recheck the catalog size against `https://api.nexscope.ai/api/skill-api/v1/catalog` at release time.
- [ ] Publish the npm package, then serve `market/` at `https://www.nexscope.ai/dsh/`.

## Design notes

- The plugin registers seven tools, not the published catalog. The catalog holds 541 tools and about 960 KB of name/description/schema, roughly 240k prompt tokens. `nexscope_find_tools` → `nexscope_describe_tool` → `nexscope_call_tool` keeps every capability reachable and pays no schema cost until a call needs it.
- Workflow tools are reachable through the same discovery path whenever the server publishes them. `nexscope_workflow_draft` and `nexscope_workflow_read` work headlessly; the interactive canvas (`workflow_open`, `workflow_host`, `workflow_media_select`) has no host in DeepSeek Harness, which is a platform limit rather than a plugin gap.
- Credit balance: the account REST endpoints accept API keys only, and the MCP server publishes no account tool. `nexscope_account` therefore prefers a server-published account tool, then a configured API key, and otherwise explains exactly why the balance is unavailable and links to the billing page. OAuth is never used to fake account access.
- The MCP server also accepts `Authorization: Bearer nk-...` API keys for tool calls. The plugin does not use them for calls, so a user never pastes a key into chat.
- Sign-in uses a loopback callback on `127.0.0.1:45871`–`45873`. If all three ports are busy, sign-in fails with a clear message rather than silently changing the advertised redirect URI.
- `nexscope_sign_in` first tries a silent refresh with the stored grant, then falls back to the browser. A failed refresh (`invalid_grant`) is treated as a sign-in requirement, not as a transport error.
- `nexscope_export` converts an existing JSON result into CSV, JSON, or JSONL without another paid call, resolving paths against the session working directory.

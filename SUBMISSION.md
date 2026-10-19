# Release prerequisites

Status: **implementation complete; live OAuth, refresh, paid call, and export verified against production.**

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
- [x] **Live OAuth sign-in against production.** The browser flow completed with the CIMD client, the loopback callback received the code, and the token exchange stored a grant with a refresh token (`expires_in: 899`, `scope: mcp:tools`).
- [x] **Live catalog read.** The plugin connected to `https://api.nexscope.ai/api/skill-api/v2/mcp` and listed **545** published tools.
- [x] **Live paid call through the model-facing tool.** `nexscope_call_tool` ran `nexscope_1688_product_detail` with `offerId: 1040473674152`, returned `code: 0` with product and SKU data in about 2.2 s, and reported `cost: -1` for that call.
- [x] **Live refresh.** After replacing the stored access token with an invalid value, the next catalog read hit 401, refreshed with the stored refresh token, saved a new access token, rotated the refresh token, and succeeded.
- [x] **Live export.** `nexscope_export` wrote `structuredContent.data.product.skuList` to a 3-row CSV from the real result, with nested values serialized and quotes escaped.

## Pending

- [ ] **Publish the client metadata document.** Serve `public/dsh-nexscope-client.json` at `https://www.nexscope.ai/.well-known/dsh-nexscope-client.json` as `application/json`, status 200, no redirects. This verification used the temporary document at `https://cdn.jsdelivr.net/gh/TANAGELEEE/dsh-oauth-client-test@main/client.json`, so production sign-in with the shipped client id still needs this deployment.
- [ ] Delete the two temporary public CIMD repositories once the production document is live.
- [ ] Run one asynchronous call and verify task polling end to end; the catalog marks 63 skills as `asyncTask`.
- [ ] Confirm a large result stays within the harness spill budget.
- [ ] Verify sign-out and re-sign-in through `nexscope_sign_in`.
- [ ] Verify `nexscope_account` with a real Nexscope API key; the OAuth-only path already reports that a key is required.
- [ ] Exercise `nexscope_workflow_*` against `api-test.nexscope.ai`, where the workflow tools are published.
- [ ] Recheck the catalog size at release time (541 catalog skills; 545 published MCP tools today).
- [ ] Publish the npm package, then serve `market/` at `https://www.nexscope.ai/dsh/`.

## Design notes

- The plugin registers seven tools, not the published catalog. The catalog holds 541 tools and about 960 KB of name/description/schema, roughly 240k prompt tokens. `nexscope_find_tools` → `nexscope_describe_tool` → `nexscope_call_tool` keeps every capability reachable and pays no schema cost until a call needs it.
- Workflow tools are reachable through the same discovery path whenever the server publishes them. `nexscope_workflow_draft` and `nexscope_workflow_read` work headlessly; the interactive canvas (`workflow_open`, `workflow_host`, `workflow_media_select`) has no host in DeepSeek Harness, which is a platform limit rather than a plugin gap.
- Credit balance: the account REST endpoints accept API keys only, and the MCP server publishes no account tool. `nexscope_account` therefore prefers a server-published account tool, then a configured API key, and otherwise explains exactly why the balance is unavailable and links to the billing page. OAuth is never used to fake account access.
- The MCP server also accepts `Authorization: Bearer nk-...` API keys for tool calls. The plugin does not use them for calls, so a user never pastes a key into chat.
- Live verification used a temporary CIMD document because the production `.well-known` path is not deployed yet. The OAuth code path, callback validation, token storage, and refresh are the shipped ones; only the client-id URL differed.
- Sign-in uses a loopback callback on `127.0.0.1:45871`–`45873`. If all three ports are busy, sign-in fails with a clear message rather than silently changing the advertised redirect URI.
- `nexscope_sign_in` first tries a silent refresh with the stored grant, then falls back to the browser. A failed refresh (`invalid_grant`) is treated as a sign-in requirement, not as a transport error.
- `nexscope_export` converts an existing JSON result into CSV, JSON, or JSONL without another paid call, resolving paths against the session working directory.

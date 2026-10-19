# Release prerequisites

Status: **implementation complete; live OAuth, refresh, paid call, and export verified against production.**

## Verified

- [x] `npm run typecheck` passes.
- [x] `npm test` passes: 34 tests across three files.
- [x] GitHub Actions `CI` passes on a clean Linux runner (`npm ci`, typecheck, tests, `npm pack --dry-run`).
- [x] `npm run build` emits `lib/`; `npm pack --dry-run` produces 18 files, 66.7 kB.
- [x] A real MCP client/server integration test over a linked in-memory transport covers tool discovery, exact schema pass-through, multi-block text plus structured content, and upstream error results.
- [x] The plugin installs into a fresh DSH profile with `dsh plugin --profile web add .`.
- [x] `dsh --profile web --dump-config` shows the `nexscope` row.
- [x] `dsh --profile web --dump-config-schema` resolves the entry as `status: schema` and adds **no** new diagnostics compared with a plugin-free baseline.
- [x] The installed package resolves from the profile's `node_modules` and exports `name`, `inject`, `Config`, `apply`.
- [x] A real-Cordis integration test mounts the plugin beside the real `dsh-tools`, `dsh-skill`, `dsh-credentials-local`, and `dsh-skill-filesystem` services, then asserts the `nexscope` skill and all seven tools are registered.
- [x] The authorization server advertises `client_id_metadata_document_supported`; the authorize endpoint accepts a CIMD client and a loopback redirect URI and returns the login redirect.
- [x] The token endpoint accepts the CIMD client identity for `authorization_code` and returns `invalid_grant` for a fake code, proving client authentication and PKCE parameters are accepted.
- [x] The token endpoint requires the RFC 8707 `resource` parameter on refresh (`invalid_target` when absent, `invalid_grant` when present); the MCP SDK sends `resource` on both the code exchange and the refresh path.
- [x] The OAuth callback listener accepts a valid code, rejects a state mismatch, rejects a denial, and times out.
- [x] Sign-in preflights the client-metadata document (reachability, JSON content type, matching `client_id`, and the exact loopback callback). The temporary document passes; the production URL currently fails fast with `HTTP 404` instead of opening a broken browser page.
- [x] The market index validates with `parseMarketIndex` from `@deepseek-ai/dsh-plugin-market-index`.
- [x] **Live OAuth sign-in against production.** The browser flow completed with the CIMD client, the loopback callback received the code, and the token exchange stored a grant with a refresh token (`expires_in: 899`, `scope: mcp:tools`).
- [x] **Live catalog read.** The plugin connected to `https://api.nexscope.ai/api/skill-api/v2/mcp` and listed **545** published tools.
- [x] **Live paid call through the model-facing tool.** `nexscope_call_tool` ran `nexscope_1688_product_detail` with `offerId: 1040473674152`, returned `code: 0` with product and SKU data in about 2.2 s. The response reported `cost: -1`, while the account usage page recorded `research:/alibaba1688/productDetail:EN` at `-10` credits for that minute, so the real charge was 10 credits.
- [x] **Live refresh.** After replacing the stored access token with an invalid value, the next catalog read hit 401, refreshed with the stored refresh token, saved a new access token, rotated the refresh token, and succeeded.
- [x] **Live export.** `nexscope_export` wrote `structuredContent.data.product.skuList` to a 3-row CSV from the real result, with nested values serialized and quotes escaped.
- [x] **Published tool surface.** Both `api.nexscope.ai` and `api-test.nexscope.ai` publish **545** tools: the 541 catalog skills plus `nexscope_media_task_result`, `nexscope_route_api`, `nexscope_jev_evaluate`, and `nexscope_seo_call_result`. Neither publishes `nexscope_workflow_*` today, so workflow tools are deploy-dependent and the passthrough surface picks them up automatically when they ship.

## Pending

- [ ] **Run the manual production deploy.** The CIMD document is merged to `master` (MR !372, merge commit `eeccf2fc`). Pipeline #611828 is blocked on the manual job `nexscope-official-部署-正式环境`; run it, then confirm `https://www.nexscope.ai/.well-known/dsh-nexscope-client.json` returns `200 application/json` with no redirect and re-run one sign-in with the production client id.
- [ ] **Merge the market index after the npm release.** MR `!372` intentionally contains only the CIMD document; the index would advertise `dsh-nexscope@0.1.0` before it exists. The ready merge branch is `merge/dsh-metadata-master`; merge it once `npm publish` succeeds.
- [ ] Delete the two temporary public CIMD repositories once the production document is live.
- [ ] Run one asynchronous generation and verify task polling end to end. `nexscope_media_task_result` is reachable and its exact schema is `{skillSlug, taskId}`; with a fake task id it returns code `99404` without charging. The catalog marks 63 skills as `asyncTask`, all image/video generation.
- [ ] Confirm a large result stays within the harness spill budget.
- [ ] Verify sign-out and re-sign-in through `nexscope_sign_in`.
- [ ] Verify `nexscope_account` with a real Nexscope API key; the OAuth-only path already reports that a key is required.
- [ ] Exercise `nexscope_workflow_*` once a server deployment publishes them. As of this run, neither production nor test publishes them.
- [ ] Recheck the catalog size at release time (541 catalog skills; 545 published MCP tools today).
- [ ] Publish the npm package (`npm login` is required; the name `dsh-nexscope` is still unclaimed), then serve `market/` at `https://www.nexscope.ai/dsh/`.

## Design notes

- The plugin registers seven tools, not the published catalog. The catalog holds 541 tools and about 960 KB of name/description/schema, roughly 240k prompt tokens. `nexscope_find_tools` → `nexscope_describe_tool` → `nexscope_call_tool` keeps every capability reachable and pays no schema cost until a call needs it.
- Workflow tools are reachable through the same discovery path whenever the server publishes them. `nexscope_workflow_draft` and `nexscope_workflow_read` work headlessly; the interactive canvas (`workflow_open`, `workflow_host`, `workflow_media_select`) has no host in DeepSeek Harness, which is a platform limit rather than a plugin gap.
- Credit balance: the account REST endpoints accept API keys only, and the MCP server publishes no account tool. `nexscope_account` therefore prefers a server-published account tool, then a configured API key, and otherwise explains exactly why the balance is unavailable and links to the billing page. OAuth is never used to fake account access.
- The MCP server also accepts `Authorization: Bearer nk-...` API keys for tool calls. The plugin does not use them for calls, so a user never pastes a key into chat.
- Live verification used a temporary CIMD document because the production `.well-known` path is not deployed yet. The OAuth code path, callback validation, token storage, and refresh are the shipped ones; only the client-id URL differed.
- Sign-in uses a loopback callback on `127.0.0.1:45871`–`45873`. If all three ports are busy, sign-in fails with a clear message rather than silently changing the advertised redirect URI.
- `nexscope_sign_in` first tries a silent refresh with the stored grant, then falls back to the browser. A failed refresh (`invalid_grant`) is treated as a sign-in requirement, not as a transport error.
- `nexscope_export` converts an existing JSON result into CSV, JSON, or JSONL without another paid call, resolving paths against the session working directory.

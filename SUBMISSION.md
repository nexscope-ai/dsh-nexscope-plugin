# Release prerequisites

Status: **implementation complete and locally verified; live verification pending.**

## Verified

- [x] `npm run typecheck` passes.
- [x] `npm test` passes: 17 tests across two files.
- [x] `npm run build` emits `lib/`; `npm pack --dry-run` produces 16 files, 60.3 kB.
- [x] The plugin installs into a fresh DSH profile with `dsh plugin --profile web add .`.
- [x] `dsh --profile web --dump-config` shows the `nexscope` row.
- [x] `dsh --profile web --dump-config-schema` resolves the entry as `status: schema` and adds **no** new diagnostics compared with a plugin-free baseline (identical six entries, all pre-existing).
- [x] The installed package resolves from the profile's `node_modules` and exports `name`, `inject`, `Config`, `apply`.
- [x] A real-Cordis integration test mounts the plugin beside the real `dsh-tools`, `dsh-skill`, `dsh-credentials-local`, and `dsh-skill-filesystem` services, then asserts the `nexscope` skill and all five tools are registered.
- [x] The Nexscope authorization server advertises `client_id_metadata_document_supported`, and the production authorize endpoint accepts a loopback redirect URI and returns the login redirect.
- [x] The OAuth callback listener accepts a valid code, rejects a state mismatch, rejects a denial, and times out.
- [x] The market index validates with the official `parseMarketIndex` from `@deepseek-ai/dsh-plugin-market-index`.

## Pending

- [ ] **Publish the client metadata document.** Serve `public/dsh-nexscope-client.json` at `https://www.nexscope.ai/.well-known/dsh-nexscope-client.json` as `application/json`, status 200, no redirects. Sign-in cannot complete until this exists: the authorization server fetches it while resolving the URL client id.
- [ ] Run one real browser sign-in against production; confirm the grant is stored and silently refreshed.
- [ ] Call one low-cost published tool and one asynchronous tool; verify polling and credit accounting.
- [ ] Confirm large results stay within the harness spill budget.
- [ ] Verify sign-out and re-sign-in.
- [ ] Recheck the catalog size against `https://api.nexscope.ai/api/skill-api/v1/catalog` at release time.
- [ ] Publish the npm package, then serve `market/` at `https://www.nexscope.ai/dsh/`.

## Design notes

- The plugin registers five tools, not the published catalog. The catalog holds 541 tools and about 960 KB of name/description/schema, roughly 240k prompt tokens. `nexscope_find_tools` → `nexscope_describe_tool` → `nexscope_call_tool` keeps every capability reachable and pays no schema cost until a call needs it.
- The MCP server also accepts `Authorization: Bearer nk-...` API keys. The plugin does not use them, so a user never pastes a key into chat.
- Sign-in uses a loopback callback on `127.0.0.1:45871`–`45873`. If all three ports are busy, sign-in fails with a clear message rather than silently changing the advertised redirect URI.
- `nexscope_sign_in` first tries a silent refresh with the stored grant, then falls back to the browser.

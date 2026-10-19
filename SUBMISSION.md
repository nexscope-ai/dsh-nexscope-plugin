# Release prerequisites

Status: **implementation complete, live verification pending.**

## Verified

- [x] `npm run typecheck` passes.
- [x] `npm test` passes: 17 tests, including the real-Cordis composition test.
- [x] `npm run build` emits `lib/`.
- [x] The plugin installs into an isolated DSH profile with `dsh plugin --profile dev add .`.
- [x] `dsh --profile dev --dump-config` shows the `nexscope` row.
- [x] `dsh --profile dev --dump-config-schema` resolves the entry with `diagnostics: []`.
- [x] The package resolves from the profile's `node_modules` and exports `name`, `inject`, `Config`, `apply`.
- [x] The Nexscope authorization server advertises `client_id_metadata_document_supported`, and a loopback redirect URI is accepted in the production authorize endpoint.
- [x] The OAuth callback listener accepts a valid code, rejects a state mismatch, rejects a denial, and times out.

## Pending

- [ ] Publish `public/dsh-nexscope-client.json` at `https://www.nexscope.ai/.well-known/dsh-nexscope-client.json` with `Content-Type: application/json`, status 200, no redirects. This is a hard prerequisite: the authorization server fetches that document during sign-in.
- [ ] Run one real browser sign-in against production and confirm the grant is stored and refreshed.
- [ ] Call one low-cost published tool and one asynchronous tool; verify polling and credit accounting.
- [ ] Verify a large result is summarized instead of flooding the conversation.
- [ ] Verify sign-out and re-sign-in.
- [ ] Confirm the catalog size against `https://api.nexscope.ai/api/skill-api/v1/catalog` at release time.
- [ ] Publish the npm package and a plugin market index under `https://www.nexscope.ai/dsh/index.json`.

## Notes

- The plugin deliberately registers five tools, not the full published catalog. The catalog is about 541 tools and roughly 960 KB of schema, which would cost about 240k prompt tokens per request. `nexscope_find_tools` / `nexscope_describe_tool` / `nexscope_call_tool` keep every capability reachable without that cost.
- The MCP server also accepts `Authorization: Bearer nk-...` API keys. The plugin does not use them, so users never paste a key into chat.

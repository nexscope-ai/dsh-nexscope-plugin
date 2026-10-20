# Changelog

## 0.1.2

Show the Nexscope icon on the plugin's page and cards.

- `package.json` now declares `icon: ./assets/icon.png`. DeepSeek Harness reads
  the icon from the manifest and inlines it as a data URL, so without this field
  the plugin page fell back to the generic placeholder artwork. The asset was
  already shipped; only the manifest declaration was missing.

## 0.1.1

Fix sign-in failing on a fresh install.

- **Sign-in no longer fails with "holds a value JSON cannot represent".** The
  MCP SDK saves discovery state with an explicit `resourceMetadataUrl:
  undefined` when the authorization server publishes no protected-resource
  metadata. The credential store only admits payloads that survive a JSON round
  trip, so that save was rejected and every sign-in attempt failed.
- **A rejected grant write no longer poisons the session.** `patchGrant` now
  persists before updating the in-memory grant, so a failed write leaves no
  state the store never accepted.
- **A failed grant write no longer leaks the loopback port.** The listener is
  closed when the write after binding fails, instead of staying open and making
  every later attempt fail with `EADDRINUSE`.
- Regression tests: storing discovery state that carries `undefined`, and
  releasing the callback port when the grant write fails.

## 0.1.0

First release.

First release.

- DSH bundle `@nexscope/dsh-nexscope` with `dsh.bundle.patch` and `engines.dsh >=0.2.0-rc.2 <0.3.0`.
- OAuth 2.1 sign-in with a client-id metadata document, PKCE, a loopback callback on `127.0.0.1:45871`–`45873`, and silent refresh from the harness credential store.
- Seven tools: `nexscope_sign_in`, `nexscope_status`, `nexscope_find_tools`, `nexscope_describe_tool`, `nexscope_call_tool`, `nexscope_export`, and `nexscope_account`.
- Bundled `nexscope` skill with routing, credit, error, export, workflow, and account rules.
- Format-1 plugin market index and icon.
- Tests: catalog search, result rendering, export conversion, account handling, OAuth callback validation, a real MCP client/server integration, and a real-Cordis composition test.

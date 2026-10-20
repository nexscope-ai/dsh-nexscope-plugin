# Changelog

## 0.1.0 — unreleased

First release.

- DSH bundle `@nexscope/dsh-nexscope` with `dsh.bundle.patch` and `engines.dsh >=0.2.0-rc.2 <0.3.0`.
- OAuth 2.1 sign-in with a client-id metadata document, PKCE, a loopback callback on `127.0.0.1:45871`–`45873`, and silent refresh from the harness credential store.
- Seven tools: `nexscope_sign_in`, `nexscope_status`, `nexscope_find_tools`, `nexscope_describe_tool`, `nexscope_call_tool`, `nexscope_export`, and `nexscope_account`.
- Bundled `nexscope` skill with routing, credit, error, export, workflow, and account rules.
- Format-1 plugin market index and icon.
- Tests: catalog search, result rendering, export conversion, account handling, OAuth callback validation, a real MCP client/server integration, and a real-Cordis composition test.

# ChatPro handoff

## Academic context and authorization

ChatPro is an academic project. The professor authorized modifications to the supplied open-source project so it can be adapted and documented for the course.

## Objective

The objective is to evolve the Electron-based ChatPro reference application into a web platform for workspace-scoped WhatsApp operations, while retaining the existing Electron build as the functional reference.

## Current state

- The Electron application is preserved in `build/` and was audited.
- The technical audit and inventory are in `LeadWave-Analysis/`.
- The web foundation exists in `web/`, with an Express API, TypeScript/Zod contracts, API tests, and a separate Baileys worker.
- The Baileys worker implements workspace-scoped session management, bounded reconnection, local credential storage abstractions, and safety-oriented validation.
- The established baseline reports 32 approved tests. Re-run the repository validations before relying on that count after any change.

## Platform decisions

The target uses Vercel Free for the web-facing layer and Supabase Free for future persistence. The Baileys worker is intentionally separate from Vercel workloads. The project has a zero-cost policy: do not introduce paid external APIs or services.

## Current limitations

- The API returns HTTP 501 for real operations.
- There is no internal transport between the API and worker yet.
- Workspace metadata is in memory.
- Authentication state is local and provisional; never commit it.
- Message delivery and pairing-code workflows are not connected.
- The current Baileys dependency chain has known transitive alerts; do not upgrade it as part of unrelated work.

## Next stage

Create an internal, zero-cost transport between the API and worker. Keep the worker isolated from public web hosting and preserve the existing contracts and test coverage.

## Rules for future Codex chats

- Preserve the Git history and work through reviewable branches and pull requests.
- Do not commit `.env` files, credentials, sessions, auth state, QR codes, logs, personal data, or real databases.
- Do not enable a real WhatsApp connection unless the task explicitly requires it.
- Do not add paid external APIs, deploy services, integrate Supabase, or create login flows without explicit authorization.
- Validate typecheck, tests, build, worker smoke behavior, secret scanning, and large files before publishing changes.

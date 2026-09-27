# Luraph Deobfuscator Discord Bot

A Discord bot that accepts Lua/Luau uploads, runs the bundled Luraph v15 deobfuscator, and returns the reconstructed script.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string
- Required secret: `DISCORD_BOT_TOKEN` — Discord bot token

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)
- Bot: discord.js Gateway client

## Where things live

- `artifacts/api-server/src/discord/bot.ts` — Discord commands, attachment handling, macro validation, job limits, and cleanup.
- `artifacts/api-server/deobfuscator/` — upstream Luraph v15 CLI plus the Linux Luau and Luau AST runtimes.
- `artifacts/api-server/src/index.ts` — starts the HTTP health server and Discord client.

## Architecture decisions

- The bot wraps the upstream CLI instead of reimplementing its deobfuscation pipeline, preserving its existing flags and output behavior.
- Each job runs in a unique temporary directory and is deleted after completion, including failed jobs.
- User-supplied CLI arguments are allowlisted and numeric macros are range-checked before spawning the child process.
- Discord jobs are bounded by input/output size, per-user cooldown, concurrent-job count, and a hard process timeout.

## Product

Use `!help` for the full command list. Use `!deobf` with a `.lua`/`.luau` attachment or fenced Lua code block. Supported aliases are `!deobfuscate`, `!commands`, and `!ping`. Deobfuscation macros mirror the upstream CLI, including `--debug`, `--no-devirt`, `--detect`, timeout/budget controls, and executor selection.

## User preferences

Keep the bot prefix at `!` unless a different value is explicitly configured with `DISCORD_PREFIX`.

## Gotchas

- The Discord application must have the Message Content Intent enabled or prefix commands will not be received.
- The bot requires the `DISCORD_BOT_TOKEN` secret; without it, the HTTP health service still starts but the Discord client stays disabled.
- The upstream runtime expects `bin/luau` and `bin/luau-ast` on Linux; both are checked into the deobfuscator runtime directory.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details

---
name: Linux Luau runtime
description: Why the deobfuscator keeps native Luau helpers alongside its source.
---

The upstream deobfuscator repository may include only `luau.exe` and `luau-ast.exe`. On Linux, the runtime looks for extensionless `bin/luau` and `bin/luau-ast`, so the native helpers must be built for the deployment environment and kept beside the copied deobfuscator source.

**Why:** The deobfuscator invokes both helpers for runtime tracing and AST parsing; Windows binaries fail silently as “not found” on Linux because the platform-specific filenames differ.

**How to apply:** When refreshing the upstream snapshot or moving this bot to another Linux host, verify both helper paths and run a small `--no-devirt` job before starting the Discord worker.
---
name: Deep Luraph traces
description: Runtime and delivery constraints for very large, deeply nested Luraph v15 traces.
---

Very deeply nested Luraph v15 traces can overflow Luau's native C stack during the renderer's recursive proxy/function expansion, even when tracing itself completed. Large successful traces can also exceed Discord's practical attachment size unless compressed.

**Why:** A real 2.5 MB protected input produced a 21 MB trace and exhausted the renderer stack before bounded rendering was added.

**How to apply:** Keep renderer recursion bounded so the job returns a partial but usable trace, and gzip oversized Lua outputs before sending them through Discord.
# Features

User-facing behavior of the local grokbot-mcp Worker, driven with curl against `POST /mcp`. Callbacks are the second HTTP surface and show up inside the journeys that need an answer.

| Feature | File |
| --- | --- |
| List tools and authenticate | [list-tools.md](list-tools.md) |
| Ask Grok Bot | [ask-grokbot.md](ask-grokbot.md) |
| Wait for an answer | [wait-for-grokbot-answer.md](wait-for-grokbot-answer.md) |
| Fetch a run | [get-grokbot-run.md](get-grokbot-run.md) |
| Cancel a run | [cancel-run.md](cancel-run.md) |

Launch and the read-only doctor check are in `../SKILL.md`. A journey that lacks a precondition fails; the reason is in that feature's Gotchas.

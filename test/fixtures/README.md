# Test fixtures

| File | Origin |
| --- | --- |
| `claude-stream.jsonl` | **Recorded** from Claude Code 2.1.288 (`-p --output-format stream-json --verbose --include-partial-messages`) on a small task. Local paths and signatures are scrubbed (which re-chunks the streamed tool-input fragments that contained a path); nothing else is changed. |
| `opencode.jsonl` | **Recorded** from OpenCode 1.18.34 (`run --format json --auto`) on the same small task, on one of its free models. Paths scrubbed. |
| `copilot.jsonl` | **Recorded** from GitHub Copilot CLI 1.0.91 (`-p --output-format json --allow-all`) on the same small task. Paths scrubbed; housekeeping events and opaque ids removed. |
| `codex-not-logged-in.jsonl` | **Recorded** from Codex CLI 0.160.0 (`exec --json`) run without being signed in. |
| `gemini-not-logged-in.stderr.txt` | **Recorded** stderr of Gemini CLI 0.62.0 run without being signed in. |
| `codex-success.synthetic.jsonl` | **Synthetic.** Written by hand from the `ThreadEvent` types published in `@openai/codex-sdk` 0.160.0, because no signed-in Codex was available to record. Replace with a real recording when you have one. |
| `gemini-success.synthetic.jsonl` | **Synthetic.** Written by hand from the stream-json formatter in the Gemini CLI 0.62.0 bundle, for the same reason. Replace with a real recording when you have one. |

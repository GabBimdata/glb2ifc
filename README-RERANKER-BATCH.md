# Qwen reranker — batch size fix

If llama.cpp returns an error like:

```txt
input (580 tokens) is too large to process. increase the physical batch size (current batch size: 512)
```

it means the reranker pair `query + candidate document` is longer than the
physical batch size used by `llama-server`.

V10 fixes this in two ways:

1. `server.js` now starts `llama-server` with `--batch-size 1024` by default.
2. The reranker query has been compacted so each candidate pair is shorter.

You can still override the value in `.env.local`:

```env
QWEN_LLAMA_BATCH=1024
```

For very long candidate documents or a larger knowledge base, use:

```env
QWEN_LLAMA_BATCH=2048
```

If VRAM/RAM is tight, try:

```env
QWEN_LLAMA_BATCH=1024
QWEN_LLAMA_UBATCH=256
```

After editing `.env.local`, restart the project:

```bash
bun dev
```

The status endpoint exposes the current batch configuration:

```txt
http://localhost:3737/api/qwen-status
```

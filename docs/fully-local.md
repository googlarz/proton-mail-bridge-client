# Fully local: no cloud LLM

**Experimental. Not validated by the maintainer.** The maintainer has not run this server with any local model, and nothing here has been tested end to end. This page describes what the code does and how to check a setup yourself. It does not claim that any local model is reliable at tool calling.

Goal: a local MCP client plus a model running on your own machine, so no mail text leaves it.

## What is already local

- **Mail access.** The server talks IMAP and SMTP to Proton Bridge on `127.0.0.1` (defaults `1143` and `1025`). Bridge decrypts locally.
- **Index.** Search runs on a SQLite index stored on your disk.
- **Semantic search (optional).** Off unless `PROTONMAIL_EMBEDDINGS_URL` is set. It must end in `/api/embed` (Ollama) or `/v1/embeddings` (OpenAI-compatible), and you run that endpoint. No model is bundled. By default only a loopback host is accepted; a remote host is refused unless `PROTONMAIL_EMBEDDINGS_ALLOW_REMOTE=true`. Redirects are not followed. The sent text is subject, sender and the first 1000 characters of the preview of each indexed message, plus each semantic query. See the README section on vector search.

If you leave embeddings unset, lexical search still works and nothing else is contacted by the search path.

## What leaves the machine with a cloud client

The text the model reads: every message body, subject, sender and attachment text a tool returns goes to the model provider, and so does what you type. The server's own local design does not change that. With a local model and a client that makes no outside calls, that path stays on your machine. Check the client yourself (see below); a client can still use a cloud provider, telemetry or update checks.

## Settings that matter for small models

- **`PROTONMAIL_MODE=read-only`.** Start here. Add `drafts` only once you trust the behaviour. Modes are in the README ("One switch").
- **`PROTONMAIL_TOOL_TIER=core`.** Exposes 25 tools instead of 128, so far less tool-definition text for a small context window. It exists today (`src/tools/definitions.ts`).
- **`PROTONMAIL_TOOLSET=core` or `reader`.** Available from the release that follows 2.17.7. `reader` lists only tools that change nothing in the mailbox. A profile only hides tools (and the prompts that name them); it never widens what the mode permits. Profiles are for MCP clients: the CLI always uses the full toolset.

## Judge a model yourself

Try a handful of real requests in `read-only` mode and check:

1. Does it call a search tool first, then a read tool on a result, rather than answering from nothing?
2. Does it respect read-only, and report a refusal instead of retrying or pretending it acted?
3. Does it invent message ids? Compare the ids in its calls with ids the search actually returned.
4. Does it stay coherent with the tool list in its context window, using `core`?

If it fails any of these, do not widen the mode. Ollama's own docs note that models can return several tool calls at once and that the client must loop; whether a given model does this well is for you to test.

## Prompt injection

Mail text is untrusted. A message can contain instructions aimed at the model. Small local models can be easier to steer than large hosted ones; this is a general concern, not something measured here. Keep `read-only` or `drafts` mode, so an injected instruction cannot send or delete anything. Keep human approval on tool calls if your client offers it. The server tells clients not to obey instructions found in mail, but a weak model may ignore that. See [threat-model.md](threat-model.md).

## Finding a client

You need an MCP client that can use a local model and launch a stdio server (`proton-mail-bridge-mcp`, configured like the README examples).

One I read about: [MCP Client for Ollama (`ollmcp`)](https://pypi.org/project/mcp-client-for-ollama/), an MIT-licensed terminal app that connects local Ollama models to MCP servers over stdio, SSE and Streamable HTTP, with approval prompts for tool calls. Its page says Ollama Cloud, other providers, remote servers and update checks use the network, so use only a local Ollama model, and check the update-check behaviour yourself. I have not run it.

I could not verify MCP support in other local-model front ends, so I list none. Check a client's current documentation, and watch its network traffic during a test.

Sources read (2026-11-02): the ollmcp PyPI page above; [Ollama tool calling docs](https://docs.ollama.com/capabilities/tool-calling); this repository's README and `src/services/embedding-service.ts`.

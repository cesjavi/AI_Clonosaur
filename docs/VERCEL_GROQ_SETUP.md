# Setting up Clonosaur with Groq (hybrid mode)

This guide covers the simple path: Clonosaur talking **directly** to the Groq API. There's also an
optional proxy backend (`vercel-backend/`) for when you distribute the app to other people and don't
want to put your real API key on every install — see the last section below and
`vercel-backend/README.md` for that path. For personal use, the direct setup below is enough.

## What already comes preloaded

The first time you open the app, `provider_credentials` is automatically seeded with:

- Provider: `groq`
- Base URL: `https://api.groq.com/openai/v1`
- Model: `llama-3.3-70b-versatile`
- API key: empty (it can't be hardcoded without permanently exposing it in the git history)

This only affects the chat's **hybrid mode** — "Simple" and "With memory (RAG)" still use local Ollama
unchanged, just like semantic search (Groq doesn't offer embeddings).

## Single step: paste your API key

1. Get your API key at [console.groq.com/keys](https://console.groq.com/keys).
2. Open the app → **Chat** screen → **Hybrid** mode.
3. If you haven't loaded a key yet, the "Configurar proveedor externo" form already appears open
   with `groq` and `llama-3.3-70b-versatile` preloaded — you just need to paste the API key there.
4. Save.

The key stays in your local database (`provider_credentials`), never in the source code.

## Privacy reminder

Hybrid mode never sends anything on its own: it always shows you the exact text (your message + profile +
relevant memories) before sending it to Groq, and asks for explicit confirmation every time ("Ver
preview" → "Confirmar y enviar"). You can anonymize your contacts' names before sending with
the "Anonimizar contactos" checkbox. Every send is logged in the auditable history
(`external_send_log`).

## If you want the proxy backend on Vercel

Worth it if you're going to distribute the app to other people and don't want each install to have
your real Groq API key. It's a separate Next.js project at `vercel-backend/` that acts as an
authenticated proxy: the app sends a shared secret instead of the real Groq key, and the proxy (which
holds the real key server-side) forwards the request to Groq. See `vercel-backend/README.md` for the
full setup and deploy steps. For personal use, the direct setup above is enough — you don't need this.

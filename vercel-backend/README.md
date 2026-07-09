# Clonosaur Vercel backend

Optional thin proxy for Clonosaur's hybrid chat mode. It exists for exactly
one reason: if you distribute the Clonosaur app to other people, you don't
want your real Groq API key baked into every installation. This proxy holds
the real key server-side; each app install only gets a shared secret that
this proxy checks before forwarding the request to Groq.

If you're the only person using your own Clonosaur install, you don't need
this at all — just paste your Groq API key directly into the app (see
`docs/VERCEL_GROQ_SETUP.md` in the main repo).

## How it works

Clonosaur's hybrid mode (`src-tauri/src/hybrid.rs::send_to_external_provider`)
already sends `POST {base_url}/chat/completions` with `Authorization: Bearer
{api_key}` and a `{model, messages}` body, then expects an OpenAI-shaped
`{choices:[{message:{content}}]}` response back. That means this proxy needs
no changes on the Rust side — it just needs to expose the same shape:

1. The app sends `Authorization: Bearer <CLONOSAUR_SHARED_SECRET>` (not the
   real Groq key) to this proxy's `/chat/completions` route.
2. This route checks the secret, then calls the real Groq API with
   `GROQ_API_KEY` (only ever read from the server's environment).
3. Groq's response is passed straight back to the app.

## Local development

```bash
npm install
cp .env.example .env.local   # fill in GROQ_API_KEY and CLONOSAUR_SHARED_SECRET
npm run dev
```

Test it directly:

```bash
curl -X POST http://localhost:3000/chat/completions \
  -H "Authorization: Bearer <CLONOSAUR_SHARED_SECRET>" \
  -H "Content-Type: application/json" \
  -d '{"model":"llama-3.3-70b-versatile","messages":[{"role":"user","content":"hi"}]}'
```

## Deploying to Vercel

1. Install the CLI once if you haven't: `npm i -g vercel`.
2. From this folder, log in and link the project:
   ```bash
   vercel login
   vercel link
   ```
3. Set the two secrets (do this for `production`, and again for `preview` if
   you plan to test PR deploys):
   ```bash
   vercel env add GROQ_API_KEY production
   vercel env add CLONOSAUR_SHARED_SECRET production
   ```
4. Deploy:
   ```bash
   vercel --prod
   ```
   This prints the deployed URL, e.g. `https://clonosaur-proxy.vercel.app`.

## Pointing the app at it

In Clonosaur: **Chat → Híbrido → Configurar proveedor externo**:

- Provider: `custom`
- Base URL: the URL from step 4 above (no trailing slash, no `/chat/completions` — the app appends that itself)
- Model: any Groq model, e.g. `llama-3.3-70b-versatile`
- API key: the `CLONOSAUR_SHARED_SECRET` value — **not** your real Groq key

Save, then send a hybrid message as usual. The preview/confirm step and the
`external_send_log` audit trail work exactly the same as with a direct Groq
connection — only the network hop and where the real key lives changes.

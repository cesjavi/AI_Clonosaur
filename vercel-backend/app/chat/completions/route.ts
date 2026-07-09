const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

interface ChatMessage {
  role: string;
  content: string;
}

interface ChatRequestBody {
  model: string;
  messages: ChatMessage[];
}

/**
 * Thin authenticated proxy in front of Groq. Clonosaur's hybrid mode already
 * knows how to talk to any OpenAI-compatible `{base_url}/chat/completions`
 * endpoint with a Bearer token (see src-tauri/src/hybrid.rs), so this route
 * just needs to swap that token: the Clonosaur app sends CLONOSAUR_SHARED_SECRET,
 * this route checks it, then calls Groq with the real GROQ_API_KEY that only
 * lives on the server. That's the whole point — installs of the app never
 * carry the real Groq key.
 */
export async function POST(request: Request) {
  const auth = request.headers.get("authorization") ?? "";
  const token = auth.replace(/^Bearer\s+/i, "");
  const sharedSecret = process.env.CLONOSAUR_SHARED_SECRET;

  if (!sharedSecret) {
    return Response.json({ error: "CLONOSAUR_SHARED_SECRET is not configured on the server" }, { status: 500 });
  }
  if (token !== sharedSecret) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const groqApiKey = process.env.GROQ_API_KEY;
  if (!groqApiKey) {
    return Response.json({ error: "GROQ_API_KEY is not configured on the server" }, { status: 500 });
  }

  let body: ChatRequestBody;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  if (!body.model || !Array.isArray(body.messages)) {
    return Response.json({ error: "body must include 'model' and 'messages'" }, { status: 400 });
  }

  const groqResponse = await fetch(GROQ_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${groqApiKey}`,
    },
    body: JSON.stringify({ model: body.model, messages: body.messages, stream: false }),
  });

  const text = await groqResponse.text();
  return new Response(text, {
    status: groqResponse.status,
    headers: { "Content-Type": "application/json" },
  });
}

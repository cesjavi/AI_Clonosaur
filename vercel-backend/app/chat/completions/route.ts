import { timingSafeEqual } from "node:crypto";

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": process.env.CLONOSAUR_CORS_ORIGIN || "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

interface ChatMessage {
  role: string;
  content: string;
}

interface ChatRequestBody {
  model: string;
  messages: ChatMessage[];
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function jsonWithCors(data: unknown, status: number): Response {
  return Response.json(data, { status, headers: CORS_HEADERS });
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
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
  const match = auth.match(/^Bearer\s+(.+)$/i);
  const token = match ? match[1] : "";
  const sharedSecret = process.env.CLONOSAUR_SHARED_SECRET;

  if (!sharedSecret) {
    return jsonWithCors({ error: "CLONOSAUR_SHARED_SECRET is not configured on the server" }, 500);
  }
  if (!token || !constantTimeEquals(token, sharedSecret)) {
    return jsonWithCors({ error: "unauthorized" }, 401);
  }

  const groqApiKey = process.env.GROQ_API_KEY;
  if (!groqApiKey) {
    return jsonWithCors({ error: "GROQ_API_KEY is not configured on the server" }, 500);
  }

  let body: ChatRequestBody;
  try {
    body = await request.json();
  } catch {
    return jsonWithCors({ error: "invalid JSON body" }, 400);
  }

  if (!body || typeof body !== "object" || !body.model || !Array.isArray(body.messages)) {
    return jsonWithCors({ error: "body must include 'model' and 'messages'" }, 400);
  }

  let groqResponse: Response;
  try {
    groqResponse = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${groqApiKey}`,
      },
      body: JSON.stringify({ model: body.model, messages: body.messages, stream: false }),
    });
  } catch {
    return jsonWithCors({ error: "failed to reach upstream Groq API" }, 502);
  }

  const text = await groqResponse.text();
  return new Response(text, {
    status: groqResponse.status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

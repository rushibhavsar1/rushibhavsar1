import { createAnthropicClient } from "@/lib/ai";

export interface FakeReply {
  /** JSON object the model "returns" (serialized into a text block). */
  output?: unknown;
  text?: string;
  stop_reason?: "end_turn" | "max_tokens" | "refusal";
  stop_details?: { type: "refusal"; category: string | null; explanation?: string } | null;
  model?: string;
  usage?: Partial<{
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
  }>;
}

export interface CapturedRequest {
  url: string;
  body: {
    model: string;
    system: Array<{ type: string; text: string; cache_control?: { type: string } }>;
    messages: Array<{ role: string; content: string }>;
    output_config?: { effort?: string; format?: { type: string; schema: unknown } };
    fallbacks?: unknown;
    max_tokens: number;
  };
  headers: Headers;
}

/**
 * A mocked Anthropic Messages API. The real SDK runs (request building,
 * structured-output parsing); only the HTTP layer is replaced.
 */
export function fakeAnthropic(responder: (req: CapturedRequest) => FakeReply) {
  const requests: CapturedRequest[] = [];
  const fetchFn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const req: CapturedRequest = {
      url: String(input instanceof Request ? input.url : input),
      body: JSON.parse(String(init?.body ?? "{}")),
      headers: new Headers(init?.headers),
    };
    requests.push(req);
    const r = responder(req);
    const payload = {
      id: `msg_${requests.length}`,
      type: "message",
      role: "assistant",
      model: r.model ?? req.body.model,
      content: [{ type: "text", text: r.text ?? JSON.stringify(r.output ?? {}) }],
      stop_reason: r.stop_reason ?? "end_turn",
      stop_sequence: null,
      stop_details: r.stop_details ?? null,
      usage: {
        input_tokens: 120,
        output_tokens: 80,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        ...r.usage,
      },
    };
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json", "request-id": `req_${requests.length}` },
    });
  };
  const client = createAnthropicClient({ apiKey: "test-key", fetch: fetchFn as typeof fetch, maxRetries: 0 });
  return { client, requests };
}

/** Responds like a sensible model: classifies as `category` and drafts a reply. */
export function scriptedModel(opts: { category?: "lead" | "support" | "spam"; draftBody?: string } = {}) {
  return (req: CapturedRequest): FakeReply => {
    if (req.body.model.startsWith("claude-haiku")) {
      return {
        output: { category: opts.category ?? "lead", reason: "Asks about prices and availability" },
        usage: { input_tokens: 60, cache_read_input_tokens: 900, output_tokens: 40 },
      };
    }
    return {
      output: {
        subject: "Teeth whitening next week",
        body:
          opts.draftBody ??
          "Hi Jane,\n\nThanks for getting in touch! Whitening is $299 for a 60-minute session. You can pick a time here: https://cal.com/brightsmile/intro\n\nMaria",
      },
      usage: { input_tokens: 200, cache_creation_input_tokens: 1500, output_tokens: 300 },
    };
  };
}

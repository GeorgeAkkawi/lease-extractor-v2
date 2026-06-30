// Thin wrapper over the Anthropic Messages API. Raw fetch (Deno edge runtime)
// keeps the dependency surface small; request shapes follow the documented API.
// Cost rule: callers pass already-computed numbers — the model only reads/writes
// language, never does arithmetic.
const API_URL = 'https://api.anthropic.com/v1/messages';
const VERSION = '2023-06-01';

export type Block =
  // cache_control lets a large, reused text block be cached for prompt-caching
  // discounts while staying in the user turn (so user content never sits in the
  // system-prompt position).
  | { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }
  | { type: 'document'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };

interface CallOpts {
  model: string;
  // string for a plain instruction, or an array of system blocks (e.g. to attach
  // cache_control for prompt caching on a large, reused context like a lease).
  system?: string | Array<Record<string, unknown>>;
  content: Block[] | string;
  maxTokens?: number;
  schema?: Record<string, unknown>; // when set -> structured JSON output
  // Lower effort = fewer generated tokens = faster AND cheaper. Extraction (fill a
  // known schema) needs little reasoning, so those callers pass 'low'. Sonnet 4.6
  // only — effort is rejected on Haiku, so never set it for Haiku-based callers.
  effort?: 'low' | 'medium' | 'high';
}

/** Returns parsed JSON (if schema given) or the concatenated text. Throws on refusal/error. */
export async function callClaude(opts: CallOpts): Promise<any> {
  const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');

  const body: Record<string, unknown> = {
    model: opts.model,
    max_tokens: opts.maxTokens ?? 4096,
    messages: [
      {
        role: 'user',
        content:
          typeof opts.content === 'string'
            ? [{ type: 'text', text: opts.content }]
            : opts.content,
      },
    ],
  };
  if (opts.system) body.system = opts.system;
  // output_config carries the structured-output format (constrain to the JSON
  // schema — do NOT also enable document citations, that combination is rejected)
  // and the effort dial. Assemble both; set the field only when non-empty.
  const outputConfig: Record<string, unknown> = {};
  if (opts.schema) outputConfig.format = { type: 'json_schema', schema: opts.schema };
  if (opts.effort) outputConfig.effort = opts.effort;
  if (Object.keys(outputConfig).length) body.output_config = outputConfig;

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': VERSION,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${errText}`);
  }

  const data = await res.json();
  if (data.stop_reason === 'refusal') {
    throw new Error('The model declined this request.');
  }

  const text = (data.content ?? [])
    .filter((b: any) => b.type === 'text')
    .map((b: any) => b.text)
    .join('');

  if (opts.schema) {
    try {
      return JSON.parse(text);
    } catch {
      throw new Error('Model returned non-JSON output.');
    }
  }
  return text;
}

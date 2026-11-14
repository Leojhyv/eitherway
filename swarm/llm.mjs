// Optional: let a language model make the two judgment calls an agent has.
//
//   1. A backer agent reads a campaign and decides how well it matches what
//      its user said they care about (one sentence, the "mandate").
//   2. An underwriter agent reads the same campaign and says, in a sentence it
//      is willing to post publicly, why it would or would not guarantee it.
//
// Everything else (how much to pledge, what fee to bid, when to act) stays in
// the scripted strategies, where it can be tested.
//
// Uses NEAR AI Cloud (OpenAI-style API). Set NEARAI_API_KEY. Without a key,
// or without --llm, no model is ever called.

const ENDPOINT = 'https://cloud-api.near.ai/v1/chat/completions';
export const DEFAULT_MODEL = 'z-ai/glm-5.3-flash';

export class Llm {
  constructor({ apiKey = process.env.NEARAI_API_KEY, model = DEFAULT_MODEL, log = () => {} } = {}) {
    this.apiKey = apiKey;
    this.model = model;
    this.log = log;
    this.calls = 0;
    this.jsonMode = true;
    this.tokens = { input: 0, output: 0 };
  }
  get available() {
    return Boolean(this.apiKey);
  }

  /** One chat call that must answer with a JSON object. Returns null on any failure. */
  async json(system, user, maxTokens = 320) {
    if (!this.available) return null;
    try {
      const request = (jsonMode) => fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({
          model: this.model,
          max_tokens: maxTokens,
          temperature: 0.2,
          // Reasoning models otherwise spend the whole budget thinking.
          chat_template_kwargs: { enable_thinking: false, thinking: false },
          ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
          messages: [
            { role: 'system', content: `${system} Output the JSON object and nothing else: no analysis, no preamble.` },
            { role: 'user', content: user },
          ],
        }),
        signal: AbortSignal.timeout(45_000),
      });
      let res = await request(this.jsonMode);
      if (res.status === 400 && this.jsonMode) {
        this.jsonMode = false; // this model does not take response_format
        res = await request(false);
      }
      if (!res.ok) throw new Error(`http ${res.status} ${(await res.text()).slice(0, 200)}`);
      const body = await res.json();
      this.calls++;
      this.tokens.input += body.usage?.prompt_tokens ?? 0;
      this.tokens.output += body.usage?.completion_tokens ?? 0;
      const text = body.choices?.[0]?.message?.content ?? '';
      const start = text.indexOf('{');
      const end = text.lastIndexOf('}');
      if (start < 0 || end <= start) throw new Error(`no JSON in reply: ${text.slice(0, 120)}`);
      return JSON.parse(text.slice(start, end + 1));
    } catch (e) {
      this.log(`model call failed, using the scripted rule instead: ${e.message}`);
      return null;
    }
  }

  /** How much does this user want this project? 0 to 1, or null to fall back. */
  async match(mandate, campaign) {
    const out = await this.json(
      'You act for one person deciding whether to chip in to a community crowdfunding campaign. ' +
        'Judge only how well the campaign fits what the person said they care about. ' +
        'Reply with JSON only: {"match": number from 0 to 1, "why": "at most 12 words"}.',
      `What the person cares about: ${mandate}\n\nCampaign: ${campaign.title}\n${campaign.text ?? ''}`,
    );
    const m = Number(out?.match);
    return Number.isFinite(m) ? { match: Math.min(1, Math.max(0, m)), why: String(out.why ?? '').slice(0, 120) } : null;
  }

  /** A qualitative read for an underwriter: -1 (doubtful), 0, or +1 (confident), with a public reason. */
  async assess(context) {
    const out = await this.json(
      'You underwrite community crowdfunding campaigns: you lose money if a campaign you guarantee misses its goal. ' +
        'Given the facts, say whether they make you more or less confident than the numbers alone. ' +
        'Reply with JSON only: {"lean": -1 or 0 or 1, "why": "one plain sentence, at most 20 words"}.',
      context,
      200,
    );
    const lean = Number(out?.lean);
    return [-1, 0, 1].includes(lean) ? { lean, why: String(out.why ?? '').slice(0, 200) } : null;
  }
}

/** One sentence describing what a backer's user cares about, for the model and the page. */
export function mandateText(backer, scale = 1) {
  const topics = Object.entries(backer.interests).sort((a, b) => b[1] - a[1]).map(([t]) => t);
  const cap = Number(backer.cap / 10n ** 18n) / 1e6 * scale;
  const tone = {
    believer: 'I back things early.',
    follower: 'I like to see others commit first.',
    holdout: 'I would rather others paid, but I will step in if it is close.',
    hunter: 'I am here for the bonus, not the projects.',
  }[backer.kind];
  return `I care about ${topics.join(' and ')}. Up to ${cap.toFixed(3)} NEAR per project. ${tone}`;
}

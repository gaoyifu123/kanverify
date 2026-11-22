// Anthropic Messages API. https://docs.anthropic.com/en/api/messages
import { AiError } from './errors.js';
import { postJson, requireNormalStop } from './http.js';

export const ENDPOINT = 'https://api.anthropic.com/v1/messages';
export const API_VERSION = '2023-06-01';
// Basic server-side web search: the API runs the searches itself, called directly by the model,
// without the code-execution sandbox the later versions bring (principle 5). Checked against
// https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool on 2026-11-22.
export const WEB_SEARCH_TOOL = 'web_search_20250305';
// A long search turn may come back with stop_reason pause_turn; the documented way on is to send
// the paused assistant content back unchanged. Bounded, so a turn can never loop for ever.
export const MAX_CONTINUATIONS = 3;

// Without a document the content stays a plain string, as before.
function userContent(req) {
  if (!req.documents) return req.prompt;
  return [
    ...req.documents.map(({ mediaType, data }) => ({
      type: 'document', source: { type: 'base64', media_type: mediaType, data: Buffer.from(data).toString('base64') },
    })),
    { type: 'text', text: req.prompt },
  ];
}

// With web search the content interleaves text ("I'll search for…"), server_tool_use and
// web_search_tool_result blocks. Only the text after the last non-text block is the answer.
function finalText(content) {
  let last = -1;
  content.forEach((b, i) => { if (b?.type !== 'text') last = i; });
  return content.slice(last + 1).filter((b) => b?.type === 'text').map((b) => b.text).join('');
}

// URLs and titles of every search result the API returned, so a caller can check that a URL the
// model proposes was really among the results. Error results carry no list and are counted.
function searchResults(content) {
  const results = [];
  let errors = 0;
  for (const block of content) {
    if (block?.type !== 'web_search_tool_result') continue;
    if (!Array.isArray(block.content)) { errors++; continue; }
    for (const r of block.content) {
      if (r?.type === 'web_search_result' && typeof r.url === 'string') results.push({ url: r.url, title: typeof r.title === 'string' ? r.title : null });
    }
  }
  return { results, errors };
}

export default {
  name: 'anthropic',
  keyVar: 'ANTHROPIC_API_KEY',
  // https://docs.anthropic.com/en/docs/build-with-claude/pdf-support
  documentTypes: ['application/pdf'],
  webSearch: true,
  async call(req, ctx) {
    const messages = [{ role: 'user', content: userContent(req) }];
    const body = { model: req.model, max_tokens: req.maxTokens, messages };
    if (req.system) body.system = req.system;
    if (req.webSearch) body.tools = [{ type: WEB_SEARCH_TOOL, name: 'web_search', max_uses: req.webSearch.maxUses }];
    // No native JSON mode is used here; the layer parses and validates the text itself.
    const usage = { inputTokens: 0, outputTokens: 0 };
    const content = [];
    const raws = [];
    let webSearchRequests = 0;
    for (let round = 0; ; round++) {
      const raw = await postJson(ctx, ENDPOINT, { 'x-api-key': ctx.key, 'anthropic-version': API_VERSION }, body);
      raws.push(raw);
      if (!Array.isArray(raw.content)) throw new AiError('bad_response', 'anthropic: no content in response', { provider: 'anthropic' });
      usage.inputTokens += raw.usage?.input_tokens ?? 0;
      usage.outputTokens += raw.usage?.output_tokens ?? 0;
      webSearchRequests += raw.usage?.server_tool_use?.web_search_requests ?? 0;
      content.push(...raw.content);
      if (req.webSearch && raw.stop_reason === 'pause_turn' && round < MAX_CONTINUATIONS) {
        // The paused turn is sent back as it came, as one assistant message holding everything so far.
        body.messages = [messages[0], { role: 'assistant', content: [...content] }];
        continue;
      }
      // end_turn is a normal finish; stop_sequence too, though no stop sequences are sent.
      // pause_turn past the bound, max_tokens, refusal and anything else are errors.
      requireNormalStop('anthropic', raw.stop_reason, ['end_turn', 'stop_sequence']);
      const result = {
        text: finalText(content),
        modelVersion: raw.model,
        usage: raw.usage || raws.length > 1 ? usage : undefined,
        raw: raws.length === 1 ? raw : raws,
      };
      if (req.webSearch) result.webSearch = { requests: webSearchRequests, ...searchResults(content) };
      return result;
    }
  },
};

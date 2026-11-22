// Request and response shape shared by OpenAI and Mistral (both expose /v1/chat/completions).
import { AiError } from './errors.js';
import { postJson, requireNormalStop } from './http.js';

// content is a string, or (Mistral, e.g. reasoning models) an array of chunks. Only text chunks
// are the answer; thinking chunks are dropped, as for Anthropic and Gemini.
function contentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter((c) => c?.type === 'text' && typeof c.text === 'string').map((c) => c.text).join('');
  }
  return undefined;
}

export function chatCompletionsAdapter({ name, keyVar, url, maxTokensField }) {
  return {
    name,
    keyVar,
    async call(req, ctx) {
      const messages = [];
      if (req.system) messages.push({ role: 'system', content: req.system });
      messages.push({ role: 'user', content: req.prompt });
      const body = { model: req.model, messages, [maxTokensField]: req.maxTokens };
      if (req.json) body.response_format = { type: 'json_object' };
      const raw = await postJson(ctx, url, { authorization: `Bearer ${ctx.key}` }, body);
      const choice = raw.choices?.[0];
      if (!choice) throw new AiError('bad_response', `${name}: no choice in response`, { provider: name });
      requireNormalStop(name, choice.finish_reason, ['stop']);
      const text = contentText(choice.message?.content);
      if (typeof text !== 'string') throw new AiError('bad_response', `${name}: no message content in response`, { provider: name });
      return {
        text,
        modelVersion: raw.model,
        usage: raw.usage && { inputTokens: raw.usage.prompt_tokens, outputTokens: raw.usage.completion_tokens },
        raw,
      };
    },
  };
}

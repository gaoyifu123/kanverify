// Google Gemini API, generateContent. https://ai.google.dev/api/generate-content
// The key goes in the x-goog-api-key header, never in the URL, so it cannot leak through
// an error message or a log line that prints the address.
import { AiError } from './errors.js';
import { postJson, requireNormalStop } from './http.js';

export const BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';
const MODEL_RE = /^[A-Za-z0-9._-]+$/;

export default {
  name: 'gemini',
  keyVar: 'GEMINI_API_KEY',
  // https://ai.google.dev/gemini-api/docs/document-processing (inline data, under 20 MB per request)
  documentTypes: ['application/pdf'],
  async call(req, ctx) {
    if (!MODEL_RE.test(req.model)) throw new AiError('bad_request', 'gemini: model name has characters not allowed in a URL path', { provider: 'gemini' });
    const generationConfig = { maxOutputTokens: req.maxTokens };
    if (req.json) generationConfig.responseMimeType = 'application/json';
    const userParts = [{ text: req.prompt }];
    if (req.documents) {
      userParts.unshift(...req.documents.map(({ mediaType, data }) => ({ inline_data: { mime_type: mediaType, data: Buffer.from(data).toString('base64') } })));
    }
    const body = { contents: [{ role: 'user', parts: userParts }], generationConfig };
    if (req.system) body.systemInstruction = { parts: [{ text: req.system }] };
    const raw = await postJson(ctx, `${BASE}${req.model}:generateContent`, { 'x-goog-api-key': ctx.key }, body);
    const candidate = raw.candidates?.[0];
    if (!candidate) throw new AiError('bad_response', 'gemini: no candidate in response', { provider: 'gemini' });
    requireNormalStop('gemini', candidate.finishReason, ['STOP']);
    const parts = candidate.content?.parts;
    if (!Array.isArray(parts)) throw new AiError('bad_response', 'gemini: no candidate content in response', { provider: 'gemini' });
    const text = parts.filter((p) => typeof p?.text === 'string' && !p.thought).map((p) => p.text).join('');
    const u = raw.usageMetadata;
    return {
      text,
      modelVersion: raw.modelVersion,
      usage: u && { inputTokens: u.promptTokenCount, outputTokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0) },
      raw,
    };
  },
};

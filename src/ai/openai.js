// OpenAI Chat Completions API. https://platform.openai.com/docs/api-reference/chat/create
// max_completion_tokens replaces the deprecated max_tokens (rejected by reasoning models).
import { chatCompletionsAdapter } from './chat-completions.js';

export const ENDPOINT = 'https://api.openai.com/v1/chat/completions';

export default chatCompletionsAdapter({
  name: 'openai',
  keyVar: 'OPENAI_API_KEY',
  url: ENDPOINT,
  maxTokensField: 'max_completion_tokens',
});

// Mistral Chat Completion API. https://docs.mistral.ai/api/
import { chatCompletionsAdapter } from './chat-completions.js';

export const ENDPOINT = 'https://api.mistral.ai/v1/chat/completions';

export default chatCompletionsAdapter({
  name: 'mistral',
  keyVar: 'MISTRAL_API_KEY',
  url: ENDPOINT,
  maxTokensField: 'max_tokens',
});

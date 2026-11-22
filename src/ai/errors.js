// The one error type the AI layer throws. `code` is one of:
// bad_request, unsupported, unknown_provider, missing_key, network, timeout, http, bad_response, bad_json.
export class AiError extends Error {
  constructor(code, message, { provider, status } = {}) {
    super(message);
    this.name = 'AiError';
    this.code = code;
    if (provider !== undefined) this.provider = provider;
    if (status !== undefined) this.status = status;
  }
}

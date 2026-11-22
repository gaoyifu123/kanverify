// Scripted adapter for tests. Never touches the network and needs no key.
// Each step is a string (the reply text), an Error (thrown), or a function (req) => string.
export function createFakeAdapter(script) {
  const steps = [...script];
  const calls = [];
  return {
    name: 'fake',
    keyVar: null,
    documentTypes: ['application/pdf'],
    calls,
    async call(req) {
      calls.push(req);
      if (steps.length === 0) throw new Error('fake adapter: script exhausted');
      const step = steps.shift();
      if (step instanceof Error) throw step;
      const text = typeof step === 'function' ? step(req) : step;
      return { text, usage: { inputTokens: 0, outputTokens: 0 }, raw: { text } };
    },
  };
}

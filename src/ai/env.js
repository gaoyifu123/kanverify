// Tiny .env loader (principle 5: built-in util.parseEnv, no dependency).
// Reads KEY=VALUE pairs into an env object without overriding what is already set.
// It never prints anything: keys must not reach logs, errors or files.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

export const DEFAULT_ENV_FILE = resolve(dirname(fileURLToPath(import.meta.url)), '../../.env');

// Returns the names (never the values) of the variables it set. A missing file is not an error:
// the founder may not have created .env yet, and keys can also come from the real environment.
export function loadEnv(path = DEFAULT_ENV_FILE, env = process.env) {
  let content;
  try {
    content = readFileSync(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw new Error(`could not read env file ${path} (${error.code})`);
  }
  const set = [];
  for (const [name, value] of Object.entries(parseEnv(content))) {
    if (env[name] === undefined || env[name] === '') {
      env[name] = value;
      set.push(name);
    }
  }
  return set;
}

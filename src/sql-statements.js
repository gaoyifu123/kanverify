// Reading SQL text for record-format upgrades (src/db.js upgradeDatabase). Pure functions: nothing
// here opens a database.
//
// - tokenize: SQLite's token rules, enough for our own schema and migration files: comments and
//   spaces dropped, strings and quoted names kept whole.
// - splitStatements: one entry per statement; a CREATE TRIGGER's BEGIN ... END is one statement.
// - normalize: the same statement written with other spaces, comments, line ends or keyword case
//   gives the same text; anything else (a string, a number, a name, a sign) is kept. Used to compare
//   a migrated schema with a fresh one, because ALTER TABLE ... ADD COLUMN rewrites a table's text
//   in its own way (Fable review 10, finding 5).
// - checkMigrationStatement: the whitelist of statements a migration may contain (finding 4).
//
// Text it reads (Fable review 11, findings 1 and 2): no control characters but tab, line feed and
// carriage return (a NUL ends a statement for SQLite but not for this reader); only those three and
// the space count as spaces (SQLite's set, not JavaScript's \s); nothing but ASCII outside comments
// and string literals, so a name cannot hide a no-break space, a line separator or a letter whose
// case folds differently; and case is folded for ASCII letters only.

const WORD = /[A-Za-z_][A-Za-z0-9_$]*/y;
const PLAIN_NAME = /^[A-Za-z_][A-Za-z0-9_$]*$/;
const SPACES = new Set([' ', '\t', '\n', '\r']);
/** Upper case for ASCII letters only. */
const foldUpper = (x) => x.replace(/[a-z]+/g, (m) => m.toUpperCase());
const foldLower = (x) => x.replace(/[A-Z]+/g, (m) => m.toLowerCase());
const hex = (c) => `U+${c.toString(16).toUpperCase().padStart(4, '0')}`;
const NUMBER = /(?:0[xX][0-9a-fA-F]+|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)/y;
const OPERATORS = ['->>', '||', '<=', '>=', '==', '!=', '<>', '<<', '>>', '->'];

/**
 * @param {string} sql
 * @returns {{ type: 'word'|'name'|'string'|'number'|'punct', value: string, start: number, end: number }[]}
 *   'word' is a bare word (keyword or name); 'name' a quoted name, unquoted in `value`.
 */
export function tokenize(sql) {
  const tokens = [];
  let i = 0;
  const n = sql.length;
  for (let k = 0; k < n; k += 1) {
    const c = sql.charCodeAt(k);
    if ((c < 0x20 && c !== 9 && c !== 10 && c !== 13) || c === 0x7f) {
      throw new Error(`control character ${hex(c)} at character ${k}: only tab, line feed and carriage return are allowed`);
    }
  }
  const ascii = (from, to) => {
    for (let k = from; k < to; k += 1) {
      if (sql.charCodeAt(k) > 0x7e) throw new Error(`non-ASCII character ${hex(sql.charCodeAt(k))} at character ${k}, outside comments and string literals`);
    }
  };
  while (i < n) {
    const ch = sql[i];
    if (SPACES.has(ch)) { i += 1; continue; }
    if (ch === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i);
      i = nl === -1 ? n : nl + 1;
      continue;
    }
    if (ch === '/' && sql[i + 1] === '*') {
      const close = sql.indexOf('*/', i + 2);
      if (close === -1) throw new Error('a /* comment is not closed');
      i = close + 2;
      continue;
    }
    const start = i;
    if (ch === "'" || ch === '"' || ch === '`') {
      let j = i + 1;
      let value = '';
      for (;;) {
        if (j >= n) throw new Error(`a quoted text starting at character ${start} is not closed`);
        if (sql[j] === ch) {
          if (sql[j + 1] === ch) { value += ch; j += 2; continue; }
          break;
        }
        value += sql[j];
        j += 1;
      }
      i = j + 1;
      if (ch !== "'") ascii(start, i);
      tokens.push(ch === "'"
        ? { type: 'string', value: sql.slice(start, i), start, end: i }
        : { type: 'name', value, start, end: i });
      continue;
    }
    if (ch === '[') {
      const close = sql.indexOf(']', i);
      if (close === -1) throw new Error(`a [name] starting at character ${start} is not closed`);
      i = close + 1;
      ascii(start, i);
      tokens.push({ type: 'name', value: sql.slice(start + 1, close), start, end: i });
      continue;
    }
    NUMBER.lastIndex = i;
    const num = /[0-9.]/.test(ch) ? NUMBER.exec(sql) : null;
    if (num && num[0] !== '.') {
      i += num[0].length;
      tokens.push({ type: 'number', value: num[0], start, end: i });
      continue;
    }
    WORD.lastIndex = i;
    const word = WORD.exec(sql);
    if (word) {
      i += word[0].length;
      tokens.push({ type: 'word', value: word[0], start, end: i });
      continue;
    }
    ascii(i, i + 1);
    const op = OPERATORS.find((o) => sql.startsWith(o, i)) ?? ch;
    i += op.length;
    tokens.push({ type: 'punct', value: op, start, end: i });
  }
  return tokens;
}

const upper = (t) => (t && (t.type === 'word' || t.type === 'name') ? foldUpper(t.value) : null);
const isWord = (t, ...words) => Boolean(t) && t.type === 'word' && words.includes(foldUpper(t.value));

/**
 * Splits SQL text into statements, each with its tokens and its exact text (comments before it
 * dropped). A trigger's body (BEGIN ... END, with CASE ... END inside) stays in one statement.
 * @returns {{ text: string, tokens: ReturnType<typeof tokenize> }[]}
 */
export function splitStatements(sql) {
  const tokens = tokenize(sql);
  const out = [];
  let current = [];
  let inBody = false;
  let caseDepth = 0;
  const flush = () => {
    if (current.length > 0) {
      out.push({ text: sql.slice(current[0].start, current.at(-1).end), tokens: current });
    }
    current = [];
    inBody = false;
    caseDepth = 0;
  };
  const isTrigger = () => isWord(current[0], 'CREATE')
    && (isWord(current[1], 'TRIGGER') || (isWord(current[1], 'TEMP', 'TEMPORARY') && isWord(current[2], 'TRIGGER')));
  for (const t of tokens) {
    if (t.type === 'punct' && t.value === ';' && !inBody) { flush(); continue; }
    current.push(t);
    if (!isTrigger()) continue;
    if (!inBody && isWord(t, 'BEGIN')) { inBody = true; continue; }
    if (inBody && isWord(t, 'CASE')) caseDepth += 1;
    else if (inBody && isWord(t, 'END')) {
      if (caseDepth > 0) caseDepth -= 1;
      else inBody = false; // the trigger's own END: the next ';' ends the statement
    }
  }
  if (inBody) throw new Error('a CREATE TRIGGER has no END');
  flush();
  return out;
}

/**
 * One line per statement shape: spaces and comments gone, keywords and bare names in ASCII capitals.
 * A quoted name that is a plain identifier ("id") reads as the bare name; any other quoted name stays
 * quoted and exact, so "id INTEGER PRIMARY KEY" as one column name never equals three words.
 */
export function normalize(sql) {
  return tokenize(sql)
    .filter((t) => !(t.type === 'punct' && t.value === ';'))
    .map((t) => {
      if (t.type === 'word') return foldUpper(t.value);
      if (t.type === 'name') return PLAIN_NAME.test(t.value) ? foldUpper(t.value) : `"${t.value.replaceAll('"', '""')}"`;
      return t.value;
    })
    .join(' ');
}

// Names nothing in a migration may mention, wherever they appear.
const FORBIDDEN_NAMES = new Set([
  'PUBLICATIONS', 'CURRENT_PUBLICATIONS', 'SQLITE_SEQUENCE', 'SQLITE_MASTER', 'SQLITE_SCHEMA',
  'SQLITE_TEMP_MASTER', 'SQLITE_TEMP_SCHEMA', 'WRITABLE_SCHEMA', 'PRAGMA', 'ATTACH', 'DETACH',
  'VACUUM', 'LOAD_EXTENSION', 'TEMP', 'TEMPORARY',
]);

/** The lists a migration may add codes to (record format 13). */
export const LOOKUP_TABLES = Object.freeze(['claim_domains', 'source_kinds']);

/**
 * Reads `[schema .] name` at tokens[i]. Only the main schema is accepted.
 * @returns {{ name: string, next: number }}
 */
function readName(tokens, i, what) {
  let t = tokens[i];
  if (!t || (t.type !== 'word' && t.type !== 'name')) throw new Error(`expected ${what}`);
  if (tokens[i + 1]?.type === 'punct' && tokens[i + 1].value === '.') {
    if (upper(t) !== 'MAIN') throw new Error(`${what}: only the main database may be changed`);
    i += 2;
    t = tokens[i];
    if (!t || (t.type !== 'word' && t.type !== 'name')) throw new Error(`expected ${what}`);
  }
  return { name: foldLower(t.value), next: i + 1 };
}

function skipIfExists(tokens, i, words) {
  let j = i;
  for (const w of words) {
    if (!isWord(tokens[j], w)) return i;
    j += 1;
  }
  return j;
}

/**
 * Whether a migration may run this statement, given the database as it is now. Throws with the
 * reason when not. Returns what kind of statement it is ('assertion' for a SELECT, which must
 * return no rows) and, for CREATE TABLE, the new table's name.
 *
 * Allowed: ALTER TABLE <workspace table> ADD [COLUMN]; CREATE TABLE; CREATE [UNIQUE] INDEX on a
 * workspace table; DROP VIEW / CREATE VIEW (not current_publications); DROP TRIGGER / CREATE
 * TRIGGER on a workspace table, with a body of SELECTs only; UPDATE of a workspace table; INSERT
 * into a lookup table or a table made in this upgrade; SELECT (an assertion). Everything else is
 * refused: DELETE, DROP TABLE, DROP INDEX, ALTER ... RENAME or DROP COLUMN, REPLACE in any form,
 * PRAGMA, ATTACH, DETACH, VACUUM, transactions, TEMP objects, and any mention of the ledger
 * (publications, current_publications) or of SQLite's own tables (sqlite_sequence, sqlite_master).
 *
 * @param {{ text: string, tokens: ReturnType<typeof tokenize> }} statement
 * @param {{ tables: Set<string>, created: Set<string>, triggers: Map<string, string> }} context
 *   tables: the workspace tables (lowercase); created: tables made earlier in this upgrade;
 *   triggers: trigger name -> its table (lowercase)
 * @returns {{ kind: 'change' | 'assertion', created?: string }}
 */
export function checkMigrationStatement({ tokens }, context) {
  for (let k = 0; k < tokens.length; k += 1) {
    const t = tokens[k];
    const u = upper(t);
    if (u && FORBIDDEN_NAMES.has(u)) throw new Error(`${t.value} may not appear in a migration`);
    if (u && u.startsWith('PRAGMA_')) throw new Error(`${t.value} may not appear in a migration`);
    // SQLite also takes a single-quoted text as a name in some places (FROM 'publications').
    if (t.type === 'string' && FORBIDDEN_NAMES.has(foldUpper(t.value.slice(1, -1).replaceAll("''", "'")))) {
      throw new Error(`${t.value} may not appear in a migration`);
    }
    // REPLACE as a keyword (REPLACE INTO, OR REPLACE, ON CONFLICT REPLACE); replace(...) the function is fine.
    if (u === 'REPLACE' && !(tokens[k + 1]?.type === 'punct' && tokens[k + 1].value === '(')) {
      throw new Error('REPLACE may not appear in a migration (it deletes rows)');
    }
  }
  const workspace = (name) => context.tables.has(name) || context.created.has(name);
  const [a, b] = tokens;
  if (isWord(a, 'SELECT')) return { kind: 'assertion' };
  if (isWord(a, 'ALTER') && isWord(b, 'TABLE')) {
    const { name, next } = readName(tokens, 2, 'a table name');
    if (!workspace(name)) throw new Error(`ALTER TABLE ${name}: not a workspace table`);
    if (!isWord(tokens[next], 'ADD')) throw new Error(`ALTER TABLE ${name}: only ADD COLUMN is allowed (no RENAME, no DROP COLUMN)`);
    return { kind: 'change' };
  }
  if (isWord(a, 'CREATE') && isWord(b, 'TABLE')) {
    const { name } = readName(tokens, skipIfExists(tokens, 2, ['IF', 'NOT', 'EXISTS']), 'a table name');
    if (name.startsWith('sqlite_')) throw new Error(`CREATE TABLE ${name}: reserved name`);
    // IF NOT EXISTS on an existing table would do nothing, yet count it as made in this upgrade.
    if (workspace(name)) throw new Error(`CREATE TABLE ${name}: the table already exists`);
    // The row checks read rowid; a table without one cannot be checked.
    if (tokens.some((t, k) => isWord(t, 'WITHOUT') && isWord(tokens[k + 1], 'ROWID'))) {
      throw new Error(`CREATE TABLE ${name}: WITHOUT ROWID tables are not allowed`);
    }
    return { kind: 'change', created: name };
  }
  if (isWord(a, 'CREATE') && (isWord(b, 'INDEX') || (isWord(b, 'UNIQUE') && isWord(tokens[2], 'INDEX')))) {
    let i = skipIfExists(tokens, isWord(b, 'UNIQUE') ? 3 : 2, ['IF', 'NOT', 'EXISTS']);
    i = readName(tokens, i, 'an index name').next;
    if (!isWord(tokens[i], 'ON')) throw new Error('CREATE INDEX: expected ON');
    const { name } = readName(tokens, i + 1, 'a table name');
    if (!workspace(name)) throw new Error(`CREATE INDEX on ${name}: not a workspace table`);
    return { kind: 'change' };
  }
  if ((isWord(a, 'CREATE') || isWord(a, 'DROP')) && isWord(b, 'VIEW')) {
    const words = isWord(a, 'CREATE') ? ['IF', 'NOT', 'EXISTS'] : ['IF', 'EXISTS'];
    readName(tokens, skipIfExists(tokens, 2, words), 'a view name');
    return { kind: 'change' };
  }
  if (isWord(a, 'DROP') && isWord(b, 'TRIGGER')) {
    const { name } = readName(tokens, skipIfExists(tokens, 2, ['IF', 'EXISTS']), 'a trigger name');
    const table = context.triggers.get(name);
    if (table === undefined) throw new Error(`DROP TRIGGER ${name}: no such trigger`);
    if (!workspace(table)) throw new Error(`DROP TRIGGER ${name}: it is not on a workspace table`);
    return { kind: 'change' };
  }
  if (isWord(a, 'CREATE') && isWord(b, 'TRIGGER')) {
    let i = readName(tokens, skipIfExists(tokens, 2, ['IF', 'NOT', 'EXISTS']), 'a trigger name').next;
    const on = tokens.findIndex((t, k) => k >= i && isWord(t, 'ON'));
    if (on === -1) throw new Error('CREATE TRIGGER: expected ON');
    if (tokens.slice(i, on).some((t) => isWord(t, 'INSTEAD'))) throw new Error('CREATE TRIGGER: no triggers on views');
    const { name } = readName(tokens, on + 1, 'a table name');
    if (!workspace(name)) throw new Error(`CREATE TRIGGER on ${name}: not a workspace table`);
    const begin = tokens.findIndex((t, k) => k > on && isWord(t, 'BEGIN'));
    if (begin === -1 || !isWord(tokens.at(-1), 'END')) throw new Error('CREATE TRIGGER: expected BEGIN ... END');
    // Every statement of the body is a SELECT (the row guards: SELECT RAISE(...)).
    let atStart = true;
    for (let k = begin + 1; k < tokens.length - 1; k += 1) {
      if (atStart && !isWord(tokens[k], 'SELECT')) throw new Error('CREATE TRIGGER: its body may only hold SELECT statements');
      atStart = tokens[k].type === 'punct' && tokens[k].value === ';';
    }
    return { kind: 'change' };
  }
  if (isWord(a, 'UPDATE')) {
    if (isWord(b, 'OR')) throw new Error('UPDATE OR ...: not allowed');
    const { name } = readName(tokens, 1, 'a table name');
    if (!workspace(name)) throw new Error(`UPDATE ${name}: not a workspace table`);
    return { kind: 'change' };
  }
  if (isWord(a, 'INSERT')) {
    if (!isWord(b, 'INTO')) throw new Error('INSERT OR ...: not allowed');
    const { name } = readName(tokens, 2, 'a table name');
    if (!LOOKUP_TABLES.includes(name) && !context.created.has(name)) {
      throw new Error(`INSERT INTO ${name}: only into a lookup table (${LOOKUP_TABLES.join(', ')}) or a table made in this upgrade`);
    }
    return { kind: 'change' };
  }
  throw new Error(`${a ? a.value : 'an empty statement'}${b ? ` ${b.value}` : ''}: not allowed in a migration`);
}

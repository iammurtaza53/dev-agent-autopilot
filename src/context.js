// LeanLoop Context Capsule: a deterministic, source-verifiable digest of the project context for one task.
// No LLM is involved. Every excerpt is the exact text of a source section, labelled with its path, line range
// and sha256, and the repository files stay authoritative.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { byteLength, findSecrets, formatBytes, git, readJsonSafe, sha256, writeFileAtomic, writeJsonAtomic } from './lib.js';
import { CONFIG_FILE, runtimePath, taskKey } from './runtime.js';
import { trustGateOptions } from './trust-gate.js';

export const CAPSULE_ENGINE = 'leanloop-capsule-1';
export const RULE_FILE = '.claude/rules/dev-autopilot.md';

export const DEFAULT_CONTEXT_OPTIONS = Object.freeze({
  // Instruction files are always included in full (or noted as already loaded by Claude Code).
  instructionFiles: ['CLAUDE.md', 'AGENTS.md'],
  // Extra mandatory material: "FILE" for a whole file, "FILE#Heading" for one section and its subsections.
  alwaysInclude: [],
  // Sections under a heading containing one of these phrases are always included verbatim.
  alwaysIncludeHeadings: ['safety', 'security', 'secrets', 'credentials', 'policy', 'policies', 'guardrails', 'constraints', 'never', 'do not', 'must not', 'forbidden', 'human gates'],
  // Budget for task-relevant excerpts. Mandatory material is never cut to fit it.
  maxExcerptBytes: 12000,
  maxSectionBytes: 4000,
});

const MAX_SOURCE_BYTES = 1024 * 1024;
const MIN_SCORE = 5;
const RELATIVE_SCORE = 0.3;
const WINDOW_LINES = 40;
const INDEX_LIMIT = 40;
const ALWAYS_START = /<!--\s*autopilot:always\s*-->/i;
const ALWAYS_END = /<!--\s*\/autopilot:always\s*-->/i;

export function contextOptions(config) {
  const custom = config?.leanloop?.context || {};
  const options = {};
  for (const key of Object.keys(DEFAULT_CONTEXT_OPTIONS)) options[key] = custom[key] === undefined ? DEFAULT_CONTEXT_OPTIONS[key] : custom[key];
  return options;
}

export function contextProblems(config) {
  const custom = config?.leanloop?.context;
  if (custom === undefined) return [];
  if (!custom || typeof custom !== 'object' || Array.isArray(custom)) return ['leanloop.context must be an object.'];
  const problems = [];
  for (const key of ['instructionFiles', 'alwaysInclude', 'alwaysIncludeHeadings']) {
    const value = custom[key];
    if (value !== undefined && !(Array.isArray(value) && value.every((item) => typeof item === 'string' && item.trim()))) {
      problems.push(`leanloop.context.${key} must be a list of non-empty strings.`);
    }
  }
  for (const key of ['maxExcerptBytes', 'maxSectionBytes']) {
    const value = custom[key];
    if (value !== undefined && !(Number.isInteger(value) && value >= 500)) problems.push(`leanloop.context.${key} must be a whole number of at least 500 (found ${JSON.stringify(value)}).`);
  }
  return problems;
}

// ---------------------------------------------------------------- loading sources safely

// Repository-relative, forward slashes, and never outside the repository.
export function normalizeRel(value) {
  const rel = String(value ?? '').trim().replace(/\\/g, '/').replace(/^(\.\/)+/, '');
  if (!rel || rel.startsWith('/') || /^[a-z]:/i.test(rel) || rel.split('/').includes('..')) return null;
  return rel;
}

// Files that hold credentials by convention. They are never read, cached or excerpted.
const SECRET_FILE_NAMES = [
  /(^|\/)\.env(\.|$)/i,
  /\.(pem|key|p12|pfx|jks|keystore|kdbx|ppk)$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.|$)/i,
  /(^|\/)[^/]*(secret|credential|password|token)[^/]*\.(json|ya?ml|toml|ini|cfg|conf|env|txt|properties)$/i,
  /(^|\/)\.(npmrc|pypirc|netrc|git-credentials)$/i,
  /(^|\/)auth\.json$/i,
  /\.private\./i,
  /\.local\.json$/i,
  /(^|\/)\.codex\//i,
  /(^|\/)\.claude\/settings\.local\.json$/i,
];

export function isSecretFileName(rel) {
  return SECRET_FILE_NAMES.some((pattern) => pattern.test(rel));
}

function isMarkdown(rel) {
  return /\.(md|markdown|mdx|mdown)$/i.test(rel);
}

// Returns the paths git ignores (tracked files never count as ignored). Outside a repository nothing is.
async function ignoredPaths(root, rels, runGit) {
  if (!rels.length) return new Set();
  const result = await runGit(root, ['check-ignore', '-z', '--stdin'], { input: `${rels.join('\0')}\0` }).catch(() => null);
  if (!result || result.code !== 0) return new Set();
  return new Set(result.stdout.split('\0').filter(Boolean).map((item) => item.replace(/\\/g, '/')));
}

async function insideRoot(root, file) {
  try {
    const [realRoot, realFile] = await Promise.all([fs.realpath(root), fs.realpath(file)]);
    const relative = path.relative(realRoot, realFile);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  } catch {
    return false;
  }
}

// Loads each path with its status: ok, missing, ignored, withheld (secret-like name), outside, too-large or binary.
export async function loadSources(root, rels, { runGit = git } = {}) {
  const unique = [...new Set(rels)];
  const ignored = await ignoredPaths(root, unique.filter((rel) => normalizeRel(rel)), runGit);
  const sources = new Map();
  for (const original of unique) {
    const rel = normalizeRel(original);
    const entry = { path: rel || String(original), status: 'ok', hash: null, bytes: 0, text: null };
    sources.set(original, entry);
    if (!rel) { entry.status = 'outside'; continue; }
    if (isSecretFileName(rel)) { entry.status = 'withheld'; continue; }
    const file = path.join(root, rel);
    let stat;
    try {
      stat = await fs.stat(file);
    } catch {
      entry.status = 'missing';
      continue;
    }
    if (!stat.isFile()) { entry.status = 'missing'; continue; }
    if (!(await insideRoot(root, file))) { entry.status = 'outside'; continue; }
    if (ignored.has(rel)) { entry.status = 'ignored'; continue; }
    if (stat.size > MAX_SOURCE_BYTES) { entry.status = 'too-large'; entry.bytes = stat.size; continue; }
    const buffer = await fs.readFile(file);
    if (buffer.includes(0)) { entry.status = 'binary'; entry.bytes = stat.size; continue; }
    entry.text = buffer.toString('utf8');
    entry.hash = sha256(entry.text);
    entry.bytes = buffer.length;
  }
  return sources;
}

// ---------------------------------------------------------------- sections

function splitLines(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  if (lines.length && lines.at(-1) === '') lines.pop();
  return lines;
}

// Splits Markdown into sections at ATX/setext headings, ignoring headings inside code fences and front matter.
// Each section holds its own lines up to the next heading; blockEnd also covers its subsections.
// Non-Markdown files are split into fixed windows so they can still be excerpted by line range.
export function parseSections(text, markdown = true) {
  const lines = splitLines(text);
  const sections = [];
  if (!markdown) {
    for (let start = 0; start < lines.length; start += WINDOW_LINES) {
      const end = Math.min(lines.length, start + WINDOW_LINES);
      sections.push({ heading: null, level: 0, trail: [], window: true, start: start + 1, end, blockEnd: end, lines: lines.slice(start, end) });
    }
    return finishSections(sections);
  }

  let fence = null;
  let current = { heading: null, level: 0, trail: [], start: 1, lines: [] };
  const stack = [];
  let index = 0;
  if (lines[0]?.trim() === '---') {
    const close = lines.findIndex((line, i) => i > 0 && /^(---|\.\.\.)\s*$/.test(line));
    if (close > 0) {
      current.lines.push(...lines.slice(0, close + 1));
      index = close + 1;
    }
  }
  const open = (level, title, lineNumber) => {
    if (current.heading !== null || current.lines.some((line) => line.trim())) sections.push(current);
    while (stack.length && stack.at(-1).level >= level) stack.pop();
    stack.push({ level, title });
    current = { heading: title, level, trail: stack.map((item) => item.title), start: lineNumber, lines: [] };
  };
  for (; index < lines.length; index += 1) {
    const line = lines[index];
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length && !line.trim().slice(fenceMatch[1].length).trim()) fence = null;
      current.lines.push(line);
      continue;
    }
    if (fenceMatch) {
      fence = fenceMatch[1];
      current.lines.push(line);
      continue;
    }
    const atx = /^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/.exec(line);
    if (atx) {
      open(atx[1].length, atx[2].trim(), index + 1);
      current.lines.push(line);
      continue;
    }
    const next = lines[index + 1];
    const previousBlank = index === 0 || !lines[index - 1].trim();
    if (next !== undefined && previousBlank && line.trim() && /^\s{0,3}(=+|-+)\s*$/.test(next) && !/^\s{0,3}([-*+>|]|\d+[.)])\s?/.test(line)) {
      open(next.trim().startsWith('=') ? 1 : 2, line.trim(), index + 1);
      current.lines.push(line, next);
      index += 1;
      continue;
    }
    current.lines.push(line);
  }
  if (current.heading !== null || current.lines.some((line) => line.trim())) sections.push(current);

  for (const section of sections) section.end = section.start + section.lines.length - 1;
  for (let i = 0; i < sections.length; i += 1) {
    const section = sections[i];
    let blockEnd = section.end;
    if (section.heading !== null) {
      for (let j = i + 1; j < sections.length && sections[j].level > section.level; j += 1) blockEnd = sections[j].end;
    }
    section.blockEnd = blockEnd;
  }
  return finishSections(sections);
}

function finishSections(sections) {
  const seen = new Map();
  return sections.map((section) => {
    const base = section.window ? `lines ${section.start}-${section.end}` : section.heading === null ? '(preamble)' : section.trail.join(' > ');
    const count = (seen.get(base) || 0) + 1;
    seen.set(base, count);
    const text = section.lines.join('\n');
    const { lines, ...rest } = section;
    return { ...rest, key: count > 1 ? `${base} #${count}` : base, text, hash: sha256(text), bytes: byteLength(text), withheld: findSecrets(text) };
  });
}

// Section maps are cached by content hash, so an unchanged file is never re-parsed and a changed one never reuses
// stale sections. Only structure is stored: no section text.
async function sectionsFor(root, source, cache) {
  const cached = cache.files?.[source.path];
  if (cached?.hash === source.hash && cached.engine === CAPSULE_ENGINE) {
    const lines = splitLines(source.text);
    return cached.sections.map((section) => {
      const text = lines.slice(section.start - 1, section.end).join('\n');
      return { ...section, text, withheld: findSecrets(text) };
    });
  }
  const sections = parseSections(source.text, isMarkdown(source.path));
  cache.files = cache.files || {};
  cache.files[source.path] = {
    engine: CAPSULE_ENGINE,
    hash: source.hash,
    sections: sections.map(({ text, withheld, ...rest }) => rest),
  };
  cache.dirty = true;
  return sections;
}

// ---------------------------------------------------------------- task signals

const STOPWORDS = new Set(('about above after again against along already also always among another any anything are aren around '
  + 'because been before being below between both but cannot could does doesn doing done down during each either else '
  + 'every existing few first from further have having here into itself just keep keeps last later least less like make '
  + 'makes many might more most much must need needs never next none only other otherwise ought over same scope should '
  + 'since some still such than that their them then there these they thing things this those though through under until '
  + 'upon very were what when where whether which while whole will with within without would your yours task tasks '
  + 'change changes update updates using used uses work working works should shall acceptance criteria build built add '
  + 'adds added new file files test tests existing behaviour behavior function functions return returns value values '
  + 'current currently follow following include includes including instead support supports supported example').split(/\s+/));

const CODE_WORDS = new Set(('const let var function return true false null undefined new this async await import export from default '
  + 'class extends string number boolean object array type interface public private protected static void self none def pub '
  + 'struct impl use mod package func nil throw throws catch try else elif for while if then with and not the error errors').split(/\s+/));

const GENERIC_NAMES = new Set(('index main utils util helpers helper test tests spec specs readme package config lib src app types '
  + 'common core shared docs doc internal pkg cmd bin dist build public assets scripts script mod init').split(/\s+/));

const FILE_EXTENSIONS = '[cm]?[jt]sx?|py|go|rs|java|kt|kts|swift|rb|php|cs|cpp|cc|c|h|hpp|m|mm|json|ya?ml|toml|md|sql|sh|ps1|css|scss|less|html|vue|svelte|gradle|xml|proto|graphql|gql|tf|ini|cfg|dart|ex|exs|scala|lua';
// Top-level folder names that mark a two-segment prose token such as src/orders as a path rather than "and/or".
const CODE_ROOTS = new Set(('src lib app apps test tests spec packages docs cmd pkg internal components pages api server client '
  + 'scripts config modules services web mobile backend frontend include bin examples .github .claude').split(' '));
const HAS_EXTENSION = new RegExp(`\\.(?:${FILE_EXTENSIONS})$`, 'i');

function acceptPath(token, fromCode) {
  if (fromCode) return true;
  const parts = token.split('/');
  return HAS_EXTENSION.test(parts.at(-1)) || parts.length >= 3 || CODE_ROOTS.has(parts[0].toLowerCase());
}

const PATH_TOKEN = new RegExp(`(?:[A-Za-z0-9_@.-]+/)+[A-Za-z0-9_@.-]*[A-Za-z0-9_]|\\b[A-Za-z0-9_-]+\\.(?:${FILE_EXTENSIONS})\\b`, 'g');

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isStrongIdentifier(token, fromCode) {
  const core = token.replace(/^[_$]+|[_$]+$/g, '');
  if (core.length < 3) return false;
  if (/[a-z][A-Z]/.test(core) || /^[A-Z][a-z0-9]+[A-Z]/.test(core)) return true; // camelCase, PascalCase
  if (/[A-Za-z0-9]_[A-Za-z0-9]/.test(core)) return true; // snake_case, SCREAMING_CASE
  if (/^[A-Z][A-Z0-9]{3,}$/.test(core)) return true; // CONSTANT
  if (fromCode && /[A-Za-z0-9][.:/-][A-Za-z]/.test(core)) return true; // dotted.name, kebab-name, pkg::item
  if (/^@[\w-]+\/[\w.-]+$/.test(token)) return true; // @scope/package
  return false;
}

// Numbered references such as "Phase 5", "milestone 2" or "item 3", and ID-like tokens such as D12 or ADR-7.
const NUMBERED_REFERENCE = /\b(phase|milestone|stage|sprint|step|epic|item|part|chapter|section|task|story|issue|ticket|decision)\s+#?(\d{1,4})\b/gi;
const ID_TOKEN = /\b([A-Z]{1,6}-?\d{1,5})\b/g;

// Deterministic signals from the task text: paths, file names, modules, identifiers, called names, numbered
// references and rarer terms. `exclude` names files (the task and context files) whose mention is not a signal.
export function taskSignals(taskText, { exclude = [] } = {}) {
  const excluded = new Set(exclude.map((item) => String(item).toLowerCase()));
  const excludedBase = new Set([...excluded].map((item) => path.posix.basename(item)));
  const text = String(taskText ?? '').replace(/https?:\/\/\S+/g, ' ');
  const code = [...text.matchAll(/`([^`\n]+)`/g)].map((match) => match[1]);
  const prose = text.replace(/`[^`\n]*`/g, ' ');
  const title = (/^\s{0,3}#\s+(.+)$/m.exec(text)?.[1] || '').toLowerCase();

  const paths = new Set();
  const basenames = new Set();
  const modules = new Set();
  const pathTokens = [
    ...code.flatMap((snippet) => [...snippet.matchAll(PATH_TOKEN)].map((match) => [match[0], true])),
    ...[...prose.matchAll(PATH_TOKEN)].map((match) => [match[0], false]),
  ];
  for (const [raw, fromCode] of pathTokens) {
    const token = raw.replace(/^[./]+/, '').replace(/[.,;:)]+$/, '');
    if (!token || !/[A-Za-z]/.test(token)) continue;
    if (!token.includes('/') && !HAS_EXTENSION.test(token)) continue;
    if (token.includes('/') && !acceptPath(token, fromCode)) continue;
    const lower = token.toLowerCase();
    if (excluded.has(lower) || excludedBase.has(lower)) continue;
    if (lower.includes('/')) paths.add(lower);
    const base = path.posix.basename(lower);
    const stem = base.replace(/\.[^.]+$/, '').replace(/\.(test|spec)$/, '');
    if (!GENERIC_NAMES.has(stem)) basenames.add(base);
    for (const part of lower.split('/').slice(0, -1).concat(stem)) {
      if (part.length >= 4 && !GENERIC_NAMES.has(part) && /[a-z]/.test(part)) modules.add(part);
    }
  }

  const identifiers = new Set();
  const addIdentifier = (token, fromCode) => {
    const clean = token.replace(/[.,;:]+$/, '');
    if (!clean || clean.includes('/') || CODE_WORDS.has(clean.toLowerCase())) return;
    if (excluded.has(clean.toLowerCase()) || excludedBase.has(clean.toLowerCase())) return;
    if (isStrongIdentifier(clean, fromCode)) identifiers.add(clean);
  };
  for (const snippet of code) for (const match of snippet.matchAll(/@?[A-Za-z_$][\w$]*(?:[.:-][A-Za-z_$][\w$]*)*/g)) addIdentifier(match[0], true);
  for (const match of prose.matchAll(/[A-Za-z_$][\w$]*/g)) addIdentifier(match[0], false);

  // Called names: `name(` anywhere, or a code span that is a single plain name such as `summary`.
  const calls = new Set();
  const addCall = (word) => {
    if (word.length >= 3 && !CODE_WORDS.has(word.toLowerCase()) && !GENERIC_NAMES.has(word.toLowerCase()) && !isStrongIdentifier(word, false)) calls.add(word);
  };
  for (const match of text.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) addCall(match[1]);
  for (const snippet of code) if (/^[A-Za-z_$][\w$]*$/.test(snippet.trim())) addCall(snippet.trim());

  const references = new Set();
  for (const match of prose.matchAll(NUMBERED_REFERENCE)) references.add(`${match[1].toLowerCase()} ${match[2]}`);
  for (const match of text.matchAll(ID_TOKEN)) if (/\d/.test(match[1]) && /[A-Z]/.test(match[1])) references.add(match[1]);

  const terms = new Set();
  const topic = new Set();
  for (const match of prose.toLowerCase().matchAll(/[a-z][a-z-]{3,}[a-z]/g)) {
    const word = match[0];
    if (STOPWORDS.has(word) || CODE_WORDS.has(word) || GENERIC_NAMES.has(word) || modules.has(word)) continue;
    terms.add(word);
    if (wordPattern(word).test(title)) topic.add(word);
  }
  return {
    paths: [...paths].sort(),
    basenames: [...basenames].sort(),
    modules: [...modules].filter((item) => !basenames.has(item)).sort(),
    identifiers: [...identifiers].sort(),
    calls: [...calls].sort(),
    references: [...references].sort(),
    terms: [...terms].sort(),
    topic: [...topic].sort(),
  };
}

function wordPattern(word, flags = 'i') {
  return new RegExp(`(^|[^A-Za-z0-9_$])${escapeRegExp(word)}(?=$|[^A-Za-z0-9_$])`, flags);
}

// Signals found in much of the context (such as the product name) don't discriminate, so they are dropped, and
// terms are weighted by how rare they are across all sections.
function buildMatchers(signals, sections) {
  const lowerTexts = sections.map((section) => section.text.toLowerCase());
  const rawTexts = sections.map((section) => section.text);
  const total = Math.max(1, sections.length);
  const common = Math.max(2, total * 0.25);
  const rare = (pattern, texts) => texts.filter((text) => pattern.test(text)).length <= common;
  const topic = new Set(signals.topic || []);
  const terms = [];
  for (const term of signals.terms) {
    const pattern = wordPattern(term);
    const df = lowerTexts.filter((text) => pattern.test(text)).length;
    if (!df || df > common) continue;
    const weight = Math.min(2, Math.max(0, Math.log2(total / df) - 1)) * (topic.has(term) ? 1.5 : 1);
    if (weight > 0) terms.push([term, weight, pattern]);
  }
  const referencePattern = (reference) => new RegExp(`(^|[^A-Za-z0-9])${escapeRegExp(reference).replace(/\\? /g, '\\s+#?')}(?![0-9])`, /\d$/.test(reference) && /^[A-Z]/.test(reference) ? '' : 'i');
  return {
    paths: signals.paths,
    basenames: signals.basenames.map((item) => [item, wordPattern(item)]),
    modules: signals.modules.map((item) => [item, wordPattern(item)]).filter(([, pattern]) => rare(pattern, lowerTexts)),
    identifiers: signals.identifiers.map((item) => [item, wordPattern(item, '')]).filter(([, pattern]) => rare(pattern, rawTexts)),
    calls: signals.calls.map((item) => [item, new RegExp(`\`${escapeRegExp(item)}\`|(^|[^A-Za-z0-9_$])${escapeRegExp(item)}\\s*\\(|\\.${escapeRegExp(item)}(?=$|[^A-Za-z0-9_$])`)]).filter(([, pattern]) => rare(pattern, rawTexts)),
    references: (signals.references || []).map((item) => [item, referencePattern(item)]),
    terms,
  };
}

const MAX_TERM_SCORE = 6;

// A section's relevance: strong signals (paths, file names, identifiers, references, modules, called names)
// plus a capped contribution from rarer terms. Terms alone must add up to a real overlap to count.
export function scoreSection(section, matchers) {
  if (section.heading !== null && !section.text.split('\n').slice(1).some((line) => line.trim())) return { score: 0, strong: 0, matched: [] };
  const text = section.text;
  const lower = text.toLowerCase();
  const heading = section.heading || '';
  let strong = 0;
  const matched = [];
  const hit = (label, weight) => {
    strong += weight;
    matched.push(label);
  };
  for (const item of matchers.paths) if (lower.includes(item)) hit(item, 10);
  for (const [item, pattern] of matchers.basenames) if (pattern.test(lower)) hit(item, 6);
  for (const [item, pattern] of matchers.identifiers) if (pattern.test(text)) hit(item, 5);
  for (const [item, pattern] of matchers.references) if (pattern.test(text)) hit(item, pattern.test(heading) ? 10 : 5);
  for (const [item, pattern] of matchers.modules) if (pattern.test(lower)) hit(item, 3);
  for (const [item, pattern] of matchers.calls) if (pattern.test(text)) hit(item, 3);
  let termScore = 0;
  for (const [term, weight, pattern] of matchers.terms) {
    if (pattern.test(heading)) {
      termScore += weight * 2;
      matched.push(term);
    } else if (pattern.test(lower)) termScore += weight;
  }
  termScore = Math.min(termScore, MAX_TERM_SCORE);
  const eligible = strong >= 3 || termScore >= 4;
  return { score: eligible ? Math.round((strong + termScore) * 100) / 100 : 0, strong, matched };
}


// ---------------------------------------------------------------- mandatory material

function headingMatchesAny(trail, phrases) {
  const lowered = phrases.map((phrase) => phrase.toLowerCase().trim()).filter(Boolean);
  return trail.some((title) => {
    const lower = title.toLowerCase();
    return lowered.some((phrase) => wordPattern(phrase).test(lower));
  });
}

// Sections between <!-- autopilot:always --> and <!-- /autopilot:always --> markers, as exact line ranges.
function markedBlocks(text) {
  const lines = splitLines(text);
  const blocks = [];
  let start = null;
  lines.forEach((line, index) => {
    if (start === null && ALWAYS_START.test(line)) start = index;
    else if (start !== null && ALWAYS_END.test(line)) {
      blocks.push({ start: start + 1, end: index + 1, text: lines.slice(start, index + 1).join('\n') });
      start = null;
    }
  });
  if (start !== null) blocks.push({ start: start + 1, end: lines.length, text: lines.slice(start).join('\n') });
  return blocks;
}

function parseAlwaysInclude(entries) {
  return entries.map((entry) => {
    const [file, ...heading] = String(entry).split('#');
    return { file: normalizeRel(file), heading: heading.join('#').trim() || null, raw: entry };
  });
}

// Root CLAUDE.md, .claude/CLAUDE.md, .claude/rules/**.md and files they import with @path are loaded by
// Claude Code as project memory, so the capsule points to them instead of repeating them.
function memoryImports(memoryRel, text) {
  const imports = new Set();
  const dir = path.posix.dirname(memoryRel);
  let inFence = false;
  for (const line of splitLines(text)) {
    if (/^\s{0,3}(`{3,}|~{3,})/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    for (const match of line.replace(/`[^`]*`/g, ' ').matchAll(/(?:^|\s)@([^\s`)]+)/g)) {
      const target = match[1].replace(/[.,;:]+$/, '');
      if (target.startsWith('~') || target.includes('@')) continue;
      const rel = normalizeRel(path.posix.normalize(path.posix.join(dir, target)));
      if (rel) imports.add(rel);
    }
  }
  return imports;
}

// The Markdown files under .claude/rules/, which Claude Code loads as project memory, sorted.
async function projectRules(root) {
  const dir = path.join(root, '.claude', 'rules');
  const entries = await fs.readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile() && /\.md$/i.test(entry.name))
    .map((entry) => normalizeRel(path.relative(root, path.join(entry.parentPath ?? entry.path, entry.name))))
    .filter(Boolean)
    .sort();
}

export function isAutoLoadedPath(rel) {
  return rel === 'CLAUDE.md' || rel === '.claude/CLAUDE.md' || /^\.claude\/rules\/.+\.md$/i.test(rel);
}

// ---------------------------------------------------------------- capsule

function taskFileOf(config) {
  return config?.project?.taskFile || 'NEXT_TASK.md';
}

function contextFilesOf(config) {
  return Array.isArray(config?.project?.contextFiles) ? config.project.contextFiles : [];
}

function short(hash) {
  return hash ? hash.slice(0, 12) : 'none';
}

function reviewLine(config) {
  const max = config?.reviewer?.maxRounds ?? 2;
  const adaptive = config?.reviewer?.adaptive?.enabled !== false && config?.reviewer?.adaptive !== false;
  return adaptive
    ? `\`dev-autopilot codex review\` (adaptive budget from the git diff, at most ${max} round${max === 1 ? '' : 's'}; \`dev-autopilot review-budget\` shows it)`
    : `\`dev-autopilot codex review\` (at most ${max} round${max === 1 ? '' : 's'})`;
}

function checkCommands(config) {
  return (Array.isArray(config?.checks) ? config.checks : [])
    .map((entry) => (typeof entry === 'string' ? entry : entry?.command))
    .filter(Boolean);
}

// The parts of .autopilot/config.json an agent needs, derived deterministically. Safety lists are verbatim.
export function settingsBlock(config) {
  const checks = checkCommands(config);
  const lines = [
    `- Base branch: \`${config?.project?.baseBranch || 'main'}\`. Task file: \`${taskFileOf(config)}\`.`,
    checks.length
      ? `- Checks: run \`dev-autopilot check\` (runs ${checks.map((item) => `\`${item}\``).join(', ')}).`
      : '- Checks: none configured in `checks`.',
    config?.planner?.enabled === true
      ? '- Codex planner: on. Run `dev-autopilot codex plan` once; it reuses the saved plan for an unchanged task.'
      : '- Codex planner: off. Do not ask Codex for a plan.',
    `- Codex review: ${reviewLine(config)}.`,
    `- Quota auto-resume: ${config?.quota?.autoResume === true ? 'on' : 'off'}.`,
  ];
  const gate = trustGateOptions(config);
  if (gate.enabled) lines.push(`- Trust handoff gate: HostLatch runs with \`dev-autopilot check\` and fails on ${gate.failOn === 'review' ? 'review or block' : 'block'}; a block is a human gate.`);
  const gates = Array.isArray(config?.safety?.humanGates) ? config.safety.humanGates : [];
  if (gates.length) lines.push('- Human gates (`safety.humanGates`, verbatim):', ...gates.map((gate) => `  - ${gate}`));
  const notes = Array.isArray(config?.safety?.notes) ? config.safety.notes : [];
  if (notes.length) lines.push('- Safety notes (`safety.notes`, verbatim):', ...notes.map((note) => `  - ${note}`));
  return lines.join('\n');
}

function fenceFor(text) {
  let fence = '````';
  while (text.includes(fence)) fence += '`';
  return fence;
}

function excerpt(text) {
  const fence = fenceFor(text);
  return `${fence}text\n${text}\n${fence}`;
}

function clip(section, maxBytes) {
  if (section.bytes <= maxBytes) return { text: section.text, end: section.end, clipped: false };
  const lines = section.text.split('\n');
  const kept = [];
  let size = 0;
  for (const line of lines) {
    const next = byteLength(line) + 1;
    if (size + next > maxBytes && kept.length) break;
    kept.push(line);
    size += next;
  }
  return { text: kept.join('\n'), end: section.start + kept.length - 1, clipped: true };
}

function sectionLabel(source, section) {
  const where = section.heading === null ? '' : ` › ${section.trail.join(' › ')}`;
  return `${source.path}${where}`;
}

function describeStatus(source) {
  switch (source.status) {
    case 'missing': return 'not found';
    case 'ignored': return 'git-ignored local file; LeanLoop does not process it. Read it directly if the task needs it';
    case 'withheld': return 'withheld: the file name suggests credentials';
    case 'outside': return 'outside the repository; not processed';
    case 'too-large': return `larger than ${formatBytes(MAX_SOURCE_BYTES)}; not processed. Read the parts you need directly`;
    case 'binary': return 'binary file; not processed';
    default: return source.status;
  }
}

async function readCache(root) {
  const cache = (await readJsonSafe(runtimePath(root, 'context', 'index.json'))) || {};
  return cache.engine === CAPSULE_ENGINE ? cache : { engine: CAPSULE_ENGINE, files: {} };
}

// Loads and classifies every source a capsule depends on, and computes the context fingerprint.
export async function collectContext(root, config, { runGit = git, options = contextOptions(config), version = '' } = {}) {
  const taskRel = normalizeRel(taskFileOf(config)) || taskFileOf(config);
  const contextRels = contextFilesOf(config).map((item) => normalizeRel(item) || String(item));
  const always = parseAlwaysInclude(options.alwaysInclude);
  const instructionRels = options.instructionFiles.map((item) => normalizeRel(item) || String(item));
  // Every project rule Claude Code loads is part of the context, so a changed rule is never reported as unchanged.
  const ruleRels = await projectRules(root);
  const baseRels = [taskRel, CONFIG_FILE, RULE_FILE, ...ruleRels, 'CLAUDE.md', '.claude/CLAUDE.md', ...contextRels, ...instructionRels, ...always.map((item) => item.file).filter(Boolean)];
  let sources = await loadSources(root, baseRels, { runGit });

  // Files imported from project memory are loaded by Claude Code too.
  const imports = new Set();
  const queue = ['CLAUDE.md', '.claude/CLAUDE.md', ...ruleRels];
  for (let depth = 0; depth < 5 && queue.length; depth += 1) {
    const found = [];
    for (const rel of queue.splice(0)) {
      const source = sources.get(rel);
      if (source?.status !== 'ok') continue;
      for (const target of memoryImports(rel, source.text)) if (!imports.has(target)) {
        imports.add(target);
        found.push(target);
      }
    }
    const missing = found.filter((rel) => !sources.has(rel));
    if (missing.length) {
      const more = await loadSources(root, missing, { runGit });
      sources = new Map([...sources, ...more]);
    }
    queue.push(...found);
  }

  const cache = await readCache(root);
  const roles = new Map();
  const assign = (rel, role) => {
    if (!roles.has(rel)) roles.set(rel, role);
  };
  assign(taskRel, 'task');
  assign(CONFIG_FILE, 'config');
  const autoLoaded = (rel) => isAutoLoadedPath(rel) || imports.has(rel);
  for (const rel of [RULE_FILE, ...ruleRels, 'CLAUDE.md', '.claude/CLAUDE.md', ...imports]) if (sources.get(rel)?.status === 'ok') assign(rel, 'memory');
  for (const rel of instructionRels) assign(rel, autoLoaded(rel) ? 'memory' : 'instruction');
  for (const rel of contextRels) assign(rel, autoLoaded(rel) ? 'memory' : 'context');
  for (const item of always) if (item.file) assign(item.file, autoLoaded(item.file) ? 'memory' : 'context');

  const entries = [];
  for (const [rel, role] of roles) {
    const source = sources.get(rel) || { path: rel, status: 'missing' };
    const configured = contextRels.includes(rel) || instructionRels.includes(rel) || always.some((item) => item.file === rel) || ['task', 'config'].includes(role) || rel === RULE_FILE;
    if (source.status !== 'ok' && !configured) continue; // optional memory locations that don't exist
    const entry = { ...source, role };
    if (source.status === 'ok' && role !== 'config') entry.sections = await sectionsFor(root, source, cache);
    entries.push(entry);
  }
  if (cache.dirty) {
    delete cache.dirty;
    await writeJsonAtomic(runtimePath(root, 'context', 'index.json'), cache);
  }

  const optionsHash = sha256(JSON.stringify(options)).slice(0, 12);
  // The Autopilot version is part of the fingerprint, so a new release never reuses a capsule built by an older engine.
  const fingerprint = sha256(JSON.stringify([CAPSULE_ENGINE, version, optionsHash, ...entries.map((entry) => [entry.path, entry.role, entry.status, entry.hash])]));
  return { entries, fingerprint, options, optionsHash, always, taskRel };
}

// Chooses mandatory and task-relevant sections. Mandatory material is never dropped for budget reasons.
function selectSections(collected, config) {
  const { entries, options, always } = collected;
  const task = entries.find((entry) => entry.role === 'task');
  // Naming a context file in the task (for example "see ARCHITECTURE.md") says nothing about which section matters.
  const signals = taskSignals(task?.text || '', { exclude: entries.map((entry) => entry.path) });
  const pool = entries.filter((entry) => ['context', 'instruction'].includes(entry.role) && entry.status === 'ok');
  const allSections = pool.flatMap((entry) => entry.sections.map((section) => ({ entry, section })));
  const matchers = buildMatchers(signals, allSections.map((item) => item.section));

  const mandatory = [];
  const relevant = [];
  const included = new Set();
  const mark = (entry, section) => included.add(`${entry.path}\u0000${section.key}`);
  for (const { entry, section } of allSections) {
    const byInstruction = entry.role === 'instruction';
    const byHeading = section.heading !== null && headingMatchesAny(section.trail, options.alwaysIncludeHeadings);
    const byConfig = always.some((item) => item.file === entry.path && (!item.heading || section.trail.some((title) => title.toLowerCase() === item.heading.toLowerCase())));
    if (byInstruction || byHeading || byConfig) {
      mandatory.push({ entry, section, why: byInstruction ? 'instruction file' : byConfig ? 'leanloop.context.alwaysInclude' : 'safety heading' });
      mark(entry, section);
    }
  }
  const marked = [];
  for (const entry of pool) {
    for (const block of markedBlocks(entry.text)) {
      const covered = entry.sections.filter((section) => included.has(`${entry.path}\u0000${section.key}`) && section.start <= block.start && section.end >= block.end);
      if (!covered.length) marked.push({ entry, block });
    }
  }

  const candidates = [];
  allSections.forEach(({ entry, section }, order) => {
    if (included.has(`${entry.path}\u0000${section.key}`) || section.withheld.length) return;
    const { score, matched } = scoreSection(section, matchers);
    if (score >= MIN_SCORE) candidates.push({ entry, section, score, matched, order });
  });
  // Keep sections that score within reach of the best match; weak incidental overlaps go to the index instead.
  const top = candidates.reduce((best, item) => Math.max(best, item.score), 0);
  const scored = candidates.filter((item) => item.score >= Math.max(MIN_SCORE, top * RELATIVE_SCORE));
  scored.sort((a, b) => b.score - a.score || a.order - b.order);
  let budget = options.maxExcerptBytes;
  for (const item of scored) {
    const clipped = clip(item.section, options.maxSectionBytes);
    const size = byteLength(clipped.text);
    if (size > budget) continue;
    budget -= size;
    relevant.push({ ...item, clipped });
    mark(item.entry, item.section);
  }
  relevant.sort((a, b) => a.order - b.order);
  return { signals, mandatory, marked, relevant, included };
}

function renderIndex(entries, included) {
  const lines = [];
  for (const entry of entries.filter((item) => ['context', 'instruction'].includes(item.role) && item.status === 'ok')) {
    // Second-level headings (or the top level when a file has no others), listed only when some part of their
    // block isn't already in the capsule.
    const levels = entry.sections.filter((section) => section.heading !== null).map((section) => section.level);
    const indexLevel = levels.includes(2) ? 2 : Math.min(...levels, 1);
    const top = entry.sections.filter((section) => section.heading !== null && section.level === indexLevel);
    const missing = (section) => entry.sections.some((other) => other.start >= section.start && other.end <= section.blockEnd && !included.has(`${entry.path}\u0000${other.key}`) && other.text.trim());
    const candidates = (top.length ? top : entry.sections).filter(missing);
    const parts = candidates.slice(0, INDEX_LIMIT).map((section) => `L${section.start}-${section.blockEnd}${section.heading === null ? '' : ` ${section.heading}`}`);
    if (!parts.length) continue;
    const more = candidates.length > INDEX_LIMIT ? ` · …and ${candidates.length - INDEX_LIMIT} more` : '';
    lines.push(`- \`${entry.path}\` (sha256:${short(entry.hash)}, ${formatBytes(entry.bytes)}): ${parts.join(' · ')}${more}`);
  }
  return lines;
}

// Builds the capsule text and its manifest. Pure: no file writes.
export function renderCapsule(collected, config, { version = '' } = {}) {
  const { entries, fingerprint, taskRel } = collected;
  const task = entries.find((entry) => entry.role === 'task');
  const configEntry = entries.find((entry) => entry.role === 'config');
  const selection = selectSections(collected, config);
  const { mandatory, marked, relevant, included } = selection;

  const out = [];
  out.push('# Autopilot Context Capsule', '');
  out.push(`Built by dev-autopilot${version ? ` ${version}` : ''} (LeanLoop: deterministic, no LLM) for task \`${taskRel}\` sha256:${short(task?.hash)}. Context fingerprint ${short(fingerprint)}.`);
  out.push('Excerpts are exact text from the named sources, which stay authoritative. Read an original source only when you need more than this capsule shows, and then only the lines you need.', '');

  if (task?.status === 'ok') {
    const lines = splitLines(task.text).length;
    out.push(`## Task: ${taskRel} (sha256:${short(task.hash)}, lines 1-${lines}, verbatim)`, '', excerpt(task.text), '');
  } else {
    out.push(`## Task: ${taskRel}`, '', `The task file is ${describeStatus(task || { status: 'missing' })}.`, '');
  }

  out.push(`## Autopilot settings: ${CONFIG_FILE} (sha256:${short(configEntry?.hash)})`, '', settingsBlock(config), '');

  const memory = entries.filter((entry) => entry.role === 'memory' && entry.status === 'ok');
  if (memory.length) {
    out.push('## Already in your context', '', 'Claude Code loads these as project memory. Read one only if it is missing from your context.');
    for (const entry of memory) out.push(`- \`${entry.path}\` (sha256:${short(entry.hash)}, ${formatBytes(entry.bytes)})`);
    out.push('');
  }

  const withheld = [];
  if (mandatory.length || marked.length) {
    out.push('## Mandatory context (verbatim)', '');
    const byFile = new Map();
    for (const item of mandatory) {
      if (!byFile.has(item.entry.path)) byFile.set(item.entry.path, []);
      byFile.get(item.entry.path).push(item);
    }
    for (const [file, items] of byFile) {
      const entry = items[0].entry;
      const whole = items.length === entry.sections.length && items.every((item) => !item.section.withheld.length);
      if (whole) {
        out.push(`### ${file} (sha256:${short(entry.hash)}, lines 1-${splitLines(entry.text).length}, whole file: ${items[0].why})`, '', excerpt(entry.text), '');
        continue;
      }
      for (const { section, why } of items) {
        if (section.withheld.length) {
          withheld.push(`- \`${file}\` lines ${section.start}-${section.end} (${section.heading ?? section.key}): withheld because it contains a credential-like value (${section.withheld.join(', ')}). Read the source directly if you need it.`);
          continue;
        }
        out.push(`### ${sectionLabel(entry, section)} (sha256:${short(entry.hash)}, lines ${section.start}-${section.end}; ${why})`, '', excerpt(section.text), '');
      }
    }
    for (const { entry, block } of marked) {
      if (findSecrets(block.text).length) {
        withheld.push(`- \`${entry.path}\` lines ${block.start}-${block.end} (autopilot:always block): withheld because it contains a credential-like value.`);
        continue;
      }
      out.push(`### ${entry.path} (sha256:${short(entry.hash)}, lines ${block.start}-${block.end}; autopilot:always block)`, '', excerpt(block.text), '');
    }
  }

  if (relevant.length) {
    out.push('## Task-relevant excerpts (verbatim)', '');
    for (const { entry, section, matched, clipped } of relevant) {
      const range = `lines ${section.start}-${clipped.end}`;
      const why = matched.length ? `; matched: ${matched.slice(0, 6).join(', ')}` : '';
      out.push(`### ${sectionLabel(entry, section)} (sha256:${short(entry.hash)}, ${range}${why})`, '', excerpt(clipped.text));
      if (clipped.clipped) out.push(`(Excerpt cut at the section budget: read \`${entry.path}\` lines ${clipped.end + 1}-${section.end} for the rest.)`);
      out.push('');
    }
  }

  const index = renderIndex(entries, included);
  if (index.length) out.push('## Index: other sections', '', 'Read these on demand by line range.', ...index, '');

  const skipped = entries.filter((entry) => entry.status !== 'ok' && entry.role !== 'task');
  const missing = skipped.filter((entry) => entry.status === 'missing').map((entry) => `\`${entry.path}\``);
  const notes = [
    ...(missing.length ? [`- Not found: ${missing.join(', ')}.`] : []),
    ...skipped.filter((entry) => entry.status !== 'missing').map((entry) => `- \`${entry.path}\`: ${describeStatus(entry)}.`),
  ];
  for (const entry of entries.filter((item) => item.status === 'ok' && item.sections && ['context', 'instruction'].includes(item.role))) {
    for (const section of entry.sections) {
      if (section.withheld.length && !mandatory.some((item) => item.section === section)) {
        withheld.push(`- \`${entry.path}\` lines ${section.start}-${section.end} (${section.heading ?? section.key}): withheld because it contains a credential-like value (${section.withheld.join(', ')}).`);
      }
    }
  }
  if (notes.length || withheld.length) out.push('## Not included', '', ...notes, ...withheld, '');

  const markdown = `${out.join('\n').trimEnd()}\n`;
  const rawBytes = entries
    .filter((entry) => entry.status === 'ok' && ['task', 'config', 'context', 'instruction'].includes(entry.role))
    .reduce((sum, entry) => sum + entry.bytes, 0);
  const manifest = {
    engine: CAPSULE_ENGINE,
    fingerprint,
    taskHash: task?.hash || null,
    rawBytes,
    capsuleBytes: byteLength(markdown),
    sources: Object.fromEntries(entries.map((entry) => [entry.path, {
      role: entry.role,
      status: entry.status,
      hash: entry.hash,
      bytes: entry.bytes,
      sections: entry.sections ? Object.fromEntries(entry.sections.map((section) => [section.key, { hash: section.hash, start: section.start, end: section.end, included: included.has(`${entry.path}\u0000${section.key}`) }])) : undefined,
    }])),
  };
  return { markdown, manifest, selection };
}

function capsulePaths(root, taskHash) {
  const key = taskKey(taskHash);
  return {
    markdown: runtimePath(root, 'context', `capsule-${key}.md`),
    manifest: runtimePath(root, 'context', `capsule-${key}.json`),
  };
}

// Builds the capsule for the current task, or reuses the stored one when the task, every source hash and the
// options are unchanged. Returns the paths, the manifest and whether it was reused.
export async function ensureCapsule(root, config, { runGit = git, version = '' } = {}) {
  const collected = await collectContext(root, config, { runGit, version });
  const task = collected.entries.find((entry) => entry.role === 'task');
  const files = capsulePaths(root, task?.hash);
  const stored = await readJsonSafe(files.manifest);
  if (stored?.fingerprint === collected.fingerprint && stored.engine === CAPSULE_ENGINE) {
    const text = await fs.readFile(files.markdown, 'utf8').catch(() => null);
    if (text !== null && sha256(text) === stored.capsuleHash) return { ...files, manifest: stored, collected, reused: true };
  }
  const { markdown, manifest } = renderCapsule(collected, config, { version });
  manifest.capsuleHash = sha256(markdown);
  await writeFileAtomic(files.markdown, markdown);
  await writeJsonAtomic(files.manifest, manifest);
  return { ...files, manifest, collected, reused: false };
}

// ---------------------------------------------------------------- delta

// Compares the manifest a session last received with the current one, source by source and section by section.
export function diffManifests(previous, current) {
  const changes = [];
  const paths = new Set([...Object.keys(previous?.sources || {}), ...Object.keys(current?.sources || {})]);
  for (const file of [...paths].sort()) {
    const before = previous?.sources?.[file];
    const after = current?.sources?.[file];
    if (before && after && before.status === after.status && before.hash === after.hash) continue;
    const change = { path: file, role: (after || before).role, before: before || null, after: after || null, changed: [], added: [], removed: [] };
    const oldSections = before?.sections || {};
    const newSections = after?.sections || {};
    for (const key of Object.keys(newSections)) {
      if (!oldSections[key]) change.added.push(key);
      else if (oldSections[key].hash !== newSections[key].hash) change.changed.push(key);
    }
    for (const key of Object.keys(oldSections)) if (!newSections[key]) change.removed.push(key);
    changes.push(change);
  }
  return changes;
}

// Renders only what changed since the session's last capsule: exact new text for changed sections that are
// mandatory or relevant to the task, and line ranges for the rest.
export function renderDelta(previous, capsule, config) {
  const changes = diffManifests(previous, capsule.manifest);
  const { collected } = capsule;
  const selection = selectSections(collected, config);
  const entries = new Map(collected.entries.map((entry) => [entry.path, entry]));
  const important = new Set([
    ...selection.mandatory.map((item) => `${item.entry.path}\u0000${item.section.key}`),
    ...selection.relevant.map((item) => `${item.entry.path}\u0000${item.section.key}`),
  ]);
  const out = [];
  out.push('# Autopilot Context Delta', '');
  out.push(`Task \`${collected.taskRel}\` is unchanged (sha256:${short(capsule.manifest.taskHash)}). Context fingerprint ${short(previous?.fingerprint)} → ${short(capsule.manifest.fingerprint)}.`);
  out.push('Only the sources below changed. Everything else you read for this task is unchanged and remains authoritative. Excerpts are exact current text.', '');
  const changedPaths = [];
  for (const change of changes) {
    const entry = entries.get(change.path);
    changedPaths.push(change.path);
    const before = change.before?.hash ? short(change.before.hash) : change.before?.status || 'absent';
    const after = change.after?.hash ? short(change.after.hash) : change.after?.status || 'absent';
    out.push(`## ${change.path} (${change.role}; sha256:${before} → ${after})`, '');
    if (!change.after || change.after.status !== 'ok') {
      out.push(`Now ${describeStatus(change.after || { status: 'missing' })}. Disregard what you read from it before unless you reread it.`, '');
      continue;
    }
    if (change.role === 'config') {
      out.push('Current Autopilot settings:', '', settingsBlock(config), '');
      continue;
    }
    const always = change.role === 'memory' || change.role === 'instruction';
    if (change.role === 'memory') out.push('Claude Code loaded the previous version as project memory when this session started; the changed parts are below.', '');
    for (const key of [...change.changed, ...change.added]) {
      const section = entry.sections.find((item) => item.key === key);
      if (!section) continue;
      const label = `${change.added.includes(key) ? 'Added' : 'Changed'}: ${section.heading ?? section.key} (lines ${section.start}-${section.end})`;
      if (section.withheld.length) {
        out.push(`- ${label}: withheld because it contains a credential-like value. Read the source directly if you need it.`);
        continue;
      }
      if (always || important.has(`${change.path}\u0000${key}`)) {
        out.push(`### ${label}`, '', excerpt(section.text), '');
      } else {
        out.push(`- ${label}: not matched to this task. Read it if you need it.`);
      }
    }
    for (const key of change.removed) out.push(`- Removed: ${key}.`);
    out.push('');
  }
  if (!changes.length) out.push('No source changed.', '');
  const markdown = `${out.join('\n').trimEnd()}\n`;
  return { markdown, changes, changedPaths, bytes: byteLength(markdown) };
}

export async function writeDelta(root, taskHash, fingerprint, markdown) {
  const file = runtimePath(root, 'context', `delta-${taskKey(taskHash)}-${short(fingerprint)}.md`);
  await writeFileAtomic(file, markdown);
  return file;
}

// Keeps the capsule files of the current task and the most recent others.
export async function pruneCapsules(root, keepTaskHash, keep = 5) {
  const dir = runtimePath(root, 'context');
  const names = await fs.readdir(dir).catch(() => []);
  const groups = new Map();
  for (const name of names) {
    const match = /^(?:capsule|delta|session)-([0-9a-f]{12}|no-task)/.exec(name);
    if (!match) continue;
    const stat = await fs.stat(path.join(dir, name)).catch(() => null);
    if (!stat) continue;
    const group = groups.get(match[1]) || { key: match[1], newest: 0, names: [] };
    group.newest = Math.max(group.newest, stat.mtimeMs);
    group.names.push(name);
    groups.set(match[1], group);
  }
  const current = taskKey(keepTaskHash);
  const others = [...groups.values()].filter((group) => group.key !== current).sort((a, b) => b.newest - a.newest);
  for (const group of others.slice(Math.max(0, keep - 1))) {
    for (const name of group.names) await fs.rm(path.join(dir, name), { force: true });
  }
}

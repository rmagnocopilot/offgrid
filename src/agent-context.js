'use strict';

const path = require('node:path');

const EXTENSIONS = [
  'js', 'cjs', 'mjs', 'jsx', 'ts', 'tsx', 'json', 'jsonc', 'css', 'scss', 'html', 'md',
  'py', 'java', 'kt', 'kts', 'gradle', 'properties', 'cs', 'go', 'rs', 'php', 'vue',
  'svelte', 'yml', 'yaml', 'xml', 'jsp', 'sql', 'sh', 'ps1'
].join('|');
const FILE_PATTERN = new RegExp(`(?:[A-Za-z]:)?[\\w@./\\\\-]+\\.(?:${EXTENSIONS})`, 'gi');
const SHORTHAND_PATTERN = new RegExp(`^\\s*\\/\\s*(${EXTENSIONS})\\b`, 'i');

function extractExplicitFileReferences(text) {
  const source = String(text || '');
  const references = [];
  const seen = new Set();
  for (const match of source.matchAll(FILE_PATTERN)) {
    const raw = match[0].replace(/[),;:'"`]+$/g, '');
    const normalized = raw.replace(/\\/g, '/');
    add(normalized);

    const tailStart = (match.index || 0) + match[0].length;
    const tail = source.slice(tailStart, tailStart + 40);
    const shorthand = tail.match(SHORTHAND_PATTERN);
    if (shorthand) add(normalized.replace(/\.[^.\/]+$/, `.${shorthand[1].toLowerCase()}`));
  }
  return references.slice(0, 20);

  function add(reference) {
    const key = reference.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    references.push(reference);
  }
}

function basenameReference(reference) {
  return path.posix.basename(String(reference || '').replace(/\\/g, '/'));
}

module.exports = { extractExplicitFileReferences, basenameReference, FILE_PATTERN };

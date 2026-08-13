function safeJson(value: unknown): string {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? String(value) : json;
  } catch {
    return String(value);
  }
}

function compactText(value: string, maxChars: number): string {
  const limit = Math.max(96, Math.floor(maxChars));
  if (value.length <= limit) return value;

  const marker = `\n...[${value.length - limit} caracteres omitidos]...\n`;
  const usable = Math.max(32, limit - marker.length);
  const head = Math.max(16, Math.floor(usable * 0.62));
  const tail = Math.max(16, usable - head);
  return `${value.slice(0, head)}${marker}${value.slice(-tail)}`;
}

function compactArray(values: unknown[], maxChars: number): unknown[] {
  if (!values.length) return values;
  const result: unknown[] = [];
  const limit = Math.max(160, Math.floor(maxChars));
  let used = 2;

  for (const value of values) {
    const serialized = safeJson(value);
    if (used + serialized.length + 1 > limit) break;
    result.push(value);
    used += serialized.length + 1;
  }

  if (result.length === values.length) return result;
  const omitted = values.length - result.length;
  result.push({ omitted, note: `${omitted} item(ns) omitido(s) para preservar a janela de contexto.` });
  return result;
}

function compactKnownToolContent(toolName: string, content: unknown, maxChars: number): unknown {
  if (!content || typeof content !== 'object' || Array.isArray(content)) return content;
  const record = content as Record<string, unknown>;

  if (toolName === 'read_file' && typeof record.content === 'string') {
    const metadata = {
      filePath: record.filePath,
      startLine: record.startLine,
      endLine: record.endLine,
      totalLines: record.totalLines
    };
    const metadataChars = safeJson(metadata).length;
    return {
      ...metadata,
      content: compactText(record.content, Math.max(160, maxChars - metadataChars - 64)),
      truncatedForContext: safeJson(content).length > maxChars
    };
  }

  if (toolName === 'list_files' && Array.isArray(record.files)) {
    return {
      count: record.count,
      files: compactArray(record.files, Math.max(160, maxChars - 96)),
      truncatedForContext: safeJson(content).length > maxChars
    };
  }

  if (toolName === 'search_codebase' && Array.isArray(record.matches)) {
    return {
      query: record.query,
      count: record.count,
      matches: compactArray(record.matches, Math.max(160, maxChars - 128)),
      truncatedForContext: safeJson(content).length > maxChars
    };
  }

  if (toolName === 'list_directory_tree' && Array.isArray(record.tree)) {
    return {
      tree: compactArray(record.tree, Math.max(160, maxChars - 96)),
      truncatedForContext: safeJson(content).length > maxChars
    };
  }

  if (toolName === 'run_java_coverage') {
    return {
      moduleRoot: record.moduleRoot,
      buildSystem: record.buildSystem,
      reportPath: record.reportPath,
      className: record.className,
      summary: record.summary,
      buildOutputOmitted: true
    };
  }

  return content;
}

export function serializeToolArgumentsForPrompt(
  toolName: string,
  args: Record<string, unknown>,
  maxChars: number
): string {
  const redacted: Record<string, unknown> = { ...args };
  const largeFields = ['content', 'oldText', 'newText'];

  for (const field of largeFields) {
    const value = redacted[field];
    if (typeof value === 'string' && value.length > 240) {
      redacted[field] = `<${field} omitido no retorno ao modelo; ${value.length} caracteres>`;
    }
  }

  return compactText(safeJson(redacted), maxChars);
}

export function serializeToolResultForPrompt(
  toolName: string,
  content: unknown,
  maxChars: number
): string {
  const limit = Math.max(160, Math.floor(maxChars));
  const original = safeJson(content);
  if (original.length <= limit) return original;

  const compacted = safeJson(compactKnownToolContent(toolName, content, limit));
  return compactText(compacted, limit);
}

export function compactTaskReminderForContinuation(taskReminder: string | undefined, maxChars: number): string {
  return compactText(String(taskReminder ?? '').trim(), Math.max(160, maxChars));
}

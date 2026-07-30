import type { ConversationMode, ToolSchema } from '../types/contracts';

export const TOOL_SCHEMAS: ToolSchema[] = [
  schema('get_active_file', 'Retorna o arquivo ativo no editor.', {}, false),
  schema('get_selection', 'Retorna a seleção atual e seu arquivo.', {}, false),
  schema('list_files', 'Lista arquivos por glob.', { pattern: stringProp('Glob, por exemplo **/*.ts') }, false),
  schema('list_directory_tree', 'Lista uma árvore resumida do workspace.', { root: stringProp('Pasta relativa opcional'), maxDepth: numberProp('Profundidade máxima') }, false),
  schema('read_file', 'Lê um arquivo por intervalo de linhas.', { filePath: stringProp(), startLine: numberProp(), endLine: numberProp() }, false, ['filePath']),
  schema('search_codebase', 'Pesquisa texto ou expressão regular no workspace.', { query: stringProp(), pattern: stringProp() }, false, ['query']),
  schema('get_diagnostics', 'Obtém erros e avisos do VS Code.', { filePath: stringProp('Arquivo opcional') }, false),
  schema('find_symbol', 'Pesquisa símbolos do workspace.', { query: stringProp() }, false, ['query']),
  schema('find_definition', 'Localiza a definição em uma posição do arquivo.', positionProps(), false, ['filePath','line','character']),
  schema('find_references', 'Localiza referências em uma posição do arquivo.', positionProps(), false, ['filePath','line','character']),
  schema('get_hover', 'Obtém informações de hover em uma posição.', positionProps(), false, ['filePath','line','character']),
  schema('git_status', 'Retorna git status --short.', {}, false),
  schema('git_diff', 'Retorna git diff, opcionalmente de um arquivo.', { filePath: stringProp() }, false),
  schema('get_memory', 'Pesquisa decisões e padrões salvos na memória do projeto.', { query: stringProp() }, false),
  schema('save_memory', 'Salva uma decisão ou padrão na memória do projeto.', { title: stringProp(), content: stringProp(), type: stringProp() }, true, ['title','content']),
  schema('apply_edit', 'Prepara substituição exata em arquivo; não salva antes da revisão.', { filePath: stringProp(), oldText: stringProp(), newText: stringProp(), replaceAll: boolProp() }, true, ['filePath','oldText','newText']),
  schema('create_file', 'Prepara um novo arquivo para revisão.', { filePath: stringProp(), content: stringProp() }, true, ['filePath','content']),
  schema('delete_file', 'Prepara exclusão de arquivo para revisão.', { filePath: stringProp() }, true, ['filePath']),
  schema('run_terminal', 'Executa comando no terminal após confirmação explícita.', { command: stringProp() }, true, ['command']),
  schema('apply_changes', 'Finaliza alterações preparadas e abre revisão.', { summary: stringProp() }, true, ['summary'])
];

export function schemasForMode(mode: ConversationMode): ToolSchema[] {
  if (mode === 'chat') return [];
  if (mode === 'plan' || mode === 'readOnly') return TOOL_SCHEMAS.filter(item => !item.write);
  return TOOL_SCHEMAS;
}

function schema(name: string, description: string, properties: Record<string, unknown>, write: boolean, required: string[] = []): ToolSchema {
  return { name, description, write, inputSchema: { type: 'object', properties, required, additionalProperties: false } };
}
function stringProp(description = ''): Record<string, unknown> { return { type: 'string', description }; }
function numberProp(description = ''): Record<string, unknown> { return { type: 'number', description }; }
function boolProp(description = ''): Record<string, unknown> { return { type: 'boolean', description }; }
function positionProps(): Record<string, unknown> { return { filePath: stringProp(), line: numberProp('Linha baseada em 1'), character: numberProp('Coluna baseada em 1') }; }

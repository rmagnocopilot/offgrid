# Instruções permanentes do projeto (`AGENTS.md`)

O Offgrid procura automaticamente arquivos `AGENTS.md` antes de responder no Chat e antes de executar o Agente.

## Escopo e prioridade

- `AGENTS.md` na raiz vale para todo o workspace.
- Um `AGENTS.md` em uma subpasta acrescenta regras para os arquivos daquela árvore.
- Em caso de conflito, o arquivo mais próximo do arquivo alterado prevalece.
- O conteúdo é relido a cada pedido; não é necessário reiniciar o VS Code.

Exemplo:

```text
projeto/
├── AGENTS.md
├── frontend/
│   ├── AGENTS.md
│   └── src/
└── backend/
    ├── AGENTS.md
    └── src/
```

## Regras em linguagem natural

Todo o Markdown é enviado ao modelo como instrução obrigatória. Use frases objetivas e verificáveis:

```markdown
# Regras do projeto

- Preserve a arquitetura existente.
- Não recrie arquivos que já existem.
- Strings repetidas mais de duas vezes devem virar constantes.
- A complexidade ciclomática dos métodos não deve ultrapassar 13.
- Não introduza `any` em TypeScript.
- Use injeção por construtor em Java.
```

## Regras verificadas pelo Offgrid

Um bloco `offgrid` opcional transforma algumas regras em validações determinísticas antes de a alteração entrar na revisão:

````markdown
```offgrid
maxCyclomaticComplexity: 13
extractStringAfterOccurrences: 2
maxMethodLines: 40
allowPlaceholders: false
```
````

Campos suportados:

- `maxCyclomaticComplexity`: bloqueia métodos acima do limite calculado pelo analisador local.
- `extractStringAfterOccurrences`: bloqueia literais de texto que apareçam mais vezes que o limite.
- `maxMethodLines`: bloqueia métodos acima do número de linhas.
- `allowPlaceholders`: quando `false`, bloqueia `TODO`, `FIXME`, `HACK` e erros de “não implementado”.

A medição de complexidade é uma aproximação estática e conservadora para Java, JavaScript e TypeScript. O Sonar continua sendo a validação definitiva do pipeline.

## Exemplo recomendado

Use `docs/AGENTS.example.md` como ponto de partida e copie o conteúdo para `AGENTS.md` na raiz do projeto que utilizará o Offgrid.

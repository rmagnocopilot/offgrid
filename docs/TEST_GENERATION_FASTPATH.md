# Geração estrutural de testes Angular

O `TestGenerationFastPath` acelera pedidos simples de criação de `*.component.spec.ts` sem depender de um domínio, projeto ou conjunto fixo de nomes.

## Como funciona

1. Localiza o `*.component.ts` citado, inclusive quando o pedido usa somente o nome do arquivo.
2. Analisa o código com a API do compilador TypeScript, sem expressões específicas de negócio.
3. Detecta:
   - `@Component` e configuração standalone;
   - padrão standalone padrão do Angular 19 ou superior quando a propriedade é omitida;
   - dependências por parâmetro do construtor ou `inject(...)`;
   - métodos chamados por `ngOnInit`, inclusive auxiliares privados;
   - carregamento por Observable e `subscribe`;
   - atribuições diretas ou transformações seguras com `map`, `filter`, `slice` e `flatMap`;
   - getters ou métodos sem argumentos que realizam filtro textual.
4. Detecta Jasmine, Jest ou Vitest pelo `package.json` mais próximo e por specs existentes.
5. Gera somente os cenários pedidos que foram comprovados pela AST.
6. Valida o conteúdo com as mesmas regras de segurança aplicadas às respostas do modelo.
7. Prepara o arquivo com `create_file` para revisão normal do usuário.

## Limites deliberados

O caminho rápido não tenta adivinhar regras de negócio. Ele volta ao AgentLoop quando encontra, por exemplo:

- token de injeção que não pode ser simulado com segurança;
- acesso complexo a propriedades de uma dependência;
- comportamento pedido que não aparece na estrutura do componente;
- filtro que não representa pesquisa textual;
- arquivo de spec já existente.

Essa política evita gerar um teste rápido, porém incorreto.

## Testes de regressão

A suíte cobre componentes fictícios de produtos, pedidos, usuários, inventário, tags e pontuações. Os testes verificam Jasmine, Jest, Vitest, standalone, módulos, Angular 19, métodos auxiliares, transformação com `map`, fallback conservador e ausência de nomes do projeto usado apenas como exemplo manual.

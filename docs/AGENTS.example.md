# Instruções obrigatórias do projeto

## Qualidade

- Preserve a arquitetura e os padrões existentes.
- Altere somente os arquivos necessários para atender ao pedido.
- Não recrie arquivos que já existem.
- Não remova regras de negócio existentes.
- Strings repetidas mais de duas vezes devem ser extraídas para constantes.
- A complexidade ciclomática de cada método não deve ultrapassar 13.
- Não deixe placeholders ou implementações incompletas.

## Java

- Use injeção por construtor.
- Siga a versão de Java, JUnit e o framework já configurados.
- Não introduza Jakarta em projetos que usam Javax.

## TypeScript e Angular

- Não use `any` sem justificativa comprovada.
- Preserve o padrão standalone ou baseado em módulos já usado pelo projeto.
- Reutilize services, models e componentes existentes.

## Validação automática do Offgrid

```offgrid
maxCyclomaticComplexity: 13
extractStringAfterOccurrences: 2
maxMethodLines: 40
allowPlaceholders: false
```

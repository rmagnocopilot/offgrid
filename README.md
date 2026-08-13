<p align="center">
  <img src="resources/branding/offgrid-logo.png" alt="Offgrid" width="260">
</p>

# Offgrid 2.0.9

Assistente local e offline para Visual Studio Code, reescrito em **TypeScript**. A arquitetura segue a separação usada pelo Unplugged entre Agente, ferramentas, contexto, segurança, motor LLM e interface, preservando os recursos adicionais construídos no Offgrid.

## Novidades da versão 2.0.9

- corrige o caso real em que pedidos como **“crie a classe de testes para TarifaSiapfDTO usando AcompanhamentoObrasHistoricoDTOTest como exemplo”** eram reconhecidos como teste Java pelo `TaskIntent`, mas não pelo Adaptive Fast Path por não conterem a palavra “unitário”;
- o Adaptive Fast Path passa a reconhecer **classe de testes Java** quando há uma origem Java comprovada, sem confundir specs TypeScript;
- quando um teste de referência é citado explicitamente, o diretório desse teste passa a ser a evidência principal para o destino. Isso preserva convenções como `src/main/.../dto` → `src/test/.../tests/dto`, sem presumir espelhamento de packages;
- o cenário DTO + teste de referência volta ao caminho determinístico: o teste é sintetizado localmente em TypeScript e preparado via `create_file`, sem geração longa pelo Qwen;
- o fallback do AgentLoop não pode mais encerrar uma tarefa de criação apenas mostrando código no chat. Se houver destino determinístico e o modelo retornar um arquivo completo, o Offgrid converte esse conteúdo internamente em `create_file`;
- se a saída de código vier truncada, com fence ou classe sem fechamento, o Agente encerra com erro explícito e **não apresenta o arquivo incompleto como resposta válida**;
- tarefas Java reconhecidas removem `list_files` do catálogo quando origem e referência já podem ser resolvidas pelo contexto, evitando a etapa redundante observada na 2.0.8;
- o Adaptive Fast Path agora resolve a **classe-alvo citada no pedido**, mesmo quando `pom.xml` ou outro arquivo está ativo, e restringe a busca da referência ao mesmo módulo antes de considerar outros caminhos do workspace;
- se o arquivo de destino já existir, o caminho adaptativo é idempotente: não faz nada quando o conteúdo já corresponde ao padrão e prepara `apply_edit` quando precisa corrigir/completar o arquivo, sem cair automaticamente no AgentLoop;
- depois que origem, referência e destino foram resolvidos pelo Adaptive Fast Path, uma falha na geração direta é terminal e clara; o Offgrid não inicia uma segunda execução longa do AgentLoop para a mesma tarefa;
- a síntese local de teste Java só presume `new Classe()` quando a classe-alvo realmente possui construtor vazio acessível (ou nenhum construtor explícito);
- o fallback Vulkan agora é **monotônico**: depois de tentar menos camadas, nunca volta a tentar um número maior na mesma carga;
- adiciona a ferramenta `run_java_coverage`: quando o projeto já possui JaCoCo configurado, o Agente pode executar Maven/Gradle mediante confirmação, ler `jacoco.xml` e receber diretamente os métodos sem cobertura e os parcialmente cobertos, sem enviar o relatório HTML inteiro ao modelo;
- o Offgrid não adiciona JaCoCo automaticamente ao `pom.xml`/`build.gradle`; ausência do plugin é informada para revisão separada;
- resultados JaCoCo são compactados antes de voltar ao modelo, preservando métodos/branches pendentes e omitindo a saída extensa do build;
- Fast Paths determinísticos podem concluir alterações mesmo sem um modelo carregado; o modelo só passa a ser obrigatório quando a tarefa realmente precisar de geração LLM/AgentLoop;
- mantém o orçamento de contexto 4K, compactação de resultados de ferramentas, proteção de VRAM pós-carga e fallback embarcado `node-llama-cpp`;
- inclui regressões automatizadas para reproduzir o prompt corporativo que falhou na 2.0.8 e os novos cenários de origem fora do arquivo ativo, módulos duplicados, destino existente, construtor obrigatório e JaCoCo.

## Abrir o Offgrid

Após instalar o VSIX, clique no ícone **Offgrid** na Activity Bar, a barra vertical esquerda do VS Code. Também é possível clicar no status `Offgrid` na barra inferior ou executar `Offgrid: Abrir Chat`.

Na primeira instalação, o painel é aberto uma única vez para apresentar o seletor de modelos.

## Modos

- **Chat:** conversa comum, com contexto opcional de arquivos.
- **Planejar:** pesquisa o workspace e propõe um plano, sem ferramentas de escrita.
- **Agente:** executa ferramentas reais, prepara alterações e mostra diff antes de salvar.

O Agente é implementado em TypeScript/Node.js usando a API do VS Code. Python não é necessário.

## Interface

- histórico lateral de sessões;
- seletor de modelo no topo;
- arquivo atual ou fixado;
- contexto adicional por arquivo e seleção;
- painel de diagnóstico `hidden`, `compact`, `expanded` ou `onError`;
- layout responsivo para barras laterais estreitas;
- diff nativo com aceitar ou rejeitar;
- botão para copiar diagnóstico;
- item de status clicável.

## Modelos

Os modelos são baixados dos GitHub Releases do próprio repositório Offgrid, evitando dependência direta do domínio de hospedagem original durante a instalação corporativa.

Estados exibidos:

- não instalado;
- instalado no disco;
- ativo;
- carregado na memória;
- erro.

Somente um modelo fica carregado. A troca descarrega o anterior antes da nova carga.

## Windows, Linux e macOS

O Offgrid usa o `llama-server` local como motor principal.

No Windows, quando a execução do `llama-server.exe` é impedida por Política de Grupo ou outra restrição corporativa, o worker ativa automaticamente o motor embarcado `node-llama-cpp`. Esse fallback não exige a execução de um servidor externo e inclui suporte a CPU e Vulkan.

**Recursos avançados de RAM/VRAM são otimizados para Windows:**

- RAM total, livre e memória do processo isolado;
- NVIDIA via `nvidia-smi`;
- inventário de GPU por CIM como estimativa;
- cálculo com `Int64` para placas com 2 GB ou mais;
- GPU Layers progressivas;
- fallback entre Vulkan e CPU;
- perfil funcional por máquina e modelo.

No Linux e macOS, falhas de telemetria não impedem o Offgrid de iniciar. O motor usa a detecção padrão disponível e pode fazer fallback para CPU.
## Cobertura Java com JaCoCo

Quando o módulo Java já possui JaCoCo configurado, o Modo Agente pode usar `run_java_coverage` para executar os testes e gerar o relatório XML. A execução do comando **sempre pede confirmação**. O Offgrid lê o `jacoco.xml` localmente e devolve ao Agente um resumo compacto com:

- métodos totalmente sem cobertura;
- métodos parcialmente cobertos;
- instruções ainda não cobertas;
- branches ainda não cobertos;
- linha inicial do método quando o relatório fornece essa informação.

Em Maven, o caminho usa o wrapper `mvnw` quando disponível e, caso contrário, `mvn`. Em Gradle, prefere `gradlew`. O Offgrid não altera o arquivo de build para instalar/configurar JaCoCo automaticamente; se a cobertura não estiver configurada, a ferramenta encerra com uma mensagem explícita. Isso permite usar cobertura como segunda etapa para Services, Controllers, validators e outras classes com regras/branches mais complexos, sem obrigar DTOs simples a pagar esse custo.

## Segurança

- `node_modules` e `.git` são somente leitura;
- caminhos absolutos e saídas do workspace são bloqueados;
- links simbólicos que escapam do workspace são rejeitados;
- no modo `ask`, alterações ficam apenas preparadas até o usuário aceitar o diff;
- backups são criados antes de substituir ou excluir arquivos existentes;
- terminal e memória persistente pedem confirmação quando necessário.

## Desenvolvimento

Requisitos:

- Node.js 20 ou superior;
- npm;
- VS Code 1.85 ou superior.

```powershell
npm install
npm run check
npm test
npm run compile
```

Abra a pasta do repositório no VS Code e pressione `F5`. A configuração `Executar Offgrid (TypeScript)` inicia o **Extension Development Host**.

Para testar a interface sem carregar um GGUF:

1. Pressione `Ctrl+Shift+P`.
2. Execute `Offgrid: Alternar Modo Visual Simulado`.
3. Abra o ícone Offgrid na Activity Bar.

O simulador mostra modelo, sessões, RAM/VRAM e revisão fictícia sem alterar arquivos.

## Empacotar

```powershell
npm run package
```

Arquivo esperado:

```text
offgrid-2.0.9.vsix
```

Os modelos em `globalStorage/rmagnocopilot.offgrid/models` permanecem após a atualização do VSIX.

## Logs e pastas

O canal `Exibir → Saída → Offgrid` e a pasta de logs registram motor, download, modelos, Agente e diagnósticos. O nível padrão é **`info`**, mantendo eventos relevantes, avisos e erros sem poluir a saída com heartbeat, RPC e detalhes internos do `llama.cpp`. Para investigação pontual, altere `offgrid.logLevel` para `debug` ou `trace`; `offgrid.diagnosticMode` continua desativado por padrão e pode registrar prompts e trechos de código. Os nomes e horários dos arquivos usam a data local do computador. Os arquivos são UTF-8, giram em 10 MB e mantêm até dez arquivos por categoria.

Comandos disponíveis:

- `Offgrid: Abrir Pasta dos Modelos`;
- `Offgrid: Abrir Pasta de Dados`;
- `Offgrid: Abrir Pasta de Logs`;
- `Offgrid: Copiar Diagnóstico Completo`.


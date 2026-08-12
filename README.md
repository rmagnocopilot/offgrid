<p align="center">
  <img src="resources/branding/offgrid-logo.png" alt="Offgrid" width="260">
</p>

# Offgrid 2.0.8

Assistente local e offline para Visual Studio Code, reescrito em **TypeScript**. A arquitetura segue a separação usada pelo Unplugged entre Agente, ferramentas, contexto, segurança, motor LLM e interface, preservando os recursos adicionais construídos no Offgrid.

## Novidades da versão 2.0.8

- adiciona o **Adaptive Fast Path**: antes de iniciar o AgentLoop, o Offgrid analisa deterministicamente a estrutura do projeto, módulo, linguagem, build, source/test roots, framework e arquivo de referência citado pelo usuário;
- pedidos guiados por padrão, como “crie os testes desta classe seguindo `AcompanhamentoObrasHistoricoDTOTest`”, passam a extrair o padrão real do workspace e inferir destino, pacote e nomenclatura sem depender da navegação do modelo;
- padrões mecânicos de alta confiança podem ser **sintetizados localmente em TypeScript**, sem chamar o LLM. O caso de DTO Java com getters/setters e teste de referência é tratado dessa forma, eliminando a geração de vários minutos observada no Qwen3 4B;
- quando interpretação semântica ainda é necessária, o Adaptive Fast Path usa uma **geração direta compacta**: o modelo devolve somente o conteúdo do arquivo. O TypeScript monta `create_file` internamente, evitando transportar milhares de caracteres dentro de JSON de ferramenta;
- o perfil do projeto é cacheado em memória e invalidado quando os manifests relevantes mudam, reduzindo varreduras repetidas do workspace;
- referências Java de teste preservam corpos reais de métodos `@Test` durante a compactação, permitindo aprender estilo e convenções sem enviar o arquivo inteiro ao modelo;
- o caminho genérico também suporta criação por referência explícita, por exemplo `PedidoService.java` seguindo `ClienteService.java`, quando destino e localização podem ser inferidos com alta confiança;
- se a síntese local ou a geração direta produzir conteúdo incompleto, com pacote incorreto ou chaves desbalanceadas, nenhuma escrita é preparada;
- o AgentLoop tradicional continua disponível como fallback para tarefas sem padrão estrutural confiável;
- mantém a proteção de contexto 4K, orçamento de resultados de ferramentas, detecção de `create_file` truncado e recuperação segura após operações somente de leitura;
- mantém perfil Vulkan rápido quando a carga deixa VRAM saudável e reduz camadas automaticamente apenas quando necessário;
- mantém as melhorias anteriores: fallback embarcado `node-llama-cpp`, logs de produção mais limpos, interface Chat/Planejar/Agente e revisão/rollback de alterações.

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
offgrid-2.0.8.vsix
```

Os modelos em `globalStorage/rmagnocopilot.offgrid/models` permanecem após a atualização do VSIX.

## Logs e pastas

O canal `Exibir → Saída → Offgrid` e a pasta de logs registram motor, download, modelos, Agente e diagnósticos. O nível padrão é **`info`**, mantendo eventos relevantes, avisos e erros sem poluir a saída com heartbeat, RPC e detalhes internos do `llama.cpp`. Para investigação pontual, altere `offgrid.logLevel` para `debug` ou `trace`; `offgrid.diagnosticMode` continua desativado por padrão e pode registrar prompts e trechos de código. Os nomes e horários dos arquivos usam a data local do computador. Os arquivos são UTF-8, giram em 10 MB e mantêm até dez arquivos por categoria.

Comandos disponíveis:

- `Offgrid: Abrir Pasta dos Modelos`;
- `Offgrid: Abrir Pasta de Dados`;
- `Offgrid: Abrir Pasta de Logs`;
- `Offgrid: Copiar Diagnóstico Completo`.


# Offgrid

> **Otimizado para Windows 10/11 x64.** No Windows, o Offgrid mede RAM, consulta VRAM quando o driver permite e adapta backend/GPU Layers. Em Linux e macOS, Chat, Planejar, Somente leitura e Agente continuam funcionando; apenas a medição avançada de VRAM e o autoajuste baseado no Windows ficam indisponíveis.

Assistente local para Visual Studio Code com modelos GGUF. A inferência ocorre no computador; o conteúdo do workspace não é enviado a serviços externos durante o chat.

## Modelos incluídos no catálogo

| Modelo | Uso recomendado | Tamanho aproximado |
|---|---|---:|
| Qwen2.5-Coder-3B-Instruct Q4_K_M | Máquinas mais limitadas e respostas rápidas | 2,1 GB |
| Qwen2.5-Coder-7B-Instruct Q4_K_M | Tarefas mais complexas de Angular, Java e refatoração | 4,7 GB |

O seletor no topo do chat diferencia **não instalado**, **instalado**, **ativo** e **carregado**. O Offgrid mantém no máximo um modelo carregado em memória.

## Offgrid 1.5 — estabilização e diagnóstico

- Loop real de ferramentas do Agente: chamadas como `listWorkspaceFiles` e `readWorkspaceFile` são executadas, e o resultado volta ao modelo.
- Arquivos citados pelo usuário têm prioridade sobre seleção ativa, arquivo fixado e busca geral.
- Modos separados: **Chat**, **Planejar**, **Somente leitura** e **Agente**.
- Descarregamento verificável de sessão, contexto, modelo e runtime, com confirmação visual e logs de cada etapa.
- Estados consistentes do motor: não iniciado, carregando, pronto, descarregando, descarregado e erro.
- Interface responsiva e diagnóstico configurável como `hidden`, `compact`, `expanded` ou `onError`.
- Histórico local de sessões com busca, renomear, fixar, duplicar e excluir.
- Seletor de modelo no chat, rollback para o último modelo funcional e fallback progressivo Vulkan → menos GPU Layers → CPU.
- Logs UTF-8 no Output Channel e em arquivos rotativos.
- Botão **Copiar diagnóstico** com ambiente, modelo, backend, memória, último erro e últimas linhas do log.
- Revisão visual por diff antes de salvar alterações do Agente.

## Windows, Linux e macOS

### Windows

Todos os recursos ficam disponíveis quando o hardware e o driver expõem os dados:

- RAM total, disponível e consumo do processo isolado;
- GPU e VRAM por `nvidia-smi` ou informações do Windows;
- perfis adaptativos por máquina e modelo;
- redução progressiva de GPU Layers;
- fallback automático para CPU.

### Linux e macOS

A extensão não deve falhar por estar fora do Windows. Continuam disponíveis:

- modelos GGUF, Chat e os três modos de análise/agente;
- RAM genérica e RAM do processo do motor;
- backend manual ou detecção padrão do `node-llama-cpp`;
- sessões, contexto, ferramentas e revisão por diff.

Ficam indisponíveis somente a VRAM avançada do Windows e o perfil adaptativo orientado por essa medição.

## Instalação

1. Em **Releases**, baixe o `.vsix` mais recente.
2. No VS Code, abra **Extensões → ... → Install from VSIX...**.
3. Reinicie o VS Code.
4. Abra o painel Offgrid e escolha um modelo no seletor superior.

## Configuração recomendada para diagnóstico inicial no Windows

```json
{
  "offgrid.gpu": "auto",
  "offgrid.gpuLayers": "auto",
  "offgrid.adaptiveGpu": true,
  "offgrid.fallbackToCpu": true,
  "offgrid.resourceMonitoring": true,
  "offgrid.resourceRefreshSeconds": 15,
  "offgrid.contextSize": 4096,
  "offgrid.maxAgentSteps": 10,
  "offgrid.diagnosticsPanel": "compact",
  "offgrid.logLevel": "debug",
  "offgrid.diagnosticMode": false,
  "offgrid.agentApprovalMode": "ask"
}
```

`offgrid.diagnosticMode` registra stack traces, prévias de prompts, caminhos e resultados de ferramentas. Ative apenas durante depuração, pois os logs podem conter partes do código e nomes de arquivos.

## Agente e contexto

Prioridade usada pelo Agente:

1. arquivos citados diretamente no pedido;
2. seleção ativa;
3. arquivo fixado ou aba atual;
4. arquivos relacionados;
5. busca geral no workspace.

No modo **Agente**, as mudanças ficam preparadas para revisão. Clique no arquivo para abrir o diff nativo do VS Code e escolha **Aceitar alterações** ou **Rejeitar**. `.git`, `node_modules` e caminhos fora do workspace permanecem protegidos contra escrita.

## Logs e diagnóstico

Abra **Exibir → Saída → Offgrid**. Os arquivos de log ficam na pasta de armazenamento global da extensão, dentro de `logs`, separados por categoria:

- `offgrid-AAAA-MM-DD.log`;
- `agent-AAAA-MM-DD.log`;
- `model-AAAA-MM-DD.log`;
- `diagnostics-AAAA-MM-DD.log`.

Cada categoria mantém até 10 arquivos, com rotação a partir de 10 MB.

Comandos úteis:

- `Offgrid: Copiar Diagnóstico Completo`
- `Offgrid: Abrir Pasta de Logs`
- `Offgrid: Mostrar RAM e VRAM`
- `Offgrid: Mostrar Diagnóstico do Modelo`
- `Offgrid: Mostrar Diagnóstico do Agente`
- `Offgrid: Reiniciar Processo do Motor`
- `Offgrid: Liberar Modelo da Memória`
- `Offgrid: Limpar Perfil Automático de Hardware`

## Processo isolado

O `node-llama-cpp` roda em um processo separado do Extension Host. O comando de descarregamento libera sessão, contexto, modelo e runtime dentro desse processo. O comando de reinício encerra e recria o processo inteiro quando for necessário recuperar uma falha nativa.

## Licenças

- Código: MIT.
- Qwen2.5-Coder-7B-Instruct: Apache-2.0.
- Qwen2.5-Coder-3B-Instruct: Qwen Research License.

# Offgrid

> **Otimizado para Windows 10/11 x64.** No Windows, o Offgrid mede RAM, consulta VRAM quando o driver permite, escolhe um perfil de GPU/CPU e executa o modelo em um processo separado. Em Linux e macOS, Chat e Agente continuam funcionando; apenas a medição avançada de VRAM e o autoajuste baseado nas APIs do Windows ficam indisponíveis.

Assistente de programação local para Visual Studio Code com modelos GGUF baixados pelo GitHub Releases. A inferência ocorre no computador e o conteúdo do workspace não é enviado ao GitHub nem a serviços externos durante o chat.

## Modelos

| Modelo | Indicação | Tamanho aproximado |
|---|---|---:|
| Qwen2.5-Coder-3B-Instruct Q4_K_M | Máquina com pouca memória; pesquisa/não comercial | 2,1 GB |
| Qwen2.5-Coder-7B-Instruct Q4_K_M | Angular, TypeScript, HTML, Java e Spring | 4,7 GB |

O seletor no topo do chat mostra se cada modelo está **não instalado**, **instalado**, **ativo** ou **carregado na memória**. Apenas um modelo permanece carregado por vez.

## Recursos principais

- Motor local executado em **processo isolado** do Extension Host.
- RAM do sistema e RAM precisa do processo do motor.
- No Windows, consulta de VRAM por `nvidia-smi` ou pelas informações disponibilizadas pelo Windows.
- Perfil automático por modelo e computador.
- Tentativas progressivas de GPU Layers antes do fallback final para CPU.
- Histórico das configurações de hardware que funcionaram ou falharam.
- Reinício do motor sem reiniciar todo o VS Code.
- Troca rápida de modelo dentro do chat.
- Histórico local de sessões.
- Arquivo ativo ou fixado como ponto de partida da análise.
- Contexto adicional por arquivo, seleção ou pasta.
- Modo Agente com pesquisa no workspace e leitura protegida de `node_modules`.
- Revisão visual por diff antes de salvar.

## Compatibilidade de sistema operacional

### Windows

Todos os recursos estão disponíveis:

- RAM total, livre e em uso.
- RAM exclusiva do processo do motor.
- Nome da GPU e VRAM, quando expostos pelo driver.
- Perfil automático de backend e GPU Layers.
- Aviso antes de tentar modelos que não cabem nos recursos disponíveis.
- Fallback progressivo para menos camadas e, por fim, CPU.

### Linux e macOS

A extensão **não falha nem deixa de iniciar**. Permanecem disponíveis:

- Chat e Agente.
- Modelos GGUF.
- RAM total e disponível.
- RAM do processo isolado do motor.
- Backend manual ou detecção padrão do `node-llama-cpp`.

Ficam indisponíveis apenas:

- Medição avançada de VRAM baseada no Windows.
- Perfil adaptativo orientado pelo orçamento de GPU do Windows.

O painel exibirá `VRAM detalhada: somente Windows` e seguirá com a configuração padrão/fallback.

## Instalação

1. Abra **Releases**.
2. Baixe o `.vsix` da versão mais recente.
3. No VS Code, use **Extensões → ... → Install from VSIX...**.
4. Reinicie o VS Code.
5. Escolha o modelo no seletor exibido no topo do chat.

## Configuração recomendada no Windows

```json
{
  "offgrid.gpu": "auto",
  "offgrid.gpuLayers": "auto",
  "offgrid.adaptiveGpu": true,
  "offgrid.fallbackToCpu": true,
  "offgrid.resourceMonitoring": true,
  "offgrid.resourceRefreshSeconds": 15,
  "offgrid.contextSize": 4096,
  "offgrid.includeWorkspaceContext": true,
  "offgrid.autoLoadModel": true,
  "offgrid.agentApprovalMode": "ask"
}
```

Para forçar CPU:

```json
{
  "offgrid.gpu": "cpu",
  "offgrid.gpuLayers": 0
}
```

## Como funciona o perfil automático

1. O Offgrid mede os recursos antes do carregamento.
2. Consulta um perfil anteriormente validado para esse modelo e computador.
3. Quando necessário, tenta uma quantidade parcial de GPU Layers.
4. Se faltar VRAM, reduz as camadas progressivamente.
5. Se ainda falhar, tenta CPU.
6. A configuração que funcionar é salva para o próximo carregamento.

O perfil pode ser removido com:

```text
Offgrid: Limpar Perfil Automático de Hardware
```

## Processo isolado do motor

O `node-llama-cpp` roda em um processo separado. Isso permite:

- medir a RAM usada pelo Offgrid com mais precisão;
- descarregar o modelo encerrando o processo;
- recuperar falhas nativas sem derrubar o Extension Host;
- reiniciar o motor com `Offgrid: Reiniciar Processo do Motor`.

Essa versão prepara a arquitetura para um serviço compartilhado entre IDEs, mas o compartilhamento simultâneo com o plugin IntelliJ ainda exige uma atualização própria do **OffGrid IntJ**.

## Modo Agente e revisão

O modo padrão de aprovação é **Perguntar sempre**:

1. O agente pesquisa e prepara a proposta.
2. O chat lista os arquivos afetados.
3. Clique em **Ver diff** para abrir a comparação nativa do VS Code.
4. Linhas removidas aparecem em vermelho e linhas novas em verde.
5. Escolha **Aceitar alterações** ou **Rejeitar**.

As pastas `.git`, `node_modules` e outras pastas protegidas permanecem bloqueadas para escrita.

## Diagnóstico

Abra **Exibir → Saída → Offgrid** ou execute:

- `Offgrid: Mostrar RAM e VRAM`
- `Offgrid: Mostrar Diagnóstico do Modelo`
- `Offgrid: Mostrar Diagnóstico do Agente`
- `Offgrid: Reiniciar Processo do Motor`
- `Offgrid: Liberar Modelo da Memória`

## Licenças

- Código: MIT.
- Qwen2.5-Coder-7B-Instruct: Apache-2.0.
- Qwen2.5-Coder-3B-Instruct: Qwen Research License.

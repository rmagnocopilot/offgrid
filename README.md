<p align="center">
  <img src="resources/branding/offgrid-logo.png" alt="Offgrid" width="260">
</p>

# Offgrid 2.0.5

Assistente local e offline para Visual Studio Code, reescrito em **TypeScript**. A arquitetura segue a separação usada pelo Unplugged entre Agente, ferramentas, contexto, segurança, motor LLM e interface, preservando os recursos adicionais construídos no Offgrid.

## Novidades da versão 2.0.5

- fallback automático para o motor embarcado `node-llama-cpp` quando o Windows bloqueia a execução do `llama-server`;
- suporte embarcado aos backends CPU e Vulkan no Windows;
- compatibilidade com ambientes corporativos que aplicam políticas de grupo contra executáveis baixados;
- manutenção do `llama-server` como motor principal em máquinas sem restrições;
- mensagem de diagnóstico indicando quando o motor alternativo é ativado.
## Abrir o Offgrid

Após instalar o VSIX, clique no ícone **Offgrid** na Activity Bar, a barra vertical esquerda do VS Code. Também é possível clicar no status `Offgrid` na barra inferior ou executar `Offgrid: Abrir Chat`.

Na primeira instalação, o painel é aberto uma única vez para apresentar o seletor de modelos.

## Modos

- **Chat:** conversa comum, com contexto opcional de arquivos.
- **Planejar:** pesquisa o workspace e propõe um plano, sem ferramentas de escrita.
- **Somente leitura:** permite pesquisa, símbolos, referências, Git e diagnósticos, sem escrita.
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
offgrid-2.0.5.vsix
```

Os modelos em `globalStorage/rmagnocopilot.offgrid/models` permanecem após a atualização do VSIX.

## Logs e pastas

O canal `Exibir → Saída → Offgrid` e a pasta de logs registram motor, download, modelos, Agente e diagnósticos. Os nomes e horários dos arquivos usam a data local do computador. Os arquivos são UTF-8, giram em 10 MB e mantêm até dez arquivos por categoria.

Comandos disponíveis:

- `Offgrid: Abrir Pasta dos Modelos`;
- `Offgrid: Abrir Pasta de Dados`;
- `Offgrid: Abrir Pasta de Logs`;
- `Offgrid: Copiar Diagnóstico Completo`.


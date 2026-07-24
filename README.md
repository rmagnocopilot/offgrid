# Offgrid

Assistente de programação local para Visual Studio Code, desenvolvido para funcionar sem acesso direto ao Hugging Face.

O Offgrid baixa os modelos pelo GitHub Releases, remonta o arquivo GGUF no computador e valida sua integridade antes do uso. Depois da instalação, toda a inferência acontece localmente.

O código do workspace não é enviado ao GitHub nem a serviços externos durante o uso.

## Modelos disponíveis

| Modelo | Recomendação | Tamanho aproximado |
|---|---|---:|
| Qwen2.5-Coder-3B-Instruct Q4_K_M | Sem GPU ou com pouca memória RAM | 2,1 GB |
| Qwen2.5-Coder-7B-Instruct Q4_K_M | 16 GB ou mais de RAM ou GPU compatível | 4,7 GB |

> O modelo 3B utiliza a Qwen Research License e é destinado somente a pesquisa ou uso não comercial. O modelo 7B utiliza a licença Apache-2.0.

## Instalação

1. Abra **Releases** neste repositório.
2. Abra a versão mais recente do Offgrid.
3. Em **Assets**, baixe o arquivo `.vsix`.
4. No VS Code, abra **Extensões → ... → Install from VSIX...**.
5. Selecione o arquivo baixado e reinicie o VS Code.

## Baixar um modelo

1. Pressione `Ctrl + Shift + P`.
2. Execute `Offgrid: Gerenciar Modelos`.
3. Escolha o modelo e aguarde o download e a validação.

Os modelos são baixados exclusivamente pelos assets do GitHub Releases.

Em repositórios privados, execute antes `Offgrid: Configurar Token do GitHub` e informe um token com permissão de leitura para o repositório.

Em repositórios públicos, nenhuma configuração de token é necessária.

## Chat e modo Agente

Abra o painel Offgrid na barra lateral do VS Code ou execute `Offgrid: Abrir Chat`.

- **Chat — somente resposta:** analisa o contexto e responde sem modificar arquivos.
- **Agente — altera arquivos:** pesquisa o workspace, consulta bibliotecas instaladas em `node_modules` e salva as alterações solicitadas.

No modo Agente:

- `node_modules` e `.git` são sempre somente leitura.
- Nenhum arquivo pode ser alterado fora do workspace.
- Um backup é criado antes das alterações.
- Use `Offgrid: Desfazer Últimas Alterações do Agente` para restaurar o backup mais recente.
- Comandos de terminal não são executados automaticamente.

O modelo 7B é o mais recomendado para alterações envolvendo vários arquivos.

## Privacidade

A execução do modelo acontece localmente no computador.

O código aberto no VS Code não é enviado ao GitHub nem a serviços externos durante o chat. A conexão com a internet é utilizada apenas para baixar o modelo quando ele ainda não está instalado.

## Armazenamento

O modelo é salvo no armazenamento interno da extensão, fora da pasta do projeto e fora do controle de versão do Git.

Para remover um modelo instalado, execute `Offgrid: Gerenciar Modelos`.

## Configurações principais

- `offgrid.gpu`: `auto`, `cpu`, `cuda`, `vulkan` ou `metal`.
- `offgrid.contextSize`: tamanho da janela de contexto.
- `offgrid.agentMaxTokens`: limite de geração usado pelo modo Agente.
- `offgrid.agentRequireConfirmation`: pede confirmação antes de alterar o workspace.
- `offgrid.includeWorkspaceContext`: inclui o arquivo ativo no modo Chat.
- `offgrid.modelPath`: caminho do modelo GGUF atualmente selecionado.

## Licenças

- Código do Offgrid: MIT.
- Qwen2.5-Coder-7B-Instruct: Apache-2.0.
- Qwen2.5-Coder-3B-Instruct: Qwen Research License.

Consulte `LICENSE`, `NOTICE` e `MODEL_LICENSES.md`.

# Offgrid

Assistente de programação local para Visual Studio Code, desenvolvido para funcionar sem acesso direto ao Hugging Face.

O Offgrid baixa os modelos pelo GitHub Releases, remonta o arquivo GGUF no computador e valida sua integridade antes do uso. Depois da instalação, toda a inferência acontece localmente.

## Modelos disponíveis

| Modelo                           | Recomendação                                            | Tamanho aproximado |
| -------------------------------- | ------------------------------------------------------- | -----------------: |
| Qwen2.5-Coder-3B-Instruct Q4_K_M | Computadores sem GPU ou com pouca memória RAM           |             2,1 GB |
| Qwen2.5-Coder-7B-Instruct Q4_K_M | Computadores com 16 GB ou mais de RAM ou GPU compatível |             4,7 GB |

> O modelo 3B utiliza a Qwen Research License e é destinado somente a pesquisa ou uso não comercial. O modelo 7B utiliza a licença Apache-2.0.

## Instalação

1. Acesse a seção **Releases** deste repositório.
2. Abra a versão mais recente do Offgrid.
3. Em **Assets**, baixe o arquivo:

```text
offgrid-1.0.0.vsix
```

4. Abra o Visual Studio Code.
5. Acesse **Extensões**.
6. Clique no menu `...`.
7. Selecione **Install from VSIX...**.
8. Escolha o arquivo baixado.
9. Reinicie o VS Code após a instalação.

## Baixar um modelo

No Visual Studio Code:

1. Pressione `Ctrl + Shift + P`.
2. Execute:

```text
Offgrid: Gerenciar Modelos
```

3. Escolha o modelo desejado.
4. Aguarde o download e a validação.

Os modelos são baixados exclusivamente pelos assets do GitHub Releases.

## Usar o chat

Após instalar um modelo:

1. Pressione `Ctrl + Shift + P`.
2. Execute:

```text
Offgrid: Abrir Chat
```

O chat também pode ser aberto pelo ícone do Offgrid na barra lateral do VS Code.

## Privacidade

A execução do modelo acontece localmente no computador.

O código aberto no VS Code não é enviado ao GitHub nem a serviços externos durante o chat. A conexão com a internet é utilizada apenas para baixar o modelo quando ele ainda não está instalado.

## Armazenamento

O modelo é salvo no armazenamento interno da extensão, fora da pasta do projeto e fora do controle de versão do Git.

Para remover um modelo instalado, execute:

```text
Offgrid: Gerenciar Modelos
```

## Repositório privado

Se este repositório estiver privado, execute antes do download:

```text
Offgrid: Configurar Token do GitHub
```

Informe um token com permissão de leitura para o repositório.

Em repositórios públicos, nenhuma configuração de token é necessária.

## Configurações

As configurações do Offgrid podem ser alteradas nas preferências do VS Code:

* `offgrid.gpu`: seleciona `auto`, `cpu`, `cuda`, `vulkan` ou `metal`.
* `offgrid.contextSize`: define o tamanho do contexto do modelo.
* `offgrid.includeWorkspaceContext`: permite incluir informações do projeto aberto nas respostas.
* `offgrid.modelPath`: caminho do modelo GGUF atualmente selecionado.

## Licenças

* Código do Offgrid: MIT.
* Qwen2.5-Coder-7B-Instruct: Apache-2.0.
* Qwen2.5-Coder-3B-Instruct: Qwen Research License.

Consulte os arquivos `LICENSE`, `NOTICE` e `MODEL_LICENSES.md` para mais informações.

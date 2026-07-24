# Offgrid

Clone funcional e independente do conceito do projeto **Unplugged**, preparado para funcionar sem acesso direto ao Hugging Face na máquina corporativa.

Os modelos são provisionados uma única vez por **GitHub Actions** e publicados em partes no **GitHub Release** da sua conta. Depois disso, a extensão baixa exclusivamente do GitHub, remonta o GGUF e valida seu SHA-256 antes de usar.

## Modelos incluídos no catálogo

| Modelo | Indicação | Tamanho aproximado | Licença |
|---|---|---:|---|
| Qwen2.5-Coder-7B-Instruct Q4_K_M | GPU até 8 GB ou CPU com 16 GB+ RAM | 4,7 GB | Apache-2.0; opção empresarial padrão |
| Qwen2.5-Coder-3B-Instruct Q4_K_M | Sem GPU ou RAM limitada | 2,1 GB | Qwen Research License; somente pesquisa/não comercial |

> O 3B não deve ser usado em produto, operação comercial ou atividade empresarial comum sem uma licença comercial separada. Consulte `MODEL_LICENSES.md`.

## Estrutura

```text
.github/workflows/publish-models.yml  baixa e publica os GGUF no Release
models/manifest.json                 catálogo, partes e hashes oficiais
src/model-installer.js               download, remontagem e SHA-256
src/llama-engine.js                  inferência local com node-llama-cpp
src/chat-view.js                     interface de chat no VS Code
src/extension.js                     ativação, contexto e comandos
scripts/                              configuração e publicação manual
```

## 1. Criar o repositório na sua conta

Descompacte este projeto e execute:

```bash
cd offgrid
npm run configure -- SEU_USUARIO offgrid
git init
git add .
git commit -m "Initial offline release"
git branch -M main
git remote add origin https://github.com/SEU_USUARIO/offgrid.git
git push -u origin main
```

O script `configure` atualiza o campo `repository` e o `publisher` no `package.json`. Isso permite que a extensão descubra automaticamente o endereço do próprio Release.

## 2. Publicar os modelos

Na página do novo repositório:

1. Abra **Actions**.
2. Selecione **Publicar modelos no GitHub Release**.
3. Clique em **Run workflow**.
4. Para incluir o 3B, mantenha a opção marcada e digite exatamente `SOMENTE PESQUISA` no campo de aceite.

O job cria o Release `models-v1`, valida os hashes e publica cada modelo em partes menores que 2 GB. A máquina da empresa não acessa o Hugging Face; somente o runner do GitHub Actions faz esse provisionamento inicial.

## 3. Empacotar a extensão

```bash
npm install
npm run check
npm test
npm run package
```

Será gerado um arquivo `.vsix`. No VS Code, use **Extensions: Install from VSIX...**.

## 4. Instalar e usar um modelo

1. Execute `Offgrid: Gerenciar Modelos`.
2. Escolha o 7B ou o 3B.
3. Aguarde o download, a remontagem e a verificação do SHA-256.
4. Abra o painel **Offgrid** na barra lateral.

O arquivo final fica no armazenamento global da extensão, fora do workspace e fora do Git.

## Repositório privado

Antes de instalar o modelo, execute `Offgrid: Configurar Token do GitHub`. Informe um token com permissão de leitura para o repositório privado. Ele é armazenado no SecretStorage do VS Code.

Para um repositório público, nenhum token é necessário.

## Publicar modelos que você já baixou

Linux/macOS:

```bash
./scripts/publish-existing-models.sh /caminho/para/pasta-dos-modelos
```

Windows PowerShell:

```powershell
./scripts/publish-existing-models.ps1 -ModelDir "C:\modelos"
```

Os nomes esperados são:

```text
qwen2.5-coder-3b-instruct-q4_k_m.gguf
qwen2.5-coder-7b-instruct-q4_k_m.gguf
```

## Configurações importantes

- `offgrid.modelPath`: caminho do GGUF ativo.
- `offgrid.releaseBaseUrl`: sobrescreve o Release inferido do `package.json`.
- `offgrid.gpu`: `auto`, `cpu`, `cuda`, `vulkan` ou `metal`.
- `offgrid.contextSize`: contexto carregado, padrão 8192.
- `offgrid.includeWorkspaceContext`: inclui arquivo ativo e uma amostra da árvore do workspace.

## Segurança e privacidade

A inferência ocorre localmente com `node-llama-cpp`. O conteúdo do código não é enviado ao GitHub durante o chat. A rede é usada apenas para baixar os assets do Release quando o modelo ainda não está instalado.

## Licenças

- Código deste repositório: MIT.
- Qwen 7B: Apache-2.0.
- Qwen 3B: Qwen Research License, somente não comercial sem licença separada.
- Consulte `LICENSE`, `NOTICE` e `MODEL_LICENSES.md`.

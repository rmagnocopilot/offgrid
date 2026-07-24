# Como os modelos são acoplados ao repositório

Arquivos de 2–5 GB não devem ser gravados diretamente no histórico Git. Este projeto usa um Release chamado `models-v1`.

O workflow `.github/workflows/publish-models.yml`:

1. baixa o GGUF oficial no runner do GitHub Actions;
2. valida o SHA-256 conhecido;
3. divide o arquivo em partes de 1.900 MB;
4. publica as partes no Release `models-v1`;
5. publica o manifesto e as licenças oficiais.

A extensão:

1. baixa as partes apenas do GitHub do proprietário do clone;
2. remonta o `.gguf` em `globalStorage` do VS Code;
3. valida novamente o SHA-256;
4. apaga as partes temporárias;
5. ativa o modelo.

## Release privado

Execute `Offgrid: Configurar Token do GitHub` e informe um token com acesso de leitura ao repositório. O token fica no SecretStorage do VS Code, não no `settings.json`.

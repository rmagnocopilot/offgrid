# Modelos

Os pesos GGUF não ficam no histórico Git. O workflow `publish-models.yml` baixa, valida, divide e publica os arquivos no GitHub Release `models-v1`.

A extensão baixa somente os assets do seu próprio GitHub Release, remonta o GGUF no armazenamento global do VS Code e valida o SHA-256 antes de ativá-lo.

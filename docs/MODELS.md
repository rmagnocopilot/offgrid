# Modelos

Os pesos GGUF não ficam no histórico Git. O workflow `publish-models.yml` baixa, valida, divide e publica os arquivos no GitHub Release `models-v1`.

A extensão baixa somente os assets do seu próprio GitHub Release, remonta o GGUF no armazenamento global do VS Code e valida o SHA-256 antes de ativá-lo.

## Catálogo

- Qwen2.5-Coder 3B Q4_K_M: opção econômica, contexto automático de 4096 a 8192.
- Qwen3 4B Q4_K_M: opção intermediária, contexto automático de 4096 a 12288 e modo `/no_think` aplicado pelo Offgrid.
- Qwen2.5-Coder 7B Q4_K_M: opção avançada, contexto automático de 4096 a 16384.

## Contexto automático

Por padrão, o Offgrid escolhe a janela de contexto considerando o modelo selecionado, a memória livre, a complexidade da tarefa e a quantidade estimada de arquivos. FastPaths não provocam recarga do modelo. Quando uma tarefa realmente precisa do modelo e o contexto atual é insuficiente, o servidor é reiniciado uma única vez com um contexto maior. Se a carga falhar por memória, o Offgrid tenta valores menores.

A configuração `offgrid.contextMode` pode ser alterada para `manual`; nesse modo, o valor fixo de `offgrid.contextSize` é respeitado.

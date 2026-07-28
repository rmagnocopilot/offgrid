# Offgrid

Assistente de programação local para Visual Studio Code com modelos GGUF baixados pelo GitHub Releases.

A inferência ocorre no computador. O conteúdo do workspace não é enviado ao GitHub nem a serviços externos durante o chat.

## Modelos

| Modelo | Indicação | Tamanho aproximado |
|---|---|---:|
| Qwen2.5-Coder-3B-Instruct Q4_K_M | Máquina com pouca memória; pesquisa/não comercial | 2,1 GB |
| Qwen2.5-Coder-7B-Instruct Q4_K_M | Angular, TypeScript, HTML, Java e Spring | 4,7 GB |

## Instalação

1. Abra **Releases**.
2. Baixe o `.vsix` da versão mais recente.
3. No VS Code, use **Extensões → ... → Install from VSIX...**.
4. Reinicie o VS Code.
5. Execute **Offgrid: Gerenciar Modelos** e escolha o 7B.

## Arquivo fixado

O Offgrid acompanha automaticamente a aba de código ativa e mostra o arquivo de contexto acima do chat.

- **Fixar aba:** mantém aquele arquivo como ponto de partida, mesmo que outras abas sejam abertas.
- **Auto:** volta a acompanhar a aba ativa.
- **Abrir:** reabre o arquivo fixado.

No modo Agente, esse arquivo é lido primeiro e serve como início da pesquisa pelos arquivos relacionados.

## Revisão das alterações

O agente não salva imediatamente.

1. Ele pesquisa o workspace e prepara a proposta.
2. O chat mostra a lista de arquivos afetados.
3. Clique em **Ver diff** para abrir a comparação do VS Code:
   - linhas antigas ou removidas aparecem em vermelho;
   - linhas novas aparecem em verde.
4. Escolha **Aceitar alterações** ou **Rejeitar**.
5. Depois de aceitar, ainda é possível executar **Offgrid: Desfazer Últimas Alterações do Agente**.

`node_modules` e `.git` permanecem somente leitura.

## Diagnóstico de modelo

Se o modelo não carregar:

1. Execute **Offgrid: Recarregar Modelo**.
2. Abra **Exibir → Saída**.
3. Selecione o canal **Offgrid**.

No backend `auto`, a extensão tenta a detecção automática e usa CPU como alternativa se ela falhar.

## Configuração recomendada

```json
{
  "offgrid.gpu": "auto",
  "offgrid.contextSize": 4096,
  "offgrid.includeWorkspaceContext": true,
  "offgrid.agentRequireReview": true
}
```

## Licenças

- Código: MIT.
- Qwen2.5-Coder-7B-Instruct: Apache-2.0.
- Qwen2.5-Coder-3B-Instruct: Qwen Research License.

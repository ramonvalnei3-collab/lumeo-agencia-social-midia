# Altos Sabores Restaurante: sistema de caixa

Sistema de frente de caixa (PDV) para o restaurante por quilo **Altos Sabores**: comandas, peso do prato, bebidas e sobremesas, pagamento, abertura e fechamento de caixa, impressão térmica, NFC-e e relatório mensal para o contador.

## O que tem aqui

| Pasta | Conteúdo |
|---|---|
| `sistema/` | **O sistema de verdade**: servidor com banco de dados (SQLite) e login por e-mail e senha. Veja `sistema/README.md` para instalar no computador do caixa. |
| `prototipo/` | Protótipo navegável (abra `prototipo/index.html` no navegador). Os dados ficam só no navegador; serve para testar telas. |
| `docs/PROMPT-SISTEMA.md` | O prompt/especificação completa do sistema, por fases. |
| `docs/logo-altos-sabores.jpg` | Logo original. |

## Fases

1. **Comandas e caixa**: abrir/reabrir comanda, peso em gramas × preço do quilo, bebidas e sobremesas, pagamento com várias formas, troco, sangria, suprimento, fechamento com conferência, cupom de conferência. *(o protótipo cobre esta fase)*
2. **NFC-e**: emissão via API, contingência offline, cancelamento.
3. **Relatórios para o contador**: ZIP com XMLs das notas + resumo em PDF e planilha, para qualquer período.
4. **Opcional**: balança ligada no computador, e-mail automático para o contador, mais de um caixa.

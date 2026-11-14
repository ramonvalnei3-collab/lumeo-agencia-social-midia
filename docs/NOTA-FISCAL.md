# Nota fiscal (NFC-e) · o que fazer agora

A nota do restaurante é a **NFC-e** (nota fiscal do consumidor, modelo 65). O sistema já está preparado;
falta a parte que só a empresa e o contador conseguem fazer. Quanto antes começar, melhor: alguns itens levam dias.

## Checklist

| # | O que | Quem | Situação |
|---|---|---|---|
| 1 | Certificado digital A1 (e-CNPJ) | Empresa | ✅ Pronto (vence 29/10/2027) |
| 2 | Inscrição estadual ativa | Contador | ⬜ Confirmar |
| 3 | Credenciamento para emitir NFC-e na SEFAZ do estado | Contador | ⬜ Pedir |
| 4 | Código CSC (ID + token) gerado no site da SEFAZ | Contador ou empresa | ⬜ Pedir |
| 5 | Tabela fiscal dos produtos (NCM, CFOP, CSOSN/CST, CEST) | Contador | ⬜ Mandar a planilha |
| 6 | Série e último número de NFC-e já usados (se já emitiram antes) | Contador / sistema antigo | ⬜ Perguntar |
| 7 | Conta no serviço emissor de NFC-e | Empresa | ⬜ Escolher |

## 1. Mensagem pronta para o contador

> Olá! Estamos colocando um sistema de caixa novo no restaurante (Altos Sabores, CNPJ 63.062.421/0001-67) e vamos emitir **NFC-e** por ele. Preciso da sua ajuda com:
>
> 1. Confirmar se a **inscrição estadual** está ativa e qual o **regime tributário/CRT** (Simples Nacional?).
> 2. Fazer (ou confirmar) o **credenciamento para emissão de NFC-e** na SEFAZ.
> 3. Gerar o **CSC** (código de segurança do contribuinte) de **produção** e de **homologação** na SEFAZ e me passar o **ID** e o **código** de cada um.
> 4. Preencher a planilha em anexo com **NCM, CFOP, CSOSN/CST, CEST e origem** de cada produto, incluindo a refeição por quilo. Bebidas costumam ter substituição tributária; por favor confira.
> 5. Se já emitimos NFC-e antes, qual **série** usamos e qual foi o **último número**.
> 6. Alguma regra do nosso estado que eu deva saber (prazo de cancelamento, contingência).
>
> O certificado digital A1 já temos. Obrigado!

Anexe o arquivo **`tabela-fiscal-produtos.csv`** (abre no Excel). Ele tem a lista de exemplo do sistema;
troque/complete com os produtos reais antes de mandar.

## 2. Como o sistema vai falar com a SEFAZ (custo)

| Caminho | Custo mensal | Prós | Contras |
|---|---|---|---|
| **Serviço emissor pago** (Focus NFe, PlugNotas, WebmaniaBR…) | A partir de ~R$ 90/mês (Focus NFe Solo, nov/2026; confirmar franquia de notas) | Mais rápido de ligar; eles cuidam das mudanças de regra e da contingência | Mensalidade |
| **Ligação direta com a SEFAZ** (feita no próprio sistema) | R$ 0 | Sem mensalidade | Mais tempo de desenvolvimento; nós cuidamos das atualizações de regra (Notas Técnicas) |
| Aplicativo gratuito do estado (só alguns estados, ex.: ES) | R$ 0 | Grátis | Fica fora do sistema: nota digitada à mão, não resolve |

Os testes (homologação) não têm custo em nenhum caminho. A mensalidade do emissor pode entrar no valor cobrado do cliente.

## 3. Cuidados

- **Certificado e senha** vão só no painel do serviço emissor ou no servidor, nunca por e-mail, WhatsApp ou chat.
- Comece em **homologação** (notas de teste, sem valor fiscal). Só passe para **produção** depois de testar.
- **NFC-e só para pessoa física:** desde nov/2025 a NFC-e não pode sair no CNPJ de empresa (Ajuste SINIEF 11/2025). O sistema já recusa CNPJ e confere o CPF. Empresa que pedir nota precisa de NF-e (modelo 55).
- NFC-e emitida não se edita: corrige-se cancelando (prazo curto, em geral 30 min) e emitindo outra.

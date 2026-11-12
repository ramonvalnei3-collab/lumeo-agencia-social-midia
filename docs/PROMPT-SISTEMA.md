# Prompt do sistema: Altos Sabores Restaurante

Especificação para desenvolver o sistema de caixa (PDV). O protótipo da Fase 1 está em `prototipo/index.html` e serve de referência visual e de comportamento.

## Contexto
Restaurante self-service por quilo **Altos Sabores**. Hoje anotamos tudo à mão em papel. Queremos um
sistema de frente de caixa simples, rápido e em português (pt-BR), usado no computador
do caixa, com impressora térmica e emissão de NFC-e (nota fiscal do consumidor).

Dados do negócio (preencher):
- Estado (UF): ____
- Regime tributário: ____ (ex.: Simples Nacional)
- Preço do quilo: R$ 95,00 (configurável pelo gerente)
- Impressora: ____ (térmica 80mm, ESC/POS)
- Quantidade de caixas: 1
- Formas de pagamento aceitas: Dinheiro, Débito, Crédito, Pix, Vale-refeição, Vale-alimentação

## Identidade visual
- Logo: `docs/logo-altos-sabores.jpg` (letras creme sobre laranja).
- Cores: laranja da marca `#C55412` (topo e botões principais), laranja escuro `#9E410B`, creme `#E5E1D8`, fundo `#F7F4EF`, texto `#2B1D14`.
- Verde `#2F7D4F` só para "receber/pago"; vermelho `#B3261E` só para cancelar/remover/falta.
- Fontes: Lilita One (números grandes e títulos), Figtree (texto).

## Tecnologia
- Aplicação web rodando LOCALMENTE no PC do caixa (Windows), para continuar funcionando
  se a internet cair. Pode ser empacotada como app desktop (Electron) ou serviço local.
- Backend: Node.js + TypeScript. Banco: SQLite via Prisma (migrável para PostgreSQL
  se houver mais de um caixa).
- Frontend: React + Vite + Tailwind, pensado para operar 100% pelo teclado.
- Impressão: ESC/POS direto na impressora (USB ou rede), papel 80mm, com corte
  automático e acionamento da gaveta de dinheiro.
- NFC-e: integração com API emissora de terceiros (ex.: Focus NFe ou Nuvem Fiscal).
  Criar uma interface `FiscalProvider` para poder trocar de fornecedor sem mexer no
  resto do sistema. Começar SEMPRE em ambiente de homologação.
- Valores em dinheiro sempre armazenados em centavos (inteiro), nunca float.
- Formato brasileiro: R$ 48,17 / 0,507 kg / dd/mm/aaaa / fuso America/Sao_Paulo.
- Backup automático diário do banco e dos XMLs (pasta local + cópia na nuvem).

## Regras de negócio

### Comandas
- Abrir comanda pelo número do cartão de comanda físico (ou numeração automática).
- Status: ABERTA → PAGA/FECHADA, ou CANCELADA.
- Tela inicial: lista de comandas abertas com número, total e há quanto tempo está aberta.
- Lançar refeição por quilo: o operador digita o peso em gramas (ex.: 507) e o sistema
  calcula 0,507 kg × R$ 95,00 = R$ 48,17 (2 casas, arredondamento meio para cima).
  Pode haver mais de um prato na mesma comanda.
- Lançar bebidas, sobremesas e outros: busca por nome/código + botões de atalho
  para os mais vendidos + quantidade.
- Alterar quantidade/remover item enquanto aberta; toda remoção fica registrada
  (quem, quando, o quê).
- Reabrir comanda: livre enquanto não houver NFC-e emitida. Se já houver nota:
  exigir senha de gerente, cancelar a NFC-e (dentro do prazo do estado, com
  justificativa de no mínimo 15 caracteres) e só então reabrir.
- Imprimir "conferência de conta" (não fiscal) a qualquer momento.

### Pagamento
- Formas: Dinheiro (com cálculo de troco), Débito, Crédito, Pix, Vale-refeição,
  Vale-alimentação, Outros.
- Permitir várias formas na mesma comanda e dividir a conta em N partes.
- Desconto (R$ ou %) somente com senha de gerente.
- CPF/CNPJ na nota opcional.
- Ao confirmar: emitir NFC-e → imprimir DANFE NFC-e com QR Code → abrir gaveta se
  houver dinheiro.
- Se a emissão falhar: mostrar mensagem clara em português, permitir tentar de novo
  ou emitir em contingência offline. A venda nunca pode ser perdida.

### Caixa
- Abertura: operador + valor do fundo de troco. Não permite receber sem caixa aberto.
- Sangria (retirada) e suprimento (entrada) com motivo e comprovante impresso.
- Fechamento: mostra o total esperado por forma de pagamento; o operador digita o
  valor contado; o sistema mostra sobra/falta; imprime relatório de fechamento.
- Avisar se houver comandas abertas na hora de fechar.
- Caixa fechado fica bloqueado; só gerente pode reabrir.

### NFC-e
- Cada produto tem: NCM, CFOP, CSOSN/CST, CEST, origem, unidade (KG ou UN) e
  alíquotas — dados fornecidos pelo contador.
- Item "Refeição por quilo": unidade KG, quantidade com 3 casas decimais.
- Guardar XML autorizado, XML de cancelamento e inutilizações, com status de cada nota.
- Cancelamento dentro do prazo do estado; reimpressão de DANFE.
- Tela de configuração fiscal: upload do certificado A1, CSC e ID do CSC, série,
  numeração, ambiente (homologação/produção).

### Relatórios (disponíveis a qualquer momento, com filtro de período)
- Notas fiscais: número, série, data/hora, valor, status (autorizada, cancelada,
  contingência) e chave de acesso.
- Exportação para o contador: arquivo ZIP com todos os XMLs do período (autorizadas,
  canceladas e inutilizadas) + resumo em PDF + planilha (Excel/CSV) com totais.
- Vendas por dia/período, por forma de pagamento, kg vendidos, ticket médio,
  produtos mais vendidos.
- Histórico de fechamentos de caixa com diferenças.
- Log de cancelamentos, descontos e itens removidos (quem, quando, motivo).
- (Opcional) envio automático por e-mail para o contador todo dia 1º.

### Usuários
- Perfis: Operador de Caixa e Gerente.
- Gerente: cadastro de produtos, preço do quilo, cancelamentos, descontos, reabrir
  caixa e relatórios.
- Login rápido por PIN.

### Cadastros e configurações
- Produtos: nome, categoria (Bebida, Sobremesa, Outros), código, preço, ativo/inativo,
  dados fiscais.
- Preço do quilo com histórico de alterações.
- Dados da empresa (CNPJ, IE, endereço), impressora e configurações fiscais.

## Interface
- Toda em português, letras grandes, alto contraste, rápida.
- Atalhos de teclado: F2 nova comanda, F4 peso do prato, F8 receber, Esc fechar janela.
- Confirmação antes de ações irreversíveis (cancelar nota, fechar caixa).

## Fases de entrega
1. Comandas, cadastros, pagamento, abertura/fechamento de caixa e impressão de
   conferência. Já substitui o papel no dia a dia.
2. NFC-e: homologação → produção, contingência offline, cancelamento.
3. Relatórios e exportação mensal para o contador.
4. (Opcional) Balança integrada via porta serial, e-mail automático, mais de um caixa.

Em cada fase: testes automatizados das regras de cálculo (peso × preço, troco,
divisão de conta, fechamento de caixa), dados de exemplo, e um README de instalação
no Windows em linguagem simples.

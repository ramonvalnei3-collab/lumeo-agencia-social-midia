'use strict';
/* Banco de dados do sistema (SQLite, arquivo único no computador do caixa).
   Dinheiro sempre em centavos (inteiros). Datas em milissegundos (Date.now()). */
const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const FORMAS = ['dinheiro', 'debito', 'credito', 'pix', 'vr', 'va'];
const PALETA = ['#2F6E8C', '#B8476A', '#6E7B33', '#7A4FA0', '#C08A1E', '#3D7F74', '#A0522D', '#5B6770'];
const DIA = 864e5;

const ESQUEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS usuarios (
  id INTEGER PRIMARY KEY,
  nome TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  senha_hash TEXT NOT NULL,
  perfil TEXT NOT NULL CHECK (perfil IN ('gerente', 'operador')),
  ativo INTEGER NOT NULL DEFAULT 1,
  criado_em INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessoes (
  token_hash TEXT PRIMARY KEY,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  criado_em INTEGER NOT NULL,
  expira_em INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS config (chave TEXT PRIMARY KEY, valor TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS historico_preco (
  id INTEGER PRIMARY KEY,
  preco_kg_cents INTEGER NOT NULL CHECK (preco_kg_cents > 0),
  em INTEGER NOT NULL,
  usuario_id INTEGER REFERENCES usuarios(id)
);
CREATE TABLE IF NOT EXISTS categorias (
  id TEXT PRIMARY KEY,
  nome TEXT NOT NULL,
  cor TEXT NOT NULL,
  ordem INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS produtos (
  id TEXT PRIMARY KEY,
  nome TEXT NOT NULL,
  categoria_id TEXT NOT NULL REFERENCES categorias(id),
  preco_cents INTEGER NOT NULL CHECK (preco_cents > 0),
  codigo TEXT NOT NULL DEFAULT '',
  ativo INTEGER NOT NULL DEFAULT 1,
  ncm TEXT NOT NULL DEFAULT '',
  cfop TEXT NOT NULL DEFAULT '',
  cest TEXT NOT NULL DEFAULT '',
  criado_em INTEGER NOT NULL,
  atualizado_em INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS produtos_codigo ON produtos(codigo) WHERE codigo <> '';
CREATE TABLE IF NOT EXISTS caixas (
  id INTEGER PRIMARY KEY,
  operador_id INTEGER REFERENCES usuarios(id),
  operador_nome TEXT NOT NULL,
  aberto_em INTEGER NOT NULL,
  fundo_cents INTEGER NOT NULL CHECK (fundo_cents >= 0),
  fechado_em INTEGER,
  fechado_por TEXT,
  total_vendas_cents INTEGER,
  comandas INTEGER,
  sangrias_cents INTEGER,
  suprimentos_cents INTEGER,
  esperado TEXT,
  contado TEXT,
  diferenca_cents INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS um_caixa_aberto ON caixas((1)) WHERE fechado_em IS NULL;
CREATE TABLE IF NOT EXISTS movimentos (
  id INTEGER PRIMARY KEY,
  caixa_id INTEGER NOT NULL REFERENCES caixas(id),
  tipo TEXT NOT NULL CHECK (tipo IN ('sangria', 'suprimento')),
  valor_cents INTEGER NOT NULL CHECK (valor_cents > 0),
  motivo TEXT NOT NULL,
  em INTEGER NOT NULL,
  usuario_id INTEGER REFERENCES usuarios(id)
);
CREATE TABLE IF NOT EXISTS comandas (
  id TEXT PRIMARY KEY,
  numero INTEGER NOT NULL CHECK (numero > 0),
  status TEXT NOT NULL CHECK (status IN ('aberta', 'fechada', 'cancelada')),
  aberta_em INTEGER NOT NULL,
  fechada_em INTEGER,
  cancelada_em INTEGER,
  troco_cents INTEGER NOT NULL DEFAULT 0,
  cpf TEXT NOT NULL DEFAULT '',
  caixa_id INTEGER REFERENCES caixas(id),
  aberta_por INTEGER REFERENCES usuarios(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS comanda_aberta_unica ON comandas(numero) WHERE status = 'aberta';
CREATE INDEX IF NOT EXISTS comandas_quando ON comandas(COALESCE(fechada_em, cancelada_em, aberta_em));
CREATE TABLE IF NOT EXISTS itens (
  id TEXT PRIMARY KEY,
  comanda_id TEXT NOT NULL REFERENCES comandas(id) ON DELETE CASCADE,
  tipo TEXT NOT NULL CHECK (tipo IN ('kg', 'un')),
  nome TEXT NOT NULL,
  produto_id TEXT,
  gramas INTEGER,
  qtd INTEGER NOT NULL CHECK (qtd > 0),
  unit_cents INTEGER NOT NULL,
  total_cents INTEGER NOT NULL,
  em INTEGER NOT NULL,
  usuario_id INTEGER REFERENCES usuarios(id)
);
CREATE INDEX IF NOT EXISTS itens_comanda ON itens(comanda_id);
CREATE TABLE IF NOT EXISTS pagamentos (
  id INTEGER PRIMARY KEY,
  comanda_id TEXT NOT NULL REFERENCES comandas(id) ON DELETE CASCADE,
  forma TEXT NOT NULL,
  valor_cents INTEGER NOT NULL CHECK (valor_cents > 0)
);
CREATE INDEX IF NOT EXISTS pagamentos_comanda ON pagamentos(comanda_id);
CREATE TABLE IF NOT EXISTS eventos (
  id INTEGER PRIMARY KEY,
  comanda_id TEXT REFERENCES comandas(id) ON DELETE CASCADE,
  em INTEGER NOT NULL,
  acao TEXT NOT NULL,
  detalhe TEXT NOT NULL DEFAULT '{}',
  usuario_nome TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS eventos_comanda ON eventos(comanda_id);
CREATE TABLE IF NOT EXISTS versao (id INTEGER PRIMARY KEY CHECK (id = 1), n INTEGER NOT NULL);
INSERT OR IGNORE INTO versao (id, n) VALUES (1, 1);
`;

/* Erro com mensagem para mostrar ao usuário e o código HTTP */
class ErroUso extends Error { constructor(msg, status = 400) { super(msg); this.status = status; } }

/* ---------- senhas: scrypt com sal, comparação em tempo constante ---------- */
function hashSenha(senha) {
  const sal = crypto.randomBytes(16);
  const h = crypto.scryptSync(senha, sal, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${sal.toString('base64')}$${h.toString('base64')}`;
}
function confereSenha(senha, guardado) {
  try {
    const [alg, N, r, p, sal, h] = String(guardado).split('$');
    if (alg !== 'scrypt') return false;
    const esperado = Buffer.from(h, 'base64');
    const calc = crypto.scryptSync(String(senha), Buffer.from(sal, 'base64'), esperado.length, { N: +N, r: +r, p: +p });
    return crypto.timingSafeEqual(calc, esperado);
  } catch { return false; }
}

const precoPrato = (gramas, precoKgCents) => Math.round(gramas * precoKgCents / 1000);
const novoId = () => crypto.randomUUID();
const inteiro = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
const texto = (v, max = 200) => String(v ?? '').trim().slice(0, max);

function abrirBanco(arquivo) {
  if (arquivo !== ':memory:') fs.mkdirSync(path.dirname(arquivo), { recursive: true });
  const db = new DatabaseSync(arquivo);
  db.exec(ESQUEMA);

  const um = (sql, ...a) => db.prepare(sql).get(...a);
  const todos = (sql, ...a) => db.prepare(sql).all(...a);
  const rodar = (sql, ...a) => db.prepare(sql).run(...a);
  const transacao = fn => (...a) => {
    db.exec('BEGIN IMMEDIATE');
    try { const r = fn(...a); rodar('UPDATE versao SET n = n + 1 WHERE id = 1'); db.exec('COMMIT'); return r; }
    catch (e) { db.exec('ROLLBACK'); throw e; }
  };

  /* ---------- configuração ---------- */
  const lerCfg = (chave, padrao) => { const r = um('SELECT valor FROM config WHERE chave = ?', chave); return r ? JSON.parse(r.valor) : padrao; };
  const gravarCfg = (chave, valor) => rodar('INSERT INTO config (chave, valor) VALUES (?, ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor', chave, JSON.stringify(valor));

  const EMPRESA_PADRAO = { empresa: 'Altos Sabores Restaurante', razao: 'Restaurante Altos Sabores Ltda', cnpj: '63.062.421/0001-67', ie: '', regime: 'Simples Nacional', telefone: '', endereco: '', bairro: '', cidade: '', uf: '', cep: '', rodape: 'Obrigado e volte sempre!' };
  const IMPRESSORA_PADRAO = { modelo: 'Elgin i9', conexao: 'usb', usb: 'USB001', ip: '192.168.0.50', porta: '9100', com: 'COM3', baud: '9600', papel: 80, corte: true, gaveta: true, autoImprimir: true, vias: 1, testadaEm: null };
  /* só dados públicos do certificado; o arquivo .pfx e a senha nunca entram no banco */
  const FISCAL_PADRAO = { checklist: { cert: true }, certificado: { titular: 'RESTAURANTE ALTOS SABORES LTDA', cnpj: '63.062.421/0001-67', tipo: 'A1 (e-CNPJ)', emissor: 'AC SyngularID Múltipla', validoDe: Date.UTC(2026, 9, 29, 17, 55), validoAte: Date.UTC(2027, 9, 29, 17, 55) } };

  /* primeira vez: categorias, preço do quilo e dados da empresa */
  if (!um('SELECT 1 AS x FROM categorias LIMIT 1')) {
    transacao(() => {
      [['Bebida', 'Bebidas'], ['Sobremesa', 'Sobremesas'], ['Outros', 'Outros']].forEach(([id, nome], k) => rodar('INSERT INTO categorias (id, nome, cor, ordem) VALUES (?, ?, ?, ?)', id, nome, PALETA[k], k));
      rodar('INSERT INTO historico_preco (preco_kg_cents, em) VALUES (?, ?)', 9500, Date.now());
      gravarCfg('empresa', EMPRESA_PADRAO); gravarCfg('impressora', IMPRESSORA_PADRAO); gravarCfg('fiscal', FISCAL_PADRAO);
    })();
  }
  const precoKg = () => um('SELECT preco_kg_cents AS v FROM historico_preco ORDER BY em DESC, id DESC LIMIT 1').v;
  const versao = () => um('SELECT n FROM versao WHERE id = 1').n;
  const caixaAberto = () => um('SELECT * FROM caixas WHERE fechado_em IS NULL');

  /* ---------- usuários e sessões ---------- */
  const usuarioPub = u => u && ({ id: u.id, nome: u.nome, email: u.email, perfil: u.perfil, ativo: !!u.ativo });
  const temUsuarios = () => !!um('SELECT 1 AS x FROM usuarios LIMIT 1');
  function validarUsuario({ nome, email, senha, perfil }, exigirSenha = true) {
    nome = texto(nome, 80); email = texto(email, 120).toLowerCase();
    if (nome.length < 2) throw new ErroUso('Digite o nome.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ErroUso('Digite um e-mail válido.');
    if (exigirSenha || senha) validarSenha(senha);
    if (perfil !== undefined && !['gerente', 'operador'].includes(perfil)) throw new ErroUso('Perfil inválido.');
    return { nome, email };
  }
  function validarSenha(senha) {
    if (typeof senha !== 'string' || senha.length < 8) throw new ErroUso('A senha precisa ter pelo menos 8 caracteres.');
    if (senha.length > 200) throw new ErroUso('Senha longa demais.');
  }
  const criarPrimeiroGerente = transacao(dados => {
    if (temUsuarios()) throw new ErroUso('O primeiro acesso já foi criado. Entre com e-mail e senha.', 409);
    const { nome, email } = validarUsuario(dados);
    const r = rodar('INSERT INTO usuarios (nome, email, senha_hash, perfil, criado_em) VALUES (?, ?, ?, ?, ?)', nome, email, hashSenha(dados.senha), 'gerente', Date.now());
    return Number(r.lastInsertRowid);
  });
  const criarUsuario = transacao(dados => {
    const { nome, email } = validarUsuario(dados);
    if (um('SELECT 1 AS x FROM usuarios WHERE email = ?', email)) throw new ErroUso('Já existe um usuário com esse e-mail.', 409);
    const r = rodar('INSERT INTO usuarios (nome, email, senha_hash, perfil, criado_em) VALUES (?, ?, ?, ?, ?)', nome, email, hashSenha(dados.senha), dados.perfil || 'operador', Date.now());
    return Number(r.lastInsertRowid);
  });
  const alterarUsuario = transacao((id, dados, quem) => {
    const u = um('SELECT * FROM usuarios WHERE id = ?', id);
    if (!u) throw new ErroUso('Usuário não encontrado.', 404);
    const perfil = dados.perfil ?? u.perfil, ativo = dados.ativo === undefined ? !!u.ativo : !!dados.ativo;
    if (!['gerente', 'operador'].includes(perfil)) throw new ErroUso('Perfil inválido.');
    if (id === quem.id && (!ativo || perfil !== 'gerente')) throw new ErroUso('Você não pode desativar nem tirar o perfil de gerente da sua própria conta.');
    if (u.perfil === 'gerente' && (perfil !== 'gerente' || !ativo) && um("SELECT COUNT(*) AS n FROM usuarios WHERE perfil = 'gerente' AND ativo = 1").n <= 1) throw new ErroUso('É preciso ter pelo menos um gerente ativo.');
    let nome = u.nome; if (dados.nome !== undefined) { nome = texto(dados.nome, 80); if (nome.length < 2) throw new ErroUso('Digite o nome.'); }
    rodar('UPDATE usuarios SET nome = ?, perfil = ?, ativo = ? WHERE id = ?', nome, perfil, ativo ? 1 : 0, id);
    if (dados.senha) { validarSenha(dados.senha); rodar('UPDATE usuarios SET senha_hash = ? WHERE id = ?', hashSenha(dados.senha), id); }
    if (!ativo || dados.senha) rodar('DELETE FROM sessoes WHERE usuario_id = ?', id);
  });
  function trocarSenha(id, atual, nova) {
    const u = um('SELECT * FROM usuarios WHERE id = ?', id);
    if (!u || !confereSenha(atual, u.senha_hash)) throw new ErroUso('A senha atual não confere.', 403);
    validarSenha(nova);
    rodar('UPDATE usuarios SET senha_hash = ? WHERE id = ?', hashSenha(nova), id);
  }
  function login(email, senha) {
    const u = um('SELECT * FROM usuarios WHERE email = ? AND ativo = 1', texto(email, 120).toLowerCase());
    /* mesmo custo de cálculo quando o e-mail não existe */
    const ok = confereSenha(senha, u ? u.senha_hash : 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$' + 'A'.repeat(86) + '==');
    return u && ok ? u : null;
  }
  const hashToken = t => crypto.createHash('sha256').update(t).digest('hex');
  function criarSessao(usuarioId, horas = 12) {
    const token = crypto.randomBytes(32).toString('base64url');
    rodar('DELETE FROM sessoes WHERE expira_em < ?', Date.now());
    rodar('INSERT INTO sessoes (token_hash, usuario_id, criado_em, expira_em) VALUES (?, ?, ?, ?)', hashToken(token), usuarioId, Date.now(), Date.now() + horas * 36e5);
    return token;
  }
  function usuarioDaSessao(token) {
    if (!token) return null;
    return um('SELECT u.* FROM sessoes s JOIN usuarios u ON u.id = s.usuario_id WHERE s.token_hash = ? AND s.expira_em > ? AND u.ativo = 1', hashToken(token), Date.now()) || null;
  }
  const encerrarSessao = token => token && rodar('DELETE FROM sessoes WHERE token_hash = ?', hashToken(token));
  /* autorização de gerente: o próprio usuário é gerente, ou digitou a senha de um gerente ativo */
  function autorizarGerente(quem, senhaGerente) {
    if (quem.perfil === 'gerente') return quem.nome;
    const g = todos("SELECT * FROM usuarios WHERE perfil = 'gerente' AND ativo = 1").find(x => confereSenha(senhaGerente || '', x.senha_hash));
    if (!g) throw new ErroUso('Senha do gerente não confere.', 403);
    return g.nome;
  }

  /* ---------- comandas ---------- */
  const evento = (comandaId, acao, detalhe, quem) => rodar('INSERT INTO eventos (comanda_id, em, acao, detalhe, usuario_nome) VALUES (?, ?, ?, ?, ?)', comandaId, Date.now(), acao, JSON.stringify(detalhe || {}), quem ? quem.nome : '');
  function comandaAberta(id) {
    const c = um('SELECT * FROM comandas WHERE id = ?', id);
    if (!c) throw new ErroUso('Comanda não encontrada.', 404);
    if (c.status !== 'aberta') throw new ErroUso(`A comanda ${c.numero} não está aberta.`, 409);
    return c;
  }
  const totalDe = id => um('SELECT COALESCE(SUM(total_cents), 0) AS t FROM itens WHERE comanda_id = ?', id).t;
  function abrirComandaSemTx(numero, quem) {
    if (!inteiro(numero, 1, 99999)) throw new ErroUso('Número de comanda inválido.');
    const ex = um("SELECT id FROM comandas WHERE numero = ? AND status = 'aberta'", numero);
    if (ex) return { id: ex.id, nova: false };
    const id = novoId();
    rodar("INSERT INTO comandas (id, numero, status, aberta_em, aberta_por) VALUES (?, ?, 'aberta', ?, ?)", id, numero, Date.now(), quem.id);
    return { id, nova: true };
  }
  function lancarPratoSemTx(comandaId, gramas, quem) {
    comandaAberta(comandaId);
    if (!inteiro(gramas, 1, 5000)) throw new ErroUso('Peso inválido. Digite em gramas, de 1 a 5000.');
    const kg = precoKg(), id = novoId();
    rodar("INSERT INTO itens (id, comanda_id, tipo, nome, gramas, qtd, unit_cents, total_cents, em, usuario_id) VALUES (?, ?, 'kg', 'Refeição por quilo', ?, 1, ?, ?, ?, ?)", id, comandaId, gramas, kg, precoPrato(gramas, kg), Date.now(), quem.id);
    return id;
  }
  const abrirComanda = transacao((numero, quem) => abrirComandaSemTx(numero, quem));
  const pesarNaBalanca = transacao((numero, gramas, quem) => {
    if (!inteiro(gramas, 1, 5000)) throw new ErroUso('Peso inválido. Digite em gramas, de 1 a 5000.');
    const { id, nova } = abrirComandaSemTx(numero, quem);
    return { comandaId: id, nova, itemId: lancarPratoSemTx(id, gramas, quem) };
  });
  const adicionarItem = transacao((comandaId, dados, quem) => {
    if (dados.tipo === 'kg') return lancarPratoSemTx(comandaId, dados.gramas, quem);
    comandaAberta(comandaId);
    const p = um('SELECT * FROM produtos WHERE id = ? AND ativo = 1', String(dados.produtoId || ''));
    if (!p) throw new ErroUso('Produto não encontrado ou fora da comanda.', 404);
    const ex = um("SELECT * FROM itens WHERE comanda_id = ? AND tipo = 'un' AND produto_id = ? AND unit_cents = ?", comandaId, p.id, p.preco_cents);
    if (ex) { rodar('UPDATE itens SET qtd = qtd + 1, total_cents = (qtd + 1) * unit_cents WHERE id = ?', ex.id); return ex.id; }
    const id = novoId();
    rodar("INSERT INTO itens (id, comanda_id, tipo, nome, produto_id, qtd, unit_cents, total_cents, em, usuario_id) VALUES (?, ?, 'un', ?, ?, 1, ?, ?, ?, ?)", id, comandaId, p.nome, p.id, p.preco_cents, p.preco_cents, Date.now(), quem.id);
    return id;
  });
  const mudarQtd = transacao((itemId, qtd) => {
    const i = um('SELECT * FROM itens WHERE id = ?', itemId);
    if (!i) throw new ErroUso('Item não encontrado.', 404);
    comandaAberta(i.comanda_id);
    if (i.tipo !== 'un') throw new ErroUso('O peso do prato não muda; tire o prato e pese de novo.');
    if (!inteiro(qtd, 1, 999)) throw new ErroUso('Quantidade inválida.');
    rodar('UPDATE itens SET qtd = ?, total_cents = ? * unit_cents WHERE id = ?', qtd, qtd, itemId);
  });
  const removerItem = transacao((itemId, acao, quem) => {
    const i = um('SELECT * FROM itens WHERE id = ?', itemId);
    if (!i) throw new ErroUso('Item não encontrado.', 404);
    comandaAberta(i.comanda_id);
    rodar('DELETE FROM itens WHERE id = ?', itemId);
    evento(i.comanda_id, acao === 'pesagem desfeita' ? 'pesagem desfeita' : 'item removido', { item: i.tipo === 'kg' ? `Prato ${(i.gramas / 1000).toFixed(3).replace('.', ',')} kg` : i.nome, valorCents: i.total_cents }, quem);
  });
  const descartarVazia = transacao(comandaId => {
    const c = comandaAberta(comandaId);
    if (totalDe(c.id) || um('SELECT 1 AS x FROM itens WHERE comanda_id = ?', c.id)) throw new ErroUso('A comanda tem itens. Use “Cancelar comanda”.', 409);
    rodar('DELETE FROM comandas WHERE id = ?', c.id);
  });
  const cancelarComanda = transacao((comandaId, motivo, senhaGerente, quem) => {
    const c = comandaAberta(comandaId);
    motivo = texto(motivo, 300); if (motivo.length < 5) throw new ErroUso('Escreva o motivo (pelo menos 5 letras).');
    const autorizou = autorizarGerente(quem, senhaGerente);
    rodar("UPDATE comandas SET status = 'cancelada', cancelada_em = ? WHERE id = ?", Date.now(), c.id);
    evento(c.id, 'cancelada', { motivo, autorizadoPor: autorizou }, quem);
  });
  const reabrirComanda = transacao((comandaId, motivo, senhaGerente, quem) => {
    const c = um('SELECT * FROM comandas WHERE id = ?', comandaId);
    if (!c) throw new ErroUso('Comanda não encontrada.', 404);
    if (c.status === 'aberta') throw new ErroUso('A comanda já está aberta.', 409);
    if (um("SELECT 1 AS x FROM comandas WHERE numero = ? AND status = 'aberta'", c.numero)) throw new ErroUso(`Já existe uma comanda ${c.numero} aberta. Feche ela antes.`, 409);
    motivo = texto(motivo, 300); if (motivo.length < 5) throw new ErroUso('Escreva o motivo (pelo menos 5 letras).');
    const autorizou = autorizarGerente(quem, senhaGerente);
    const antes = todos('SELECT forma, valor_cents AS valorCents FROM pagamentos WHERE comanda_id = ?', c.id);
    rodar('DELETE FROM pagamentos WHERE comanda_id = ?', c.id);
    rodar("UPDATE comandas SET status = 'aberta', fechada_em = NULL, cancelada_em = NULL, troco_cents = 0, caixa_id = NULL WHERE id = ?", c.id);
    evento(c.id, 'reaberta', { motivo, autorizadoPor: autorizou, pagamentosAnteriores: antes }, quem);
  });
  const pagarComanda = transacao((comandaId, pagamentos, cpf, quem) => {
    const cx = caixaAberto();
    if (!cx) throw new ErroUso('Abra o caixa antes de receber.', 409);
    const c = comandaAberta(comandaId);
    const total = totalDe(c.id);
    if (!total) throw new ErroUso('A comanda está vazia.');
    if (!Array.isArray(pagamentos) || !pagamentos.length || pagamentos.length > 10) throw new ErroUso('Informe o pagamento.');
    let soma = 0, dinheiro = 0;
    for (const p of pagamentos) {
      if (!FORMAS.includes(p.forma) || !inteiro(p.valorCents, 1, 10_000_000)) throw new ErroUso('Pagamento inválido.');
      soma += p.valorCents; if (p.forma === 'dinheiro') dinheiro += p.valorCents;
    }
    if (soma < total) throw new ErroUso(`Falta receber ${((total - soma) / 100).toFixed(2).replace('.', ',')}.`);
    const troco = soma - total;
    if (troco > dinheiro) throw new ErroUso('Troco só em dinheiro: cartão, Pix e vale não podem passar do total.');
    const doc = String(cpf || '').replace(/\D/g, '');
    if (doc && doc.length !== 11 && doc.length !== 14) throw new ErroUso('CPF ou CNPJ incompleto.');
    pagamentos.forEach(p => rodar('INSERT INTO pagamentos (comanda_id, forma, valor_cents) VALUES (?, ?, ?)', c.id, p.forma, p.valorCents));
    rodar("UPDATE comandas SET status = 'fechada', fechada_em = ?, troco_cents = ?, cpf = ?, caixa_id = ? WHERE id = ?", Date.now(), troco, texto(cpf, 20), cx.id, c.id);
    return troco;
  });

  /* ---------- caixa ---------- */
  function resumoCaixa(cx) {
    const porForma = Object.fromEntries(FORMAS.map(f => [f, 0]));
    todos("SELECT p.forma, SUM(p.valor_cents) AS v FROM pagamentos p JOIN comandas c ON c.id = p.comanda_id WHERE c.caixa_id = ? AND c.status = 'fechada' GROUP BY p.forma", cx.id).forEach(r => porForma[r.forma] = r.v);
    const v = um("SELECT COUNT(*) AS n, COALESCE(SUM(troco_cents), 0) AS troco FROM comandas WHERE caixa_id = ? AND status = 'fechada'", cx.id);
    const totalVendas = um("SELECT COALESCE(SUM(i.total_cents), 0) AS t FROM itens i JOIN comandas c ON c.id = i.comanda_id WHERE c.caixa_id = ? AND c.status = 'fechada'", cx.id).t;
    porForma.dinheiro -= v.troco;
    const soma = tipo => um('SELECT COALESCE(SUM(valor_cents), 0) AS s FROM movimentos WHERE caixa_id = ? AND tipo = ?', cx.id, tipo).s;
    const sup = soma('suprimento'), san = soma('sangria');
    return { porForma, comandas: v.n, totalVendas, sup, san, esperado: { ...porForma, dinheiro: cx.fundo_cents + porForma.dinheiro + sup - san } };
  }
  const abrirCaixa = transacao((fundoCents, quem) => {
    if (caixaAberto()) throw new ErroUso('O caixa já está aberto.', 409);
    if (!inteiro(fundoCents, 0, 10_000_000)) throw new ErroUso('Digite o fundo de troco, ex.: 200,00');
    rodar('INSERT INTO caixas (operador_id, operador_nome, aberto_em, fundo_cents) VALUES (?, ?, ?, ?)', quem.id, quem.nome, Date.now(), fundoCents);
  });
  const movimentarCaixa = transacao((tipo, valorCents, motivo, quem) => {
    const cx = caixaAberto(); if (!cx) throw new ErroUso('O caixa está fechado.', 409);
    if (!['sangria', 'suprimento'].includes(tipo)) throw new ErroUso('Tipo inválido.');
    if (!inteiro(valorCents, 1, 10_000_000)) throw new ErroUso('Digite o valor, ex.: 300,00');
    motivo = texto(motivo, 200); if (!motivo) throw new ErroUso('Escreva o motivo.');
    if (tipo === 'sangria' && valorCents > resumoCaixa(cx).esperado.dinheiro) throw new ErroUso('A sangria é maior que o dinheiro que deveria estar na gaveta.');
    return Number(rodar('INSERT INTO movimentos (caixa_id, tipo, valor_cents, motivo, em, usuario_id) VALUES (?, ?, ?, ?, ?, ?)', cx.id, tipo, valorCents, motivo, Date.now(), quem.id).lastInsertRowid);
  });
  const fecharCaixa = transacao((contado, quem) => {
    const cx = caixaAberto(); if (!cx) throw new ErroUso('O caixa já está fechado.', 409);
    const R = resumoCaixa(cx);
    const ct = {};
    for (const f of FORMAS) { const v = contado && contado[f]; ct[f] = inteiro(v, 0, 100_000_000) ? v : 0; }
    const linhas = FORMAS.filter(f => R.esperado[f] || f === 'dinheiro');
    const diferenca = linhas.reduce((s, f) => s + ct[f] - R.esperado[f], 0);
    rodar('UPDATE caixas SET fechado_em = ?, fechado_por = ?, total_vendas_cents = ?, comandas = ?, sangrias_cents = ?, suprimentos_cents = ?, esperado = ?, contado = ?, diferenca_cents = ? WHERE id = ?',
      Date.now(), quem.nome, R.totalVendas, R.comandas, R.san, R.sup, JSON.stringify(R.esperado), JSON.stringify(ct), diferenca, cx.id);
    return fechamentoPub(um('SELECT * FROM caixas WHERE id = ?', cx.id));
  });
  const fechamentoPub = f => ({ id: f.id, operador: f.operador_nome, abertoEm: f.aberto_em, fechadoEm: f.fechado_em, fechadoPor: f.fechado_por, fundoCents: f.fundo_cents, sangriasCents: f.sangrias_cents, suprimentosCents: f.suprimentos_cents, totalVendasCents: f.total_vendas_cents, comandas: f.comandas, esperado: JSON.parse(f.esperado || '{}'), contado: JSON.parse(f.contado || '{}'), diferencaCents: f.diferenca_cents });

  /* ---------- produtos e categorias ---------- */
  function validarProduto(d, idAtual) {
    const nome = texto(d.nome, 80), codigo = texto(d.codigo, 20);
    if (!nome) throw new ErroUso('Digite o nome do produto.');
    if (!inteiro(d.precoCents, 1, 10_000_000)) throw new ErroUso('Digite o preço, ex.: 6,00');
    if (!um('SELECT 1 AS x FROM categorias WHERE id = ?', String(d.cat || ''))) throw new ErroUso('Escolha uma categoria.');
    if (codigo && um('SELECT 1 AS x FROM produtos WHERE codigo = ? AND id <> ?', codigo, idAtual || '')) throw new ErroUso(`O código ${codigo} já é de outro produto.`, 409);
    const f = d.fiscal || {};
    return [nome, String(d.cat), d.precoCents, codigo, d.ativo === false ? 0 : 1, texto(f.ncm, 12), texto(f.cfop, 6), texto(f.cest, 12)];
  }
  const criarProduto = transacao(d => { const id = novoId(), v = validarProduto(d); rodar('INSERT INTO produtos (id, nome, categoria_id, preco_cents, codigo, ativo, ncm, cfop, cest, criado_em, atualizado_em) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', id, ...v, Date.now(), Date.now()); return id; });
  const editarProduto = transacao((id, d) => {
    const p = um('SELECT * FROM produtos WHERE id = ?', id); if (!p) throw new ErroUso('Produto não encontrado.', 404);
    const atual = { nome: p.nome, cat: p.categoria_id, precoCents: p.preco_cents, codigo: p.codigo, ativo: !!p.ativo, fiscal: { ncm: p.ncm, cfop: p.cfop, cest: p.cest } };
    const v = validarProduto({ ...atual, ...d, fiscal: { ...atual.fiscal, ...(d.fiscal || {}) } }, id);
    rodar('UPDATE produtos SET nome = ?, categoria_id = ?, preco_cents = ?, codigo = ?, ativo = ?, ncm = ?, cfop = ?, cest = ? , atualizado_em = ? WHERE id = ?', ...v, Date.now(), id);
  });
  const excluirProduto = transacao(id => { if (!rodar('DELETE FROM produtos WHERE id = ?', id).changes) throw new ErroUso('Produto não encontrado.', 404); });
  const carregarExemplos = transacao(() => {
    if (um('SELECT 1 AS x FROM produtos LIMIT 1')) throw new ErroUso('Já existem produtos cadastrados.', 409);
    const lista = [['Bebida', [['Refrigerante lata 350ml', 600], ['Refrigerante 600ml', 800], ['Refrigerante 2L', 1400], ['Água mineral 500ml', 400], ['Água com gás 500ml', 450], ['Suco natural 400ml', 900], ['Suco de laranja 400ml', 900], ['Água de coco 300ml', 700], ['Cerveja long neck', 1000], ['Cerveja lata 350ml', 700]]],
      ['Sobremesa', [['Pudim', 800], ['Mousse de maracujá', 700], ['Sorvete (bola)', 600], ['Salada de frutas', 750], ['Brigadeiro', 300], ['Doce de leite', 500]]],
      ['Outros', [['Café', 300], ['Embalagem marmitex', 200]]]];
    const cats = todos('SELECT id FROM categorias').map(c => c.id);
    lista.forEach(([cat, ps], k) => { if (!cats.includes(cat)) return; ps.forEach(([nome, preco], j) => rodar('INSERT INTO produtos (id, nome, categoria_id, preco_cents, codigo, ativo, criado_em, atualizado_em) VALUES (?, ?, ?, ?, ?, 1, ?, ?)', novoId(), nome, cat, preco, String((k + 1) * 100 + j + 1), Date.now(), Date.now())); });
  });
  function validarCategoria(d, idAtual) {
    const nome = texto(d.nome, 40); if (!nome) throw new ErroUso('Digite o nome da categoria.');
    if (todos('SELECT id, nome FROM categorias').some(c => c.id !== idAtual && c.nome.toLowerCase() === nome.toLowerCase())) throw new ErroUso('Já existe uma categoria com esse nome.', 409);
    const cor = /^#[0-9a-fA-F]{6}$/.test(d.cor || '') ? d.cor : PALETA[0];
    return { nome, cor };
  }
  const criarCategoria = transacao(d => { const { nome, cor } = validarCategoria(d); const id = novoId(); rodar('INSERT INTO categorias (id, nome, cor, ordem) VALUES (?, ?, ?, (SELECT COALESCE(MAX(ordem), 0) + 1 FROM categorias))', id, nome, cor); return id; });
  const editarCategoria = transacao((id, d) => { const { nome, cor } = validarCategoria(d, id); if (!rodar('UPDATE categorias SET nome = ?, cor = ? WHERE id = ?', nome, cor, id).changes) throw new ErroUso('Categoria não encontrada.', 404); });
  const excluirCategoria = transacao(id => {
    const n = um('SELECT COUNT(*) AS n FROM produtos WHERE categoria_id = ?', id).n;
    if (n) throw new ErroUso(`Mova ou exclua os ${n} produtos desta categoria antes de excluí-la.`, 409);
    if (um('SELECT COUNT(*) AS n FROM categorias').n <= 1) throw new ErroUso('É preciso ter pelo menos uma categoria.', 409);
    if (!rodar('DELETE FROM categorias WHERE id = ?', id).changes) throw new ErroUso('Categoria não encontrada.', 404);
  });

  /* ---------- configurações ---------- */
  const mudarPrecoKg = transacao((v, quem) => {
    if (!inteiro(v, 1, 1_000_000)) throw new ErroUso('Digite um preço válido, ex.: 95,00');
    if (v === precoKg()) throw new ErroUso('O preço já é esse.');
    rodar('INSERT INTO historico_preco (preco_kg_cents, em, usuario_id) VALUES (?, ?, ?)', v, Date.now(), quem.id);
  });
  const salvarEmpresa = transacao(d => {
    const atual = lerCfg('empresa', EMPRESA_PADRAO), novo = { ...atual };
    Object.keys(EMPRESA_PADRAO).forEach(k => { if (d[k] !== undefined) novo[k] = texto(d[k], 160); });
    if (!novo.empresa) throw new ErroUso('O nome fantasia não pode ficar vazio.');
    novo.uf = novo.uf.toUpperCase().slice(0, 2);
    gravarCfg('empresa', novo);
  });
  const salvarImpressora = transacao(d => {
    const atual = lerCfg('impressora', IMPRESSORA_PADRAO), novo = { ...atual };
    ['modelo', 'usb', 'ip', 'porta', 'com', 'baud'].forEach(k => { if (d[k] !== undefined) novo[k] = texto(d[k], 80); });
    if (d.conexao !== undefined) { if (!['usb', 'rede', 'serial'].includes(d.conexao)) throw new ErroUso('Conexão inválida.'); novo.conexao = d.conexao; }
    if (d.papel !== undefined) { if (![58, 80].includes(+d.papel)) throw new ErroUso('Papel inválido.'); novo.papel = +d.papel; }
    if (d.vias !== undefined) novo.vias = [1, 2].includes(+d.vias) ? +d.vias : 1;
    ['corte', 'gaveta', 'autoImprimir'].forEach(k => { if (d[k] !== undefined) novo[k] = !!d[k]; });
    if (d.testadaEm) novo.testadaEm = Date.now();
    gravarCfg('impressora', novo);
  });
  const salvarChecklist = transacao(checklist => {
    const f = lerCfg('fiscal', FISCAL_PADRAO);
    const ok = ['cert', 'ie', 'cred', 'csc', 'tab', 'api'];
    f.checklist = Object.fromEntries(ok.map(k => [k, !!(checklist && checklist[k])]));
    gravarCfg('fiscal', f);
  });

  /* ---------- foto completa para a tela ---------- */
  function estado(quem) {
    const desde = Date.now() - 90 * DIA;
    const cmds = todos("SELECT * FROM comandas WHERE status = 'aberta' OR COALESCE(fechada_em, cancelada_em, aberta_em) >= ? ORDER BY aberta_em", desde);
    const ids = cmds.map(c => c.id);
    const porComanda = (sql) => { const m = new Map(); if (!ids.length) return m; todos(sql.replace('?LISTA', ids.map(() => '?').join(',')), ...ids).forEach(r => { if (!m.has(r.comanda_id)) m.set(r.comanda_id, []); m.get(r.comanda_id).push(r); }); return m; };
    const itens = porComanda('SELECT * FROM itens WHERE comanda_id IN (?LISTA) ORDER BY em, rowid');
    const pags = porComanda('SELECT * FROM pagamentos WHERE comanda_id IN (?LISTA) ORDER BY id');
    const evs = porComanda('SELECT * FROM eventos WHERE comanda_id IN (?LISTA) ORDER BY em');
    const cx = caixaAberto();
    const empresa = lerCfg('empresa', EMPRESA_PADRAO);
    return {
      versao: versao(),
      usuario: usuarioPub(quem),
      config: { ...empresa, precoKgCents: precoKg(), historicoPreco: todos('SELECT preco_kg_cents AS precoKgCents, em FROM historico_preco ORDER BY em, id') },
      categorias: todos('SELECT id, nome, cor FROM categorias ORDER BY ordem, nome'),
      produtos: todos('SELECT * FROM produtos ORDER BY nome').map(p => ({ id: p.id, nome: p.nome, cat: p.categoria_id, precoCents: p.preco_cents, codigo: p.codigo, ativo: !!p.ativo, fiscal: { ncm: p.ncm, cfop: p.cfop, cest: p.cest } })),
      comandas: cmds.map(c => ({
        id: c.id, numero: c.numero, status: c.status, abertaEm: c.aberta_em, fechadaEm: c.fechada_em || undefined, canceladaEm: c.cancelada_em || undefined,
        trocoCents: c.troco_cents, cpf: c.cpf,
        itens: (itens.get(c.id) || []).map(i => ({ id: i.id, tipo: i.tipo, nome: i.nome, produtoId: i.produto_id || undefined, gramas: i.gramas ?? undefined, qtd: i.qtd, unitCents: i.unit_cents, totalCents: i.total_cents, em: i.em })),
        pagamentos: (pags.get(c.id) || []).map(p => ({ forma: p.forma, valorCents: p.valor_cents })),
        log: (evs.get(c.id) || []).map(e => ({ em: e.em, acao: e.acao, usuario: e.usuario_nome, ...JSON.parse(e.detalhe) })),
      })),
      caixa: cx ? { aberto: true, id: cx.id, operador: cx.operador_nome, abertoEm: cx.aberto_em, fundoCents: cx.fundo_cents, movimentos: todos('SELECT id, tipo, valor_cents AS valorCents, motivo, em FROM movimentos WHERE caixa_id = ? ORDER BY em', cx.id) }
        : { aberto: false, operador: quem ? quem.nome : '', movimentos: [] },
      fechamentos: todos('SELECT * FROM caixas WHERE fechado_em IS NOT NULL ORDER BY fechado_em DESC LIMIT 60').map(fechamentoPub),
      impressora: lerCfg('impressora', IMPRESSORA_PADRAO),
      fiscal: lerCfg('fiscal', FISCAL_PADRAO),
    };
  }

  return {
    db, versao, estado, temUsuarios, criarPrimeiroGerente, criarUsuario, alterarUsuario, trocarSenha, login, criarSessao, usuarioDaSessao, encerrarSessao,
    listarUsuarios: () => todos('SELECT * FROM usuarios ORDER BY nome').map(usuarioPub),
    abrirComanda, pesarNaBalanca, adicionarItem, mudarQtd, removerItem, descartarVazia, cancelarComanda, reabrirComanda, pagarComanda,
    abrirCaixa, movimentarCaixa, fecharCaixa,
    criarProduto, editarProduto, excluirProduto, carregarExemplos, criarCategoria, editarCategoria, excluirCategoria,
    mudarPrecoKg, salvarEmpresa, salvarImpressora, salvarChecklist,
    backup: destino => db.exec(`VACUUM INTO '${destino.replace(/'/g, "''")}'`),
    fechar: () => db.close(),
  };
}

module.exports = { abrirBanco, ErroUso, hashSenha, confereSenha, precoPrato, FORMAS };

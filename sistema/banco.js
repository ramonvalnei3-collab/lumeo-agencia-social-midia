'use strict';
/* Banco de dados e regras do sistema.
   Funciona com SQLite (computador do caixa) ou Postgres (nuvem/Vercel) — veja adaptadores.js.
   Dinheiro sempre em centavos (inteiros). Datas em milissegundos (Date.now()). */
const crypto = require('node:crypto');
const { adaptadorSqlite, adaptadorPostgres } = require('./adaptadores');

const FORMAS = ['dinheiro', 'debito', 'credito', 'pix', 'vr', 'va'];
const PALETA = ['#2F6E8C', '#B8476A', '#6E7B33', '#7A4FA0', '#C08A1E', '#3D7F74', '#A0522D', '#5B6770'];
const DIA = 864e5;

const esquema = ({ id, big }) => `
CREATE TABLE IF NOT EXISTS usuarios (
  id ${id},
  nome TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  senha_hash TEXT NOT NULL,
  perfil TEXT NOT NULL CHECK (perfil IN ('gerente', 'operador')),
  ativo INTEGER NOT NULL DEFAULT 1,
  criado_em ${big} NOT NULL
);
CREATE TABLE IF NOT EXISTS sessoes (
  token_hash TEXT PRIMARY KEY,
  usuario_id ${big} NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  criado_em ${big} NOT NULL,
  expira_em ${big} NOT NULL
);
CREATE TABLE IF NOT EXISTS tentativas_login (chave TEXT PRIMARY KEY, n INTEGER NOT NULL, desde ${big} NOT NULL);
CREATE TABLE IF NOT EXISTS config (chave TEXT PRIMARY KEY, valor TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS historico_preco (
  id ${id},
  preco_kg_cents INTEGER NOT NULL CHECK (preco_kg_cents > 0),
  em ${big} NOT NULL,
  usuario_id ${big} REFERENCES usuarios(id)
);
CREATE TABLE IF NOT EXISTS categorias (id TEXT PRIMARY KEY, nome TEXT NOT NULL, cor TEXT NOT NULL, ordem INTEGER NOT NULL DEFAULT 0);
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
  criado_em ${big} NOT NULL,
  atualizado_em ${big} NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS produtos_codigo ON produtos(codigo) WHERE codigo <> '';
CREATE TABLE IF NOT EXISTS caixas (
  id ${id},
  unico INTEGER NOT NULL DEFAULT 1,
  operador_id ${big} REFERENCES usuarios(id),
  operador_nome TEXT NOT NULL,
  aberto_em ${big} NOT NULL,
  fundo_cents INTEGER NOT NULL CHECK (fundo_cents >= 0),
  fechado_em ${big},
  fechado_por TEXT,
  total_vendas_cents INTEGER,
  comandas INTEGER,
  sangrias_cents INTEGER,
  suprimentos_cents INTEGER,
  esperado TEXT,
  contado TEXT,
  diferenca_cents INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS um_caixa_aberto ON caixas(unico) WHERE fechado_em IS NULL;
CREATE TABLE IF NOT EXISTS movimentos (
  id ${id},
  caixa_id ${big} NOT NULL REFERENCES caixas(id),
  tipo TEXT NOT NULL CHECK (tipo IN ('sangria', 'suprimento')),
  valor_cents INTEGER NOT NULL CHECK (valor_cents > 0),
  motivo TEXT NOT NULL,
  em ${big} NOT NULL,
  usuario_id ${big} REFERENCES usuarios(id)
);
CREATE TABLE IF NOT EXISTS comandas (
  id TEXT PRIMARY KEY,
  numero INTEGER NOT NULL CHECK (numero > 0),
  status TEXT NOT NULL CHECK (status IN ('aberta', 'fechada', 'cancelada')),
  aberta_em ${big} NOT NULL,
  fechada_em ${big},
  cancelada_em ${big},
  troco_cents INTEGER NOT NULL DEFAULT 0,
  cpf TEXT NOT NULL DEFAULT '',
  caixa_id ${big} REFERENCES caixas(id),
  aberta_por ${big} REFERENCES usuarios(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS comanda_aberta_unica ON comandas(numero) WHERE status = 'aberta';
CREATE INDEX IF NOT EXISTS comandas_quando ON comandas((COALESCE(fechada_em, cancelada_em, aberta_em)));
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
  em ${big} NOT NULL,
  usuario_id ${big} REFERENCES usuarios(id)
);
CREATE INDEX IF NOT EXISTS itens_comanda ON itens(comanda_id);
CREATE TABLE IF NOT EXISTS pagamentos (
  id ${id},
  comanda_id TEXT NOT NULL REFERENCES comandas(id) ON DELETE CASCADE,
  forma TEXT NOT NULL,
  valor_cents INTEGER NOT NULL CHECK (valor_cents > 0)
);
CREATE INDEX IF NOT EXISTS pagamentos_comanda ON pagamentos(comanda_id);
CREATE TABLE IF NOT EXISTS eventos (
  id ${id},
  comanda_id TEXT REFERENCES comandas(id) ON DELETE CASCADE,
  em ${big} NOT NULL,
  acao TEXT NOT NULL,
  detalhe TEXT NOT NULL DEFAULT '{}',
  usuario_nome TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS eventos_comanda ON eventos(comanda_id);
CREATE TABLE IF NOT EXISTS versao (id INTEGER PRIMARY KEY CHECK (id = 1), n ${big} NOT NULL);
INSERT INTO versao (id, n) VALUES (1, 1) ON CONFLICT (id) DO NOTHING;
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
const HASH_FALSO = 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$' + 'A'.repeat(86) + '==';

const precoPrato = (gramas, precoKgCents) => Math.round(gramas * precoKgCents / 1000);
/* CPF: 11 números, não todos iguais, com os dois dígitos verificadores certos */
function cpfValido(d) {
  if (!/^\d{11}$/.test(d) || /^(\d)\1{10}$/.test(d)) return false;
  const dv = n => { let s = 0; for (let i = 0; i < n; i++) s += +d[i] * (n + 1 - i); const r = (s * 10) % 11; return r === 10 ? 0 : r; };
  return dv(9) === +d[9] && dv(10) === +d[10];
}
const novoId = () => crypto.randomUUID();
const CEDULAS = [20000, 10000, 5000, 2000, 1000, 500, 200, 100, 50, 25, 10, 5];
const inteiro = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
const texto = (v, max = 200) => String(v ?? '').trim().slice(0, max);

/* opcoes: { url } para Postgres ou { arquivo } para SQLite */
async function abrirBanco(opcoes = {}) {
  const A = opcoes.url ? adaptadorPostgres(opcoes.url) : adaptadorSqlite(opcoes.arquivo || ':memory:');
  const { um, todos, rodar } = A;
  /* toda alteração passa por aqui: trava a linha "versao" primeiro, então as escritas
     ficam uma de cada vez também no Postgres, e as telas sabem que algo mudou */
  const transacao = fn => (...a) => A.transacao(async () => { await rodar('UPDATE versao SET n = n + 1 WHERE id = 1'); return fn(...a); });

  /* ---------- configuração ---------- */
  const lerCfg = async (chave, padrao) => { const r = await um('SELECT valor FROM config WHERE chave = ?', [chave]); return r ? JSON.parse(r.valor) : padrao; };
  const gravarCfg = (chave, valor) => rodar('INSERT INTO config (chave, valor) VALUES (?, ?) ON CONFLICT (chave) DO UPDATE SET valor = excluded.valor', [chave, JSON.stringify(valor)]);

  const EMPRESA_PADRAO = { empresa: 'Altos Sabores Restaurante', razao: 'Restaurante Altos Sabores Ltda', cnpj: '63.062.421/0001-67', ie: '', regime: 'Simples Nacional', telefone: '', endereco: '', bairro: '', cidade: '', uf: '', cep: '', rodape: 'Obrigado e volte sempre!' };
  const IMPRESSORA_PADRAO = { modelo: 'Elgin i9', conexao: 'usb', usb: 'USB001', ip: '192.168.0.50', porta: '9100', com: 'COM3', baud: '9600', papel: 80, corte: true, gaveta: true, autoImprimir: true, vias: 1, testadaEm: null };
  /* só dados públicos do certificado; o arquivo .pfx e a senha nunca entram no banco */
  const FISCAL_PADRAO = { checklist: { cert: true }, certificado: { titular: 'RESTAURANTE ALTOS SABORES LTDA', cnpj: '63.062.421/0001-67', tipo: 'A1 (e-CNPJ)', emissor: 'AC SyngularID Múltipla', validoDe: Date.UTC(2026, 9, 29, 17, 55), validoAte: Date.UTC(2027, 9, 29, 17, 55) } };

  /* cria as tabelas e os dados iniciais (uma vez só, mesmo com vários servidores subindo juntos) */
  await A.transacao(async () => {
    if (A.tipo === 'postgres') await A.exec('SELECT pg_advisory_xact_lock(734211)');
    await A.exec(esquema(A.tipos));
    const cols = A.tipo === 'postgres'
      ? (await todos("SELECT column_name AS nome FROM information_schema.columns WHERE table_name = 'caixas'")).map(r => r.nome)
      : (await todos("SELECT name AS nome FROM pragma_table_info('caixas')")).map(r => r.nome);
    for (const c of ['observacao', 'contagem', 'pendentes']) if (!cols.includes(c)) await A.exec(`ALTER TABLE caixas ADD COLUMN ${c} TEXT`);
    if (!(await um('SELECT 1 AS x FROM categorias LIMIT 1'))) {
      for (const [k, [id, nome]] of [['Bebida', 'Bebidas'], ['Sobremesa', 'Sobremesas'], ['Outros', 'Outros']].entries()) await rodar('INSERT INTO categorias (id, nome, cor, ordem) VALUES (?, ?, ?, ?)', [id, nome, PALETA[k], k]);
      await rodar('INSERT INTO historico_preco (preco_kg_cents, em) VALUES (?, ?)', [9500, Date.now()]);
      await gravarCfg('empresa', EMPRESA_PADRAO); await gravarCfg('impressora', IMPRESSORA_PADRAO); await gravarCfg('fiscal', FISCAL_PADRAO);
    }
  });
  const precoKg = async () => (await um('SELECT preco_kg_cents AS v FROM historico_preco ORDER BY em DESC, id DESC LIMIT 1')).v;
  const versao = async () => (await um('SELECT n FROM versao WHERE id = 1')).n;
  const caixaAberto = () => um('SELECT * FROM caixas WHERE fechado_em IS NULL');

  /* ---------- usuários e sessões ---------- */
  const usuarioPub = u => u && ({ id: Number(u.id), nome: u.nome, email: u.email, perfil: u.perfil, ativo: !!u.ativo });
  const temUsuarios = async () => !!(await um('SELECT 1 AS x FROM usuarios LIMIT 1'));
  function validarSenha(senha) {
    if (typeof senha !== 'string' || senha.length < 8) throw new ErroUso('A senha precisa ter pelo menos 8 caracteres.');
    if (senha.length > 200) throw new ErroUso('Senha longa demais.');
  }
  function validarUsuario({ nome, email, senha, perfil }) {
    nome = texto(nome, 80); email = texto(email, 120).toLowerCase();
    if (nome.length < 2) throw new ErroUso('Digite o nome.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ErroUso('Digite um e-mail válido.');
    validarSenha(senha);
    if (perfil !== undefined && !['gerente', 'operador'].includes(perfil)) throw new ErroUso('Perfil inválido.');
    return { nome, email };
  }
  const inserirUsuario = async (nome, email, senha, perfil) => Number((await um('INSERT INTO usuarios (nome, email, senha_hash, perfil, criado_em) VALUES (?, ?, ?, ?, ?) RETURNING id', [nome, email, hashSenha(senha), perfil, Date.now()])).id);
  const criarPrimeiroGerente = transacao(async dados => {
    if (await temUsuarios()) throw new ErroUso('O primeiro acesso já foi criado. Entre com e-mail e senha.', 409);
    const { nome, email } = validarUsuario(dados);
    return inserirUsuario(nome, email, dados.senha, 'gerente');
  });
  const criarUsuario = transacao(async dados => {
    const { nome, email } = validarUsuario(dados);
    if (await um('SELECT 1 AS x FROM usuarios WHERE email = ?', [email])) throw new ErroUso('Já existe um usuário com esse e-mail.', 409);
    return inserirUsuario(nome, email, dados.senha, dados.perfil || 'operador');
  });
  const alterarUsuario = transacao(async (id, dados, quem) => {
    const u = await um('SELECT * FROM usuarios WHERE id = ?', [id]);
    if (!u) throw new ErroUso('Usuário não encontrado.', 404);
    const perfil = dados.perfil ?? u.perfil, ativo = dados.ativo === undefined ? !!u.ativo : !!dados.ativo;
    if (!['gerente', 'operador'].includes(perfil)) throw new ErroUso('Perfil inválido.');
    if (Number(u.id) === Number(quem.id) && (!ativo || perfil !== 'gerente')) throw new ErroUso('Você não pode desativar nem tirar o perfil de gerente da sua própria conta.');
    if (u.perfil === 'gerente' && (perfil !== 'gerente' || !ativo) && (await um("SELECT COUNT(*) AS n FROM usuarios WHERE perfil = 'gerente' AND ativo = 1")).n <= 1) throw new ErroUso('É preciso ter pelo menos um gerente ativo.');
    let nome = u.nome; if (dados.nome !== undefined) { nome = texto(dados.nome, 80); if (nome.length < 2) throw new ErroUso('Digite o nome.'); }
    await rodar('UPDATE usuarios SET nome = ?, perfil = ?, ativo = ? WHERE id = ?', [nome, perfil, ativo ? 1 : 0, id]);
    if (dados.senha) { validarSenha(dados.senha); await rodar('UPDATE usuarios SET senha_hash = ? WHERE id = ?', [hashSenha(dados.senha), id]); }
    if (!ativo || dados.senha) await rodar('DELETE FROM sessoes WHERE usuario_id = ?', [id]);
  });
  const trocarSenha = transacao(async (id, atual, nova) => {
    const u = await um('SELECT * FROM usuarios WHERE id = ?', [id]);
    if (!u || !confereSenha(atual, u.senha_hash)) throw new ErroUso('A senha atual não confere.', 403);
    validarSenha(nova);
    await rodar('UPDATE usuarios SET senha_hash = ? WHERE id = ?', [hashSenha(nova), id]);
  });
  async function login(email, senha) {
    const u = await um('SELECT * FROM usuarios WHERE email = ? AND ativo = 1', [texto(email, 120).toLowerCase()]);
    const ok = confereSenha(senha, u ? u.senha_hash : HASH_FALSO);   // mesmo custo quando o e-mail não existe
    return u && ok ? u : null;
  }
  /* limite de tentativas de login (guardado no banco: na nuvem cada acesso pode cair num servidor diferente) */
  const JANELA = 10 * 60e3;
  async function minutosBloqueado(chave) {
    const t = await um('SELECT n, desde FROM tentativas_login WHERE chave = ?', [chave]);
    if (!t || Date.now() - t.desde > JANELA || t.n < 5) return 0;
    return Math.ceil((t.desde + JANELA - Date.now()) / 60e3);
  }
  async function registrarFalha(chave) {
    const t = await um('SELECT n, desde FROM tentativas_login WHERE chave = ?', [chave]);
    if (!t || Date.now() - t.desde > JANELA) await rodar('INSERT INTO tentativas_login (chave, n, desde) VALUES (?, 1, ?) ON CONFLICT (chave) DO UPDATE SET n = 1, desde = excluded.desde', [chave, Date.now()]);
    else await rodar('UPDATE tentativas_login SET n = n + 1 WHERE chave = ?', [chave]);
  }
  const limparFalhas = chave => rodar('DELETE FROM tentativas_login WHERE chave = ?', [chave]);
  const hashToken = t => crypto.createHash('sha256').update(t).digest('hex');
  async function criarSessao(usuarioId, horas = 12) {
    const token = crypto.randomBytes(32).toString('base64url');
    await rodar('DELETE FROM sessoes WHERE expira_em < ?', [Date.now()]);
    await rodar('INSERT INTO sessoes (token_hash, usuario_id, criado_em, expira_em) VALUES (?, ?, ?, ?)', [hashToken(token), usuarioId, Date.now(), Date.now() + horas * 36e5]);
    return token;
  }
  async function usuarioDaSessao(token) {
    if (!token) return null;
    return (await um('SELECT u.* FROM sessoes s JOIN usuarios u ON u.id = s.usuario_id WHERE s.token_hash = ? AND s.expira_em > ? AND u.ativo = 1', [hashToken(token), Date.now()])) || null;
  }
  const encerrarSessao = async token => { if (token) await rodar('DELETE FROM sessoes WHERE token_hash = ?', [hashToken(token)]); };
  /* autorização de gerente: o próprio usuário é gerente, ou digitou a senha de um gerente ativo */
  async function autorizarGerente(quem, senhaGerente) {
    if (quem.perfil === 'gerente') return quem.nome;
    const g = (await todos("SELECT * FROM usuarios WHERE perfil = 'gerente' AND ativo = 1")).find(x => confereSenha(senhaGerente || '', x.senha_hash));
    if (!g) throw new ErroUso('Senha do gerente não confere.', 403);
    return g.nome;
  }

  /* ---------- comandas ---------- */
  const evento = (comandaId, acao, detalhe, quem) => rodar('INSERT INTO eventos (comanda_id, em, acao, detalhe, usuario_nome) VALUES (?, ?, ?, ?, ?)', [comandaId, Date.now(), acao, JSON.stringify(detalhe || {}), quem ? quem.nome : '']);
  async function comandaAberta(id) {
    const c = await um('SELECT * FROM comandas WHERE id = ?', [String(id)]);
    if (!c) throw new ErroUso('Comanda não encontrada.', 404);
    if (c.status !== 'aberta') throw new ErroUso(`A comanda ${c.numero} não está aberta.`, 409);
    return c;
  }
  const totalDe = async id => (await um('SELECT COALESCE(SUM(total_cents), 0) AS t FROM itens WHERE comanda_id = ?', [id])).t;
  async function abrirComandaSemTx(numero, quem) {
    if (!inteiro(numero, 1, 99999)) throw new ErroUso('Número de comanda inválido.');
    const ex = await um("SELECT id FROM comandas WHERE numero = ? AND status = 'aberta'", [numero]);
    if (ex) return { id: ex.id, nova: false };
    const id = novoId();
    await rodar("INSERT INTO comandas (id, numero, status, aberta_em, aberta_por) VALUES (?, ?, 'aberta', ?, ?)", [id, numero, Date.now(), quem.id]);
    return { id, nova: true };
  }
  async function lancarPratoSemTx(comandaId, gramas, quem) {
    await comandaAberta(comandaId);
    if (!inteiro(gramas, 1, 5000)) throw new ErroUso('Peso inválido. Digite em gramas, de 1 a 5000.');
    const kg = await precoKg(), id = novoId();
    await rodar("INSERT INTO itens (id, comanda_id, tipo, nome, gramas, qtd, unit_cents, total_cents, em, usuario_id) VALUES (?, ?, 'kg', 'Refeição por quilo', ?, 1, ?, ?, ?, ?)", [id, comandaId, gramas, kg, precoPrato(gramas, kg), Date.now(), quem.id]);
    return id;
  }
  const abrirComanda = transacao((numero, quem) => abrirComandaSemTx(numero, quem));
  const pesarNaBalanca = transacao(async (numero, gramas, quem) => {
    if (!inteiro(gramas, 1, 5000)) throw new ErroUso('Peso inválido. Digite em gramas, de 1 a 5000.');
    const { id, nova } = await abrirComandaSemTx(numero, quem);
    return { comandaId: id, nova, itemId: await lancarPratoSemTx(id, gramas, quem) };
  });
  const adicionarItem = transacao(async (comandaId, dados, quem) => {
    if (dados.tipo === 'kg') return lancarPratoSemTx(comandaId, dados.gramas, quem);
    await comandaAberta(comandaId);
    const p = await um('SELECT * FROM produtos WHERE id = ? AND ativo = 1', [String(dados.produtoId || '')]);
    if (!p) throw new ErroUso('Produto não encontrado ou fora da comanda.', 404);
    const ex = await um("SELECT * FROM itens WHERE comanda_id = ? AND tipo = 'un' AND produto_id = ? AND unit_cents = ?", [comandaId, p.id, p.preco_cents]);
    if (ex) { await rodar('UPDATE itens SET qtd = qtd + 1, total_cents = (qtd + 1) * unit_cents WHERE id = ?', [ex.id]); return ex.id; }
    const id = novoId();
    await rodar("INSERT INTO itens (id, comanda_id, tipo, nome, produto_id, qtd, unit_cents, total_cents, em, usuario_id) VALUES (?, ?, 'un', ?, ?, 1, ?, ?, ?, ?)", [id, comandaId, p.nome, p.id, p.preco_cents, p.preco_cents, Date.now(), quem.id]);
    return id;
  });
  const mudarQtd = transacao(async (itemId, qtd) => {
    const i = await um('SELECT * FROM itens WHERE id = ?', [String(itemId)]);
    if (!i) throw new ErroUso('Item não encontrado.', 404);
    await comandaAberta(i.comanda_id);
    if (i.tipo !== 'un') throw new ErroUso('O peso do prato não muda; tire o prato e pese de novo.');
    if (!inteiro(qtd, 1, 999)) throw new ErroUso('Quantidade inválida.');
    await rodar('UPDATE itens SET qtd = ?, total_cents = ? WHERE id = ?', [qtd, qtd * i.unit_cents, i.id]);
  });
  const removerItem = transacao(async (itemId, acao, quem) => {
    const i = await um('SELECT * FROM itens WHERE id = ?', [String(itemId)]);
    if (!i) throw new ErroUso('Item não encontrado.', 404);
    await comandaAberta(i.comanda_id);
    await rodar('DELETE FROM itens WHERE id = ?', [i.id]);
    await evento(i.comanda_id, acao === 'pesagem desfeita' ? 'pesagem desfeita' : 'item removido', { item: i.tipo === 'kg' ? `Prato ${(i.gramas / 1000).toFixed(3).replace('.', ',')} kg` : i.nome, valorCents: i.total_cents }, quem);
  });
  const descartarVazia = transacao(async comandaId => {
    const c = await comandaAberta(comandaId);
    if (await um('SELECT 1 AS x FROM itens WHERE comanda_id = ?', [c.id])) throw new ErroUso('A comanda tem itens. Use “Cancelar comanda”.', 409);
    await rodar('DELETE FROM comandas WHERE id = ?', [c.id]);
  });
  const cancelarComanda = transacao(async (comandaId, motivo, senhaGerente, quem) => {
    const c = await comandaAberta(comandaId);
    motivo = texto(motivo, 300); if (motivo.length < 5) throw new ErroUso('Escreva o motivo (pelo menos 5 letras).');
    const autorizou = await autorizarGerente(quem, senhaGerente);
    await rodar("UPDATE comandas SET status = 'cancelada', cancelada_em = ? WHERE id = ?", [Date.now(), c.id]);
    await evento(c.id, 'cancelada', { motivo, autorizadoPor: autorizou }, quem);
  });
  const reabrirComanda = transacao(async (comandaId, motivo, senhaGerente, quem) => {
    const c = await um('SELECT * FROM comandas WHERE id = ?', [String(comandaId)]);
    if (!c) throw new ErroUso('Comanda não encontrada.', 404);
    if (c.status === 'aberta') throw new ErroUso('A comanda já está aberta.', 409);
    if (await um("SELECT 1 AS x FROM comandas WHERE numero = ? AND status = 'aberta'", [c.numero])) throw new ErroUso(`Já existe uma comanda ${c.numero} aberta. Feche ela antes.`, 409);
    motivo = texto(motivo, 300); if (motivo.length < 5) throw new ErroUso('Escreva o motivo (pelo menos 5 letras).');
    const autorizou = await autorizarGerente(quem, senhaGerente);
    const antes = await todos('SELECT forma, valor_cents AS "valorCents" FROM pagamentos WHERE comanda_id = ? ORDER BY id', [c.id]);
    await rodar('DELETE FROM pagamentos WHERE comanda_id = ?', [c.id]);
    await rodar("UPDATE comandas SET status = 'aberta', fechada_em = NULL, cancelada_em = NULL, troco_cents = 0, caixa_id = NULL WHERE id = ?", [c.id]);
    await evento(c.id, 'reaberta', { motivo, autorizadoPor: autorizou, pagamentosAnteriores: antes }, quem);
  });
  const pagarComanda = transacao(async (comandaId, pagamentos, cpf, quem) => {
    const cx = await caixaAberto();
    if (!cx) throw new ErroUso('Abra o caixa antes de receber.', 409);
    const c = await comandaAberta(comandaId);
    const total = await totalDe(c.id);
    if (!total) throw new ErroUso('A comanda está vazia.');
    if (!Array.isArray(pagamentos) || !pagamentos.length || pagamentos.length > 10) throw new ErroUso('Informe o pagamento.');
    let soma = 0, dinheiro = 0;
    for (const p of pagamentos) {
      if (!p || !FORMAS.includes(p.forma) || !inteiro(p.valorCents, 1, 10_000_000)) throw new ErroUso('Pagamento inválido.');
      soma += p.valorCents; if (p.forma === 'dinheiro') dinheiro += p.valorCents;
    }
    if (soma < total) throw new ErroUso(`Falta receber ${((total - soma) / 100).toFixed(2).replace('.', ',')}.`);
    const troco = soma - total;
    if (troco > dinheiro) throw new ErroUso('Troco só em dinheiro: cartão, Pix e vale não podem passar do total.');
    const doc = String(cpf || '').replace(/\D/g, '');
    if (doc.length === 14) throw new ErroUso('A NFC-e não pode sair no CNPJ de empresa (regra desde nov/2025). Deixe em branco ou use o CPF; para empresa é preciso NF-e.');
    if (doc && !cpfValido(doc)) throw new ErroUso('CPF inválido. Confira os 11 números ou deixe em branco.');
    for (const p of pagamentos) await rodar('INSERT INTO pagamentos (comanda_id, forma, valor_cents) VALUES (?, ?, ?)', [c.id, p.forma, p.valorCents]);
    await rodar("UPDATE comandas SET status = 'fechada', fechada_em = ?, troco_cents = ?, cpf = ?, caixa_id = ? WHERE id = ?", [Date.now(), troco, texto(cpf, 20), cx.id, c.id]);
    return troco;
  });

  /* ---------- caixa ---------- */
  async function resumoCaixa(cx) {
    const porForma = Object.fromEntries(FORMAS.map(f => [f, 0]));
    (await todos("SELECT p.forma, SUM(p.valor_cents) AS v FROM pagamentos p JOIN comandas c ON c.id = p.comanda_id WHERE c.caixa_id = ? AND c.status = 'fechada' GROUP BY p.forma", [cx.id])).forEach(r => porForma[r.forma] = r.v);
    const v = await um("SELECT COUNT(*) AS n, COALESCE(SUM(troco_cents), 0) AS troco FROM comandas WHERE caixa_id = ? AND status = 'fechada'", [cx.id]);
    const totalVendas = (await um("SELECT COALESCE(SUM(i.total_cents), 0) AS t FROM itens i JOIN comandas c ON c.id = i.comanda_id WHERE c.caixa_id = ? AND c.status = 'fechada'", [cx.id])).t;
    porForma.dinheiro -= v.troco;
    const soma = async tipo => (await um('SELECT COALESCE(SUM(valor_cents), 0) AS s FROM movimentos WHERE caixa_id = ? AND tipo = ?', [cx.id, tipo])).s;
    const sup = await soma('suprimento'), san = await soma('sangria');
    return { porForma, comandas: v.n, totalVendas, sup, san, esperado: { ...porForma, dinheiro: cx.fundo_cents + porForma.dinheiro + sup - san } };
  }
  const abrirCaixa = transacao(async (fundoCents, quem) => {
    if (await caixaAberto()) throw new ErroUso('O caixa já está aberto.', 409);
    if (!inteiro(fundoCents, 0, 10_000_000)) throw new ErroUso('Digite o fundo de troco, ex.: 200,00');
    await rodar('INSERT INTO caixas (operador_id, operador_nome, aberto_em, fundo_cents) VALUES (?, ?, ?, ?)', [quem.id, quem.nome, Date.now(), fundoCents]);
  });
  const movimentarCaixa = transacao(async (tipo, valorCents, motivo, quem) => {
    const cx = await caixaAberto(); if (!cx) throw new ErroUso('O caixa está fechado.', 409);
    if (!['sangria', 'suprimento'].includes(tipo)) throw new ErroUso('Tipo inválido.');
    if (!inteiro(valorCents, 1, 10_000_000)) throw new ErroUso('Digite o valor, ex.: 300,00');
    motivo = texto(motivo, 200); if (!motivo) throw new ErroUso('Escreva o motivo.');
    if (tipo === 'sangria' && valorCents > (await resumoCaixa(cx)).esperado.dinheiro) throw new ErroUso('A sangria é maior que o dinheiro que deveria estar na gaveta.');
    return Number((await um('INSERT INTO movimentos (caixa_id, tipo, valor_cents, motivo, em, usuario_id) VALUES (?, ?, ?, ?, ?, ?) RETURNING id', [cx.id, tipo, valorCents, motivo, Date.now(), quem.id])).id);
  });
  const fechamentoPub = f => ({ id: Number(f.id), operador: f.operador_nome, abertoEm: f.aberto_em, fechadoEm: f.fechado_em, fechadoPor: f.fechado_por, fundoCents: f.fundo_cents, sangriasCents: f.sangrias_cents, suprimentosCents: f.suprimentos_cents, totalVendasCents: f.total_vendas_cents, comandas: f.comandas, esperado: JSON.parse(f.esperado || '{}'), contado: JSON.parse(f.contado || '{}'), diferencaCents: f.diferenca_cents, observacao: f.observacao || '' });
  const comandasAbertasComTotal = async () => (await todos("SELECT c.numero, c.aberta_em, COALESCE(SUM(i.total_cents), 0) AS total FROM comandas c LEFT JOIN itens i ON i.comanda_id = c.id WHERE c.status = 'aberta' GROUP BY c.id, c.numero, c.aberta_em ORDER BY c.numero"))
    .map(r => ({ numero: r.numero, abertaEm: r.aberta_em, totalCents: r.total }));
  const fecharCaixa = transacao(async (contado, quem, extra = {}) => {
    const cx = await caixaAberto(); if (!cx) throw new ErroUso('O caixa já está fechado.', 409);
    const R = await resumoCaixa(cx);
    const ct = {};
    for (const f of FORMAS) { const v = contado && contado[f]; ct[f] = inteiro(v, 0, 100_000_000) ? v : 0; }
    const linhas = FORMAS.filter(f => R.esperado[f] || f === 'dinheiro');
    const diferenca = linhas.reduce((s, f) => s + ct[f] - R.esperado[f], 0);
    const contagem = {};
    if (extra.contagem && typeof extra.contagem === 'object') for (const v of CEDULAS) { const q = Number(extra.contagem[v]); if (inteiro(q, 1, 100000)) contagem[v] = q; }
    await rodar('UPDATE caixas SET fechado_em = ?, fechado_por = ?, total_vendas_cents = ?, comandas = ?, sangrias_cents = ?, suprimentos_cents = ?, esperado = ?, contado = ?, diferenca_cents = ?, observacao = ?, contagem = ?, pendentes = ? WHERE id = ?',
      [Date.now(), quem.nome, R.totalVendas, R.comandas, R.san, R.sup, JSON.stringify(R.esperado), JSON.stringify(ct), diferenca, texto(extra.observacao, 500), JSON.stringify(contagem), JSON.stringify(await comandasAbertasComTotal()), cx.id]);
    return fechamentoPub(await um('SELECT * FROM caixas WHERE id = ?', [cx.id]));
  });

  /* relatório completo de um caixa (aberto = conferência parcial; fechado = fechamento) */
  async function relatorioCaixa(id) {
    const cx = id ? await um('SELECT * FROM caixas WHERE id = ?', [Number(id)]) : await caixaAberto();
    if (!cx) throw new ErroUso(id ? 'Fechamento não encontrado.' : 'O caixa está fechado.', 404);
    const parcial = !cx.fechado_em, ini = cx.aberto_em, fim = cx.fechado_em || Date.now();
    const lista = async (sql, ids) => ids.length ? todos(sql.replace('?LISTA', ids.map(() => '?').join(',')), ids) : [];
    const pagasRows = await todos("SELECT * FROM comandas WHERE caixa_id = ? AND status = 'fechada' ORDER BY fechada_em", [cx.id]);
    const ids = pagasRows.map(c => c.id);
    const itens = await lista('SELECT * FROM itens WHERE comanda_id IN (?LISTA)', ids);
    const pags = await lista('SELECT * FROM pagamentos WHERE comanda_id IN (?LISTA) ORDER BY id', ids);
    const totalDeId = cid => itens.filter(i => i.comanda_id === cid).reduce((s, i) => s + i.total_cents, 0);
    const pagas = pagasRows.map(c => ({ numero: c.numero, fechadaEm: c.fechada_em, totalCents: totalDeId(c.id), trocoCents: c.troco_cents, cpf: c.cpf,
      pagamentos: pags.filter(p => p.comanda_id === c.id).map(p => ({ forma: p.forma, valorCents: p.valor_cents })) }));
    const formas = FORMAS.map(f => { const ps = pags.filter(p => p.forma === f); return { forma: f, qtd: ps.length, recebidoCents: ps.reduce((s, p) => s + p.valor_cents, 0) }; });
    const troco = pagasRows.reduce((s, c) => s + c.troco_cents, 0);
    const movimentos = (await todos('SELECT m.em, m.tipo, m.valor_cents, m.motivo, u.nome AS usuario FROM movimentos m LEFT JOIN usuarios u ON u.id = m.usuario_id WHERE m.caixa_id = ? ORDER BY m.em', [cx.id]))
      .map(m => ({ em: m.em, tipo: m.tipo, valorCents: m.valor_cents, motivo: m.motivo, usuario: m.usuario || '' }));
    const soma = t => movimentos.filter(m => m.tipo === t).reduce((s, m) => s + m.valorCents, 0);
    const recebidoDinheiro = formas.find(f => f.forma === 'dinheiro').recebidoCents;
    const dinheiro = { fundoCents: cx.fundo_cents, recebidoCents: recebidoDinheiro, trocoCents: troco, suprimentosCents: soma('suprimento'), sangriasCents: soma('sangria') };
    dinheiro.esperadoCents = dinheiro.fundoCents + dinheiro.recebidoCents - dinheiro.trocoCents + dinheiro.suprimentosCents - dinheiro.sangriasCents;
    let conferencia = null;
    if (!parcial) {
      const esp = JSON.parse(cx.esperado || '{}'), ct = JSON.parse(cx.contado || '{}');
      conferencia = FORMAS.filter(f => esp[f] || ct[f] || f === 'dinheiro').map(f => ({ forma: f, esperadoCents: esp[f] || 0, contadoCents: ct[f] || 0, diferencaCents: (ct[f] || 0) - (esp[f] || 0) }));
      dinheiro.esperadoCents = esp.dinheiro ?? dinheiro.esperadoCents;
      dinheiro.contadoCents = ct.dinheiro || 0;
    }
    const cancRows = await todos("SELECT * FROM comandas WHERE status = 'cancelada' AND cancelada_em >= ? AND cancelada_em <= ? ORDER BY cancelada_em", [ini, fim]);
    const cancItens = await lista('SELECT comanda_id, total_cents FROM itens WHERE comanda_id IN (?LISTA)', cancRows.map(c => c.id));
    const cancEv = await lista("SELECT * FROM eventos WHERE acao = 'cancelada' AND comanda_id IN (?LISTA)", cancRows.map(c => c.id));
    const canceladas = cancRows.map(c => { const e = cancEv.filter(x => x.comanda_id === c.id).pop(), d = e ? JSON.parse(e.detalhe) : {};
      return { numero: c.numero, em: c.cancelada_em, totalCents: cancItens.filter(i => i.comanda_id === c.id).reduce((s, i) => s + i.total_cents, 0), motivo: d.motivo || '', autorizadoPor: d.autorizadoPor || '', usuario: e ? e.usuario_nome : '' }; });
    const ocorrencias = (await todos("SELECT e.*, c.numero FROM eventos e JOIN comandas c ON c.id = e.comanda_id WHERE e.em >= ? AND e.em <= ? AND e.acao IN ('item removido', 'pesagem desfeita', 'reaberta') ORDER BY e.em", [ini, fim]))
      .map(e => { const d = JSON.parse(e.detalhe); return { em: e.em, numero: e.numero, acao: e.acao, item: d.item || '', valorCents: d.valorCents || 0, motivo: d.motivo || '', autorizadoPor: d.autorizadoPor || '', usuario: e.usuario_nome }; });
    const pendentes = parcial ? await comandasAbertasComTotal() : JSON.parse(cx.pendentes || '[]');
    const prod = new Map();
    for (const i of itens) {
      const k = i.tipo === 'kg' ? 'Refeição por quilo' : i.nome;
      const p = prod.get(k) || { nome: k, kg: i.tipo === 'kg', qtd: 0, gramas: 0, valorCents: 0 };
      p.qtd += i.tipo === 'kg' ? 1 : i.qtd; p.gramas += i.gramas || 0; p.valorCents += i.total_cents; prod.set(k, p);
    }
    const produtos = [...prod.values()].sort((a, b) => b.valorCents - a.valorCents);
    const vendas = pagas.reduce((s, c) => s + c.totalCents, 0), kg = prod.get('Refeição por quilo');
    return {
      parcial, emitidoEm: Date.now(),
      caixa: { id: Number(cx.id), operador: cx.operador_nome, abertoEm: cx.aberto_em, fechadoEm: cx.fechado_em || null, fechadoPor: cx.fechado_por || '', fundoCents: cx.fundo_cents, observacao: cx.observacao || '', contagem: JSON.parse(cx.contagem || '{}') },
      totais: { vendasCents: vendas, comandas: pagas.length, ticketMedioCents: pagas.length ? Math.round(vendas / pagas.length) : 0, pratos: kg ? kg.qtd : 0, gramas: kg ? kg.gramas : 0,
        canceladas: canceladas.length, canceladoCents: canceladas.reduce((s, c) => s + c.totalCents, 0), diferencaCents: parcial ? null : cx.diferenca_cents },
      formas, dinheiro, conferencia, movimentos, pagas, canceladas, ocorrencias, pendentes, produtos,
    };
  }

  /* ---------- produtos e categorias ---------- */
  async function validarProduto(d, idAtual) {
    const nome = texto(d.nome, 80), codigo = texto(d.codigo, 20);
    if (!nome) throw new ErroUso('Digite o nome do produto.');
    if (!inteiro(d.precoCents, 1, 10_000_000)) throw new ErroUso('Digite o preço, ex.: 6,00');
    if (!(await um('SELECT 1 AS x FROM categorias WHERE id = ?', [String(d.cat || '')]))) throw new ErroUso('Escolha uma categoria.');
    if (codigo && await um('SELECT 1 AS x FROM produtos WHERE codigo = ? AND id <> ?', [codigo, idAtual || ''])) throw new ErroUso(`O código ${codigo} já é de outro produto.`, 409);
    const f = d.fiscal || {};
    return [nome, String(d.cat), d.precoCents, codigo, d.ativo === false ? 0 : 1, texto(f.ncm, 12), texto(f.cfop, 6), texto(f.cest, 12)];
  }
  const criarProduto = transacao(async d => { const id = novoId(), v = await validarProduto(d); await rodar('INSERT INTO produtos (id, nome, categoria_id, preco_cents, codigo, ativo, ncm, cfop, cest, criado_em, atualizado_em) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [id, ...v, Date.now(), Date.now()]); return id; });
  const editarProduto = transacao(async (id, d) => {
    const p = await um('SELECT * FROM produtos WHERE id = ?', [String(id)]); if (!p) throw new ErroUso('Produto não encontrado.', 404);
    const atual = { nome: p.nome, cat: p.categoria_id, precoCents: p.preco_cents, codigo: p.codigo, ativo: !!p.ativo, fiscal: { ncm: p.ncm, cfop: p.cfop, cest: p.cest } };
    const v = await validarProduto({ ...atual, ...d, fiscal: { ...atual.fiscal, ...(d.fiscal || {}) } }, p.id);
    await rodar('UPDATE produtos SET nome = ?, categoria_id = ?, preco_cents = ?, codigo = ?, ativo = ?, ncm = ?, cfop = ?, cest = ?, atualizado_em = ? WHERE id = ?', [...v, Date.now(), p.id]);
  });
  const excluirProduto = transacao(async id => { if (!(await rodar('DELETE FROM produtos WHERE id = ?', [String(id)])).changes) throw new ErroUso('Produto não encontrado.', 404); });
  const carregarExemplos = transacao(async () => {
    if (await um('SELECT 1 AS x FROM produtos LIMIT 1')) throw new ErroUso('Já existem produtos cadastrados.', 409);
    const lista = [['Bebida', [['Refrigerante lata 350ml', 600], ['Refrigerante 600ml', 800], ['Refrigerante 2L', 1400], ['Água mineral 500ml', 400], ['Água com gás 500ml', 450], ['Suco natural 400ml', 900], ['Suco de laranja 400ml', 900], ['Água de coco 300ml', 700], ['Cerveja long neck', 1000], ['Cerveja lata 350ml', 700]]],
      ['Sobremesa', [['Pudim', 800], ['Mousse de maracujá', 700], ['Sorvete (bola)', 600], ['Salada de frutas', 750], ['Brigadeiro', 300], ['Doce de leite', 500]]],
      ['Outros', [['Café', 300], ['Embalagem marmitex', 200]]]];
    const cats = (await todos('SELECT id FROM categorias')).map(c => c.id);
    for (const [k, [cat, ps]] of lista.entries()) {
      if (!cats.includes(cat)) continue;
      for (const [j, [nome, preco]] of ps.entries()) await rodar('INSERT INTO produtos (id, nome, categoria_id, preco_cents, codigo, ativo, criado_em, atualizado_em) VALUES (?, ?, ?, ?, ?, 1, ?, ?)', [novoId(), nome, cat, preco, String((k + 1) * 100 + j + 1), Date.now(), Date.now()]);
    }
  });
  async function validarCategoria(d, idAtual) {
    const nome = texto(d.nome, 40); if (!nome) throw new ErroUso('Digite o nome da categoria.');
    if ((await todos('SELECT id, nome FROM categorias')).some(c => c.id !== idAtual && c.nome.toLowerCase() === nome.toLowerCase())) throw new ErroUso('Já existe uma categoria com esse nome.', 409);
    const cor = /^#[0-9a-fA-F]{6}$/.test(d.cor || '') ? d.cor : PALETA[0];
    return { nome, cor };
  }
  const criarCategoria = transacao(async d => { const { nome, cor } = await validarCategoria(d); const id = novoId(); await rodar('INSERT INTO categorias (id, nome, cor, ordem) VALUES (?, ?, ?, (SELECT COALESCE(MAX(ordem), 0) + 1 FROM categorias))', [id, nome, cor]); return id; });
  const editarCategoria = transacao(async (id, d) => { const { nome, cor } = await validarCategoria(d, id); if (!(await rodar('UPDATE categorias SET nome = ?, cor = ? WHERE id = ?', [nome, cor, String(id)])).changes) throw new ErroUso('Categoria não encontrada.', 404); });
  const excluirCategoria = transacao(async id => {
    const n = (await um('SELECT COUNT(*) AS n FROM produtos WHERE categoria_id = ?', [String(id)])).n;
    if (n) throw new ErroUso(`Mova ou exclua os ${n} produtos desta categoria antes de excluí-la.`, 409);
    if ((await um('SELECT COUNT(*) AS n FROM categorias')).n <= 1) throw new ErroUso('É preciso ter pelo menos uma categoria.', 409);
    if (!(await rodar('DELETE FROM categorias WHERE id = ?', [String(id)])).changes) throw new ErroUso('Categoria não encontrada.', 404);
  });

  /* ---------- configurações ---------- */
  const mudarPrecoKg = transacao(async (v, quem) => {
    if (!inteiro(v, 1, 1_000_000)) throw new ErroUso('Digite um preço válido, ex.: 95,00');
    if (v === await precoKg()) throw new ErroUso('O preço já é esse.');
    await rodar('INSERT INTO historico_preco (preco_kg_cents, em, usuario_id) VALUES (?, ?, ?)', [v, Date.now(), quem.id]);
  });
  const salvarEmpresa = transacao(async d => {
    const novo = { ...(await lerCfg('empresa', EMPRESA_PADRAO)) };
    Object.keys(EMPRESA_PADRAO).forEach(k => { if (d[k] !== undefined) novo[k] = texto(d[k], 160); });
    if (!novo.empresa) throw new ErroUso('O nome fantasia não pode ficar vazio.');
    novo.uf = novo.uf.toUpperCase().slice(0, 2);
    await gravarCfg('empresa', novo);
  });
  const salvarImpressora = transacao(async d => {
    const novo = { ...(await lerCfg('impressora', IMPRESSORA_PADRAO)) };
    ['modelo', 'usb', 'ip', 'porta', 'com', 'baud'].forEach(k => { if (d[k] !== undefined) novo[k] = texto(d[k], 80); });
    if (d.conexao !== undefined) { if (!['usb', 'rede', 'serial'].includes(d.conexao)) throw new ErroUso('Conexão inválida.'); novo.conexao = d.conexao; }
    if (d.papel !== undefined) { if (![58, 80].includes(+d.papel)) throw new ErroUso('Papel inválido.'); novo.papel = +d.papel; }
    if (d.vias !== undefined) novo.vias = [1, 2].includes(+d.vias) ? +d.vias : 1;
    ['corte', 'gaveta', 'autoImprimir'].forEach(k => { if (d[k] !== undefined) novo[k] = !!d[k]; });
    if (d.testadaEm) novo.testadaEm = Date.now();
    await gravarCfg('impressora', novo);
  });
  const salvarChecklist = transacao(async checklist => {
    const f = await lerCfg('fiscal', FISCAL_PADRAO);
    f.checklist = Object.fromEntries(['cert', 'ie', 'cred', 'csc', 'tab', 'api'].map(k => [k, !!(checklist && checklist[k])]));
    await gravarCfg('fiscal', f);
  });

  /* ---------- foto completa para a tela ---------- */
  async function estado(quem) {
    const desde = Date.now() - 90 * DIA;
    const cmds = await todos("SELECT * FROM comandas WHERE status = 'aberta' OR COALESCE(fechada_em, cancelada_em, aberta_em) >= ? ORDER BY aberta_em", [desde]);
    const ids = cmds.map(c => c.id);
    const porComanda = async sql => {
      const m = new Map(); if (!ids.length) return m;
      (await todos(sql.replace('?LISTA', ids.map(() => '?').join(',')), ids)).forEach(r => { if (!m.has(r.comanda_id)) m.set(r.comanda_id, []); m.get(r.comanda_id).push(r); });
      return m;
    };
    const itens = await porComanda('SELECT * FROM itens WHERE comanda_id IN (?LISTA) ORDER BY em, id');
    const pags = await porComanda('SELECT * FROM pagamentos WHERE comanda_id IN (?LISTA) ORDER BY id');
    const evs = await porComanda('SELECT * FROM eventos WHERE comanda_id IN (?LISTA) ORDER BY em, id');
    const cx = await caixaAberto();
    const empresa = await lerCfg('empresa', EMPRESA_PADRAO);
    return {
      versao: await versao(),
      usuario: usuarioPub(quem),
      config: { ...empresa, precoKgCents: await precoKg(), historicoPreco: await todos('SELECT preco_kg_cents AS "precoKgCents", em FROM historico_preco ORDER BY em, id') },
      categorias: await todos('SELECT id, nome, cor FROM categorias ORDER BY ordem, nome'),
      produtos: (await todos('SELECT * FROM produtos ORDER BY nome')).map(p => ({ id: p.id, nome: p.nome, cat: p.categoria_id, precoCents: p.preco_cents, codigo: p.codigo, ativo: !!p.ativo, fiscal: { ncm: p.ncm, cfop: p.cfop, cest: p.cest } })),
      comandas: cmds.map(c => ({
        id: c.id, numero: c.numero, status: c.status, abertaEm: c.aberta_em, fechadaEm: c.fechada_em || undefined, canceladaEm: c.cancelada_em || undefined,
        trocoCents: c.troco_cents, cpf: c.cpf,
        itens: (itens.get(c.id) || []).map(i => ({ id: i.id, tipo: i.tipo, nome: i.nome, produtoId: i.produto_id || undefined, gramas: i.gramas ?? undefined, qtd: i.qtd, unitCents: i.unit_cents, totalCents: i.total_cents, em: i.em })),
        pagamentos: (pags.get(c.id) || []).map(p => ({ forma: p.forma, valorCents: p.valor_cents })),
        log: (evs.get(c.id) || []).map(e => ({ em: e.em, acao: e.acao, usuario: e.usuario_nome, ...JSON.parse(e.detalhe) })),
      })),
      caixa: cx ? { aberto: true, id: Number(cx.id), operador: cx.operador_nome, abertoEm: cx.aberto_em, fundoCents: cx.fundo_cents, movimentos: (await todos('SELECT id, tipo, valor_cents AS "valorCents", motivo, em FROM movimentos WHERE caixa_id = ? ORDER BY em', [cx.id])).map(m => ({ ...m, id: Number(m.id) })) }
        : { aberto: false, operador: quem ? quem.nome : '', movimentos: [] },
      fechamentos: (await todos('SELECT * FROM caixas WHERE fechado_em IS NOT NULL ORDER BY fechado_em DESC LIMIT 60')).map(fechamentoPub),
      impressora: await lerCfg('impressora', IMPRESSORA_PADRAO),
      fiscal: await lerCfg('fiscal', FISCAL_PADRAO),
    };
  }

  /* cópia de segurança: todas as tabelas em JSON (sem sessões nem tentativas de login) */
  async function exportar() {
    const tabelas = ['usuarios', 'config', 'historico_preco', 'categorias', 'produtos', 'caixas', 'movimentos', 'comandas', 'itens', 'pagamentos', 'eventos'];
    const dados = {};
    for (const t of tabelas) dados[t] = await todos(`SELECT * FROM ${t}`);
    return { sistema: 'altos-sabores-caixa', geradoEm: new Date().toISOString(), banco: A.tipo, dados };
  }

  return {
    tipo: A.tipo, versao, estado, temUsuarios, criarPrimeiroGerente, criarUsuario, alterarUsuario, trocarSenha, login,
    minutosBloqueado, registrarFalha, limparFalhas, criarSessao, usuarioDaSessao, encerrarSessao,
    listarUsuarios: async () => (await todos('SELECT * FROM usuarios ORDER BY nome')).map(usuarioPub),
    abrirComanda, pesarNaBalanca, adicionarItem, mudarQtd, removerItem, descartarVazia, cancelarComanda, reabrirComanda, pagarComanda,
    abrirCaixa, movimentarCaixa, fecharCaixa, relatorioCaixa,
    criarProduto, editarProduto, excluirProduto, carregarExemplos, criarCategoria, editarCategoria, excluirCategoria,
    mudarPrecoKg, salvarEmpresa, salvarImpressora, salvarChecklist, exportar,
    consulta: (sql, p) => um(sql, p),
    fechar: () => A.fechar(),
  };
}

module.exports = { abrirBanco, ErroUso, hashSenha, confereSenha, precoPrato, FORMAS };

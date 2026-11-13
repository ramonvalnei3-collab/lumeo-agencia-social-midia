'use strict';
/* Servidor do sistema de caixa Altos Sabores.
   Dois jeitos de rodar, com o mesmo código:
   - Computador do caixa:  node --no-warnings servidor.js   (banco SQLite em ./dados/restaurante.db)
   - Nuvem (Vercel):       api/index.js usa criarApp() com o Postgres de DATABASE_URL */
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { abrirBanco, ErroUso } = require('./banco');

const PUBLICO = path.join(__dirname, 'public');
const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const COOKIE = 'as_sessao';
const HORAS_SESSAO = 12;

/* opcoes: { url } (Postgres, nuvem) ou { arquivo } (SQLite, computador do caixa)
   codigoPrimeiroAcesso: na nuvem, o código que libera criar o primeiro gerente */
async function criarApp({ url, arquivo, codigoPrimeiroAcesso } = {}) {
  const B = await abrirBanco(url ? { url } : { arquivo: arquivo || ':memory:' });
  const nuvem = !!url;

  /* ---------- utilidades HTTP ---------- */
  const ipDe = req => (nuvem ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '') || req.socket.remoteAddress || '';
  const ehLocal = req => !nuvem && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
  const https = req => nuvem || req.headers['x-forwarded-proto'] === 'https';
  function cookies(req) {
    const out = {};
    String(req.headers.cookie || '').split(';').forEach(p => { const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); });
    return out;
  }
  function json(res, status, corpo, extra = {}) {
    const txt = JSON.stringify(corpo);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(txt), ...extra });
    res.end(txt);
  }
  function lerCorpo(req) {
    return new Promise((ok, falha) => {
      let tam = 0; const partes = [];
      req.on('data', c => { tam += c.length; if (tam > 1e6) { falha(new ErroUso('Envio grande demais.', 413)); req.destroy(); } else partes.push(c); });
      req.on('end', () => {
        if (!partes.length) return ok({});
        try { ok(JSON.parse(Buffer.concat(partes).toString('utf8'))); } catch { falha(new ErroUso('Dados inválidos.')); }
      });
      req.on('error', falha);
    });
  }
  const cookieSessao = (req, token) => `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${HORAS_SESSAO * 3600}${https(req) ? '; Secure' : ''}`;
  const cookieApagar = req => `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${https(req) ? '; Secure' : ''}`;
  function codigoConfere(digitado) {
    if (!codigoPrimeiroAcesso || codigoPrimeiroAcesso.length < 8) return false;
    const a = crypto.createHash('sha256').update(String(digitado || '')).digest(), b = crypto.createHash('sha256').update(codigoPrimeiroAcesso).digest();
    return crypto.timingSafeEqual(a, b);
  }

  /* ---------- rotas ---------- */
  const rotas = [];
  const rota = (metodo, padrao, opcoes, fn) => {
    const nomes = [];
    const re = new RegExp('^' + padrao.replace(/:(\w+)/g, (_, n) => { nomes.push(n); return '([^/]+)'; }) + '$');
    rotas.push({ metodo, re, nomes, fn, ...opcoes });
  };
  const ABERTA = { publica: true }, LOGADO = {}, GERENTE = { gerente: true };
  /* respostas de alteração devolvem a foto atualizada para a tela redesenhar */
  const comEstado = async (quem, extra = {}) => ({ ok: true, ...extra, estado: await B.estado(quem) });

  // login e primeiro acesso
  rota('GET', '/api/auth/estado', ABERTA, async ({ quem, req }) => ({
    temUsuarios: await B.temUsuarios(), modo: nuvem ? 'nuvem' : 'local', local: ehLocal(req),
    codigoConfigurado: !!(codigoPrimeiroAcesso && codigoPrimeiroAcesso.length >= 8),
    usuario: quem ? { id: Number(quem.id), nome: quem.nome, email: quem.email, perfil: quem.perfil } : null,
  }));
  rota('POST', '/api/auth/primeiro-acesso', ABERTA, async ({ req, corpo }) => {
    if (nuvem) {
      if (!codigoPrimeiroAcesso || codigoPrimeiroAcesso.length < 8) throw new ErroUso('Falta configurar o código de primeiro acesso na Vercel (CODIGO_PRIMEIRO_ACESSO, com pelo menos 8 caracteres).', 403);
      const chave = `primeiro|${ipDe(req)}`;
      const espera = await B.minutosBloqueado(chave);
      if (espera) throw new ErroUso(`Muitas tentativas erradas. Espere ${espera} min e tente de novo.`, 429);
      if (!codigoConfere(corpo.codigo)) { await B.registrarFalha(chave); throw new ErroUso('Código de primeiro acesso errado.', 403); }
    } else if (!ehLocal(req)) throw new ErroUso('O primeiro acesso só pode ser criado no computador onde o sistema está instalado.', 403);
    const id = await B.criarPrimeiroGerente(corpo);
    return { _cookie: cookieSessao(req, await B.criarSessao(id, HORAS_SESSAO)), ok: true };
  });
  rota('POST', '/api/auth/login', ABERTA, async ({ req, corpo }) => {
    const chave = `${ipDe(req)}|${String(corpo.email || '').toLowerCase().slice(0, 120)}`;
    const espera = await B.minutosBloqueado(chave);
    if (espera) throw new ErroUso(`Muitas tentativas erradas. Espere ${espera} min e tente de novo.`, 429);
    const u = await B.login(corpo.email, corpo.senha);
    if (!u) { await B.registrarFalha(chave); throw new ErroUso('E-mail ou senha incorretos.', 401); }
    await B.limparFalhas(chave);
    return { _cookie: cookieSessao(req, await B.criarSessao(u.id, HORAS_SESSAO)), ok: true };
  });
  rota('POST', '/api/auth/sair', ABERTA, async ({ req }) => { await B.encerrarSessao(cookies(req)[COOKIE]); return { _cookie: cookieApagar(req), ok: true }; });
  rota('PUT', '/api/conta/senha', LOGADO, async ({ quem, corpo }) => { await B.trocarSenha(quem.id, corpo.atual, corpo.nova); return { ok: true }; });

  // leitura
  rota('GET', '/api/estado', LOGADO, ({ quem }) => B.estado(quem));
  rota('GET', '/api/versao', LOGADO, async () => ({ versao: await B.versao() }));

  // comandas e balança
  rota('POST', '/api/comandas', LOGADO, async ({ quem, corpo }) => comEstado(quem, await B.abrirComanda(corpo.numero, quem)));
  rota('POST', '/api/balanca', LOGADO, async ({ quem, corpo }) => {
    const r = await B.pesarNaBalanca(corpo.numero, corpo.gramas, quem);
    const e = await B.estado(quem), c = e.comandas.find(x => x.id === r.comandaId);
    return { ok: true, nova: r.nova, comandaId: r.comandaId, item: c.itens.find(i => i.id === r.itemId), estado: e };
  });
  rota('POST', '/api/comandas/:id/itens', LOGADO, async ({ quem, corpo, p }) => comEstado(quem, { itemId: await B.adicionarItem(p.id, corpo, quem) }));
  rota('PATCH', '/api/itens/:id', LOGADO, async ({ quem, corpo, p }) => { await B.mudarQtd(p.id, corpo.qtd); return comEstado(quem); });
  rota('DELETE', '/api/itens/:id', LOGADO, async ({ quem, corpo, p }) => { await B.removerItem(p.id, corpo.acao, quem); return comEstado(quem); });
  rota('DELETE', '/api/comandas/:id', LOGADO, async ({ quem, p }) => { await B.descartarVazia(p.id); return comEstado(quem); });
  rota('POST', '/api/comandas/:id/cancelar', LOGADO, async ({ quem, corpo, p }) => { await B.cancelarComanda(p.id, corpo.motivo, corpo.senhaGerente, quem); return comEstado(quem); });
  rota('POST', '/api/comandas/:id/reabrir', LOGADO, async ({ quem, corpo, p }) => { await B.reabrirComanda(p.id, corpo.motivo, corpo.senhaGerente, quem); return comEstado(quem); });
  rota('POST', '/api/comandas/:id/pagar', LOGADO, async ({ quem, corpo, p }) => comEstado(quem, { trocoCents: await B.pagarComanda(p.id, corpo.pagamentos, corpo.cpf, quem) }));

  // caixa
  rota('POST', '/api/caixa/abrir', LOGADO, async ({ quem, corpo }) => { await B.abrirCaixa(corpo.fundoCents, quem); return comEstado(quem); });
  rota('POST', '/api/caixa/movimentos', LOGADO, async ({ quem, corpo }) => comEstado(quem, { id: await B.movimentarCaixa(corpo.tipo, corpo.valorCents, corpo.motivo, quem) }));
  rota('POST', '/api/caixa/fechar', LOGADO, async ({ quem, corpo }) => comEstado(quem, { fechamento: await B.fecharCaixa(corpo.contado, quem) }));

  // produtos e categorias (gerente)
  rota('POST', '/api/produtos', GERENTE, async ({ quem, corpo }) => comEstado(quem, { id: await B.criarProduto(corpo) }));
  rota('POST', '/api/produtos/exemplo', GERENTE, async ({ quem }) => { await B.carregarExemplos(); return comEstado(quem); });
  rota('PUT', '/api/produtos/:id', GERENTE, async ({ quem, corpo, p }) => { await B.editarProduto(p.id, corpo); return comEstado(quem); });
  rota('PATCH', '/api/produtos/:id', GERENTE, async ({ quem, corpo, p }) => { await B.editarProduto(p.id, corpo); return comEstado(quem); });
  rota('DELETE', '/api/produtos/:id', GERENTE, async ({ quem, p }) => { await B.excluirProduto(p.id); return comEstado(quem); });
  rota('POST', '/api/categorias', GERENTE, async ({ quem, corpo }) => comEstado(quem, { id: await B.criarCategoria(corpo) }));
  rota('PUT', '/api/categorias/:id', GERENTE, async ({ quem, corpo, p }) => { await B.editarCategoria(p.id, corpo); return comEstado(quem); });
  rota('DELETE', '/api/categorias/:id', GERENTE, async ({ quem, p }) => { await B.excluirCategoria(p.id); return comEstado(quem); });

  // configurações (gerente)
  rota('PUT', '/api/config/preco-kg', GERENTE, async ({ quem, corpo }) => { await B.mudarPrecoKg(corpo.precoKgCents, quem); return comEstado(quem); });
  rota('PUT', '/api/config/empresa', GERENTE, async ({ quem, corpo }) => { await B.salvarEmpresa(corpo); return comEstado(quem); });
  rota('PUT', '/api/config/impressora', GERENTE, async ({ quem, corpo }) => { await B.salvarImpressora(corpo); return comEstado(quem); });
  rota('PUT', '/api/config/fiscal', GERENTE, async ({ quem, corpo }) => { await B.salvarChecklist(corpo.checklist); return comEstado(quem); });

  // usuários (gerente)
  rota('GET', '/api/usuarios', GERENTE, async () => ({ usuarios: await B.listarUsuarios() }));
  rota('POST', '/api/usuarios', GERENTE, async ({ corpo }) => { await B.criarUsuario(corpo); return { ok: true, usuarios: await B.listarUsuarios() }; });
  rota('PATCH', '/api/usuarios/:id', GERENTE, async ({ quem, corpo, p }) => { await B.alterarUsuario(Number(p.id), corpo, quem); return { ok: true, usuarios: await B.listarUsuarios() }; });

  // cópia de segurança (gerente)
  rota('GET', '/api/backup', GERENTE, async ({ res }) => {
    const txt = JSON.stringify(await B.exportar());
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="altos-sabores-backup-${new Date().toISOString().slice(0, 10)}.json"`, 'Cache-Control': 'no-store' });
    res.end(txt);
    return null;
  });

  /* ---------- arquivos da tela (no modo local; na Vercel quem serve é a própria Vercel) ---------- */
  function servirArquivo(req, res, url) {
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/') rel = '/index.html';
    const arq = path.normalize(path.join(PUBLICO, rel));
    if (!arq.startsWith(PUBLICO + path.sep)) { res.writeHead(403); return res.end(); }
    fs.readFile(arq, (erro, dados) => {
      if (erro) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Não encontrado'); }
      res.writeHead(200, { 'Content-Type': TIPOS[path.extname(arq)] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin' });
      res.end(dados);
    });
  }

  async function handler(req, res) {
    const url = new URL(req.url, 'http://local');
    if (!url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
      return servirArquivo(req, res, url);
    }
    try {
      const r = rotas.find(x => x.metodo === req.method && x.re.test(url.pathname));
      if (!r) throw new ErroUso('Rota não encontrada.', 404);
      // proteção contra envio a partir de outro site: alterações só com JSON e da mesma origem
      if (req.method !== 'GET') {
        if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw new ErroUso('Envio inválido.', 415);
        const origem = req.headers.origin;
        if (origem && new URL(origem).host !== (req.headers['x-forwarded-host'] || req.headers.host)) throw new ErroUso('Origem não permitida.', 403);
      }
      const quem = await B.usuarioDaSessao(cookies(req)[COOKIE]);
      if (!r.publica && !quem) throw new ErroUso('Entre com seu e-mail e senha.', 401);
      if (r.gerente && quem.perfil !== 'gerente') throw new ErroUso('Só o gerente pode fazer isso.', 403);
      const p = Object.fromEntries(r.nomes.map((n, k) => [n, decodeURIComponent(url.pathname.match(r.re)[k + 1])]));
      const corpo = req.method === 'GET' ? {} : await lerCorpo(req);
      const saida = await r.fn({ req, res, quem, corpo, p });
      if (saida === null) return;
      const { _cookie, ...resto } = saida;
      json(res, 200, resto, _cookie ? { 'Set-Cookie': _cookie } : {});
    } catch (e) {
      if (e instanceof ErroUso) return json(res, e.status, { erro: e.message });
      const m = String(e.message);
      if (/comanda_aberta_unica|UNIQUE constraint failed: comandas/.test(m)) return json(res, 409, { erro: 'Essa comanda já está aberta em outro computador. Atualize a tela.' });
      if (/um_caixa_aberto|UNIQUE constraint failed: caixas/.test(m)) return json(res, 409, { erro: 'O caixa já foi aberto em outro computador.' });
      if (/usuarios_email_key|UNIQUE constraint failed: usuarios/.test(m)) return json(res, 409, { erro: 'Já existe um usuário com esse e-mail.' });
      console.error(new Date().toISOString(), req.method, url.pathname, e);
      json(res, 500, { erro: 'Erro inesperado no servidor. Tente de novo.' });
    }
  }
  return { handler, banco: B, modo: nuvem ? 'nuvem' : 'local', fechar: () => B.fechar() };
}

/* servidor HTTP para o modo local (e para os testes) */
async function criarServidor(opcoes) {
  const app = await criarApp(opcoes);
  const s = http.createServer(app.handler);
  s.banco = app.banco;
  s.on('close', () => app.fechar());
  return s;
}

module.exports = { criarApp, criarServidor };

if (require.main === module) {
  const porta = Number(process.env.PORTA || 3000);
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  criarServidor(url ? { url, codigoPrimeiroAcesso: process.env.CODIGO_PRIMEIRO_ACESSO } : { arquivo: process.env.BANCO || path.join(__dirname, 'dados', 'restaurante.db') }).then(s => s.listen(porta, '0.0.0.0', () => {
    const ips = Object.values(os.networkInterfaces()).flat().filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address);
    console.log('\n  Altos Sabores · sistema de caixa no ar');
    console.log(`  Neste computador:      http://localhost:${porta}`);
    ips.forEach(ip => console.log(`  Outros computadores:   http://${ip}:${porta}`));
    console.log('\n  Deixe esta janela aberta enquanto o restaurante estiver funcionando.\n');
  })).catch(e => { console.error('Não consegui iniciar:', e.message); process.exit(1); });
}

'use strict';
/* Servidor do sistema de caixa Altos Sabores.
   Roda no computador do caixa; outros computadores da rede (ex.: a balança) abrem pelo navegador.
   Uso: node --no-warnings servidor.js   (porta padrão 3000; banco em ./dados/restaurante.db) */
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { abrirBanco, ErroUso } = require('./banco');

const PUBLICO = path.join(__dirname, 'public');
const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const COOKIE = 'as_sessao';
const HORAS_SESSAO = 12;

function criarServidor({ arquivoBanco = path.join(__dirname, 'dados', 'restaurante.db') } = {}) {
  const B = abrirBanco(arquivoBanco);

  /* ---------- limite de tentativas de login (por e-mail + IP) ---------- */
  const tentativas = new Map();
  const chaveTent = (req, email) => `${ipDe(req)}|${String(email || '').toLowerCase()}`;
  function bloqueado(chave) {
    const t = tentativas.get(chave);
    if (!t) return 0;
    if (Date.now() - t.desde > 10 * 60e3) { tentativas.delete(chave); return 0; }
    return t.n >= 5 ? Math.ceil((t.desde + 10 * 60e3 - Date.now()) / 60e3) : 0;
  }
  const falhou = chave => { const t = tentativas.get(chave) || { n: 0, desde: Date.now() }; t.n++; tentativas.set(chave, t); };

  /* ---------- utilidades HTTP ---------- */
  const ipDe = req => req.socket.remoteAddress || '';
  const ehLocal = req => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ipDe(req));
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
  const cookieSessao = token => `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${HORAS_SESSAO * 3600}`;
  const cookieApagar = `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;

  /* ---------- rotas ---------- */
  const rotas = [];
  const rota = (metodo, padrao, opcoes, fn) => {
    const nomes = [];
    const re = new RegExp('^' + padrao.replace(/:(\w+)/g, (_, n) => { nomes.push(n); return '([^/]+)'; }) + '$');
    rotas.push({ metodo, re, nomes, fn, ...opcoes });
  };
  const ABERTA = { publica: true }, LOGADO = {}, GERENTE = { gerente: true };
  /* respostas de alteração devolvem a foto atualizada para a tela redesenhar */
  const comEstado = (quem, extra = {}) => ({ ok: true, ...extra, estado: B.estado(quem) });

  // login e primeiro acesso
  rota('GET', '/api/auth/estado', ABERTA, ({ quem, req }) => ({ temUsuarios: B.temUsuarios(), usuario: quem ? { id: quem.id, nome: quem.nome, email: quem.email, perfil: quem.perfil } : null, local: ehLocal(req) }));
  rota('POST', '/api/auth/primeiro-acesso', ABERTA, ({ req, corpo }) => {
    if (!ehLocal(req)) throw new ErroUso('O primeiro acesso só pode ser criado no computador onde o sistema está instalado.', 403);
    const id = B.criarPrimeiroGerente(corpo);
    return { _cookie: cookieSessao(B.criarSessao(id, HORAS_SESSAO)), ok: true };
  });
  rota('POST', '/api/auth/login', ABERTA, ({ req, corpo }) => {
    const chave = chaveTent(req, corpo.email);
    const espera = bloqueado(chave);
    if (espera) throw new ErroUso(`Muitas tentativas erradas. Espere ${espera} min e tente de novo.`, 429);
    const u = B.login(corpo.email, corpo.senha);
    if (!u) { falhou(chave); throw new ErroUso('E-mail ou senha incorretos.', 401); }
    tentativas.delete(chave);
    return { _cookie: cookieSessao(B.criarSessao(u.id, HORAS_SESSAO)), ok: true };
  });
  rota('POST', '/api/auth/sair', ABERTA, ({ req }) => { B.encerrarSessao(cookies(req)[COOKIE]); return { _cookie: cookieApagar, ok: true }; });
  rota('PUT', '/api/conta/senha', LOGADO, ({ quem, corpo }) => { B.trocarSenha(quem.id, corpo.atual, corpo.nova); return { ok: true }; });

  // leitura
  rota('GET', '/api/estado', LOGADO, ({ quem }) => B.estado(quem));
  rota('GET', '/api/versao', LOGADO, () => ({ versao: B.versao() }));

  // comandas e balança
  rota('POST', '/api/comandas', LOGADO, ({ quem, corpo }) => { const r = B.abrirComanda(corpo.numero, quem); return comEstado(quem, r); });
  rota('POST', '/api/balanca', LOGADO, ({ quem, corpo }) => {
    const r = B.pesarNaBalanca(corpo.numero, corpo.gramas, quem);
    const e = B.estado(quem), c = e.comandas.find(x => x.id === r.comandaId);
    return { ok: true, nova: r.nova, comandaId: r.comandaId, item: c.itens.find(i => i.id === r.itemId), estado: e };
  });
  rota('POST', '/api/comandas/:id/itens', LOGADO, ({ quem, corpo, p }) => comEstado(quem, { itemId: B.adicionarItem(p.id, corpo, quem) }));
  rota('PATCH', '/api/itens/:id', LOGADO, ({ quem, corpo, p }) => { B.mudarQtd(p.id, corpo.qtd); return comEstado(quem); });
  rota('DELETE', '/api/itens/:id', LOGADO, ({ quem, corpo, p }) => { B.removerItem(p.id, corpo.acao, quem); return comEstado(quem); });
  rota('DELETE', '/api/comandas/:id', LOGADO, ({ quem, p }) => { B.descartarVazia(p.id); return comEstado(quem); });
  rota('POST', '/api/comandas/:id/cancelar', LOGADO, ({ quem, corpo, p }) => { B.cancelarComanda(p.id, corpo.motivo, corpo.senhaGerente, quem); return comEstado(quem); });
  rota('POST', '/api/comandas/:id/reabrir', LOGADO, ({ quem, corpo, p }) => { B.reabrirComanda(p.id, corpo.motivo, corpo.senhaGerente, quem); return comEstado(quem); });
  rota('POST', '/api/comandas/:id/pagar', LOGADO, ({ quem, corpo, p }) => comEstado(quem, { trocoCents: B.pagarComanda(p.id, corpo.pagamentos, corpo.cpf, quem) }));

  // caixa
  rota('POST', '/api/caixa/abrir', LOGADO, ({ quem, corpo }) => { B.abrirCaixa(corpo.fundoCents, quem); return comEstado(quem); });
  rota('POST', '/api/caixa/movimentos', LOGADO, ({ quem, corpo }) => comEstado(quem, { id: B.movimentarCaixa(corpo.tipo, corpo.valorCents, corpo.motivo, quem) }));
  rota('POST', '/api/caixa/fechar', LOGADO, ({ quem, corpo }) => comEstado(quem, { fechamento: B.fecharCaixa(corpo.contado, quem) }));

  // produtos e categorias (gerente)
  rota('POST', '/api/produtos', GERENTE, ({ quem, corpo }) => comEstado(quem, { id: B.criarProduto(corpo) }));
  rota('POST', '/api/produtos/exemplo', GERENTE, ({ quem }) => { B.carregarExemplos(); return comEstado(quem); });
  rota('PUT', '/api/produtos/:id', GERENTE, ({ quem, corpo, p }) => { B.editarProduto(p.id, corpo); return comEstado(quem); });
  rota('PATCH', '/api/produtos/:id', GERENTE, ({ quem, corpo, p }) => { B.editarProduto(p.id, corpo); return comEstado(quem); });
  rota('DELETE', '/api/produtos/:id', GERENTE, ({ quem, p }) => { B.excluirProduto(p.id); return comEstado(quem); });
  rota('POST', '/api/categorias', GERENTE, ({ quem, corpo }) => comEstado(quem, { id: B.criarCategoria(corpo) }));
  rota('PUT', '/api/categorias/:id', GERENTE, ({ quem, corpo, p }) => { B.editarCategoria(p.id, corpo); return comEstado(quem); });
  rota('DELETE', '/api/categorias/:id', GERENTE, ({ quem, p }) => { B.excluirCategoria(p.id); return comEstado(quem); });

  // configurações (gerente)
  rota('PUT', '/api/config/preco-kg', GERENTE, ({ quem, corpo }) => { B.mudarPrecoKg(corpo.precoKgCents, quem); return comEstado(quem); });
  rota('PUT', '/api/config/empresa', GERENTE, ({ quem, corpo }) => { B.salvarEmpresa(corpo); return comEstado(quem); });
  rota('PUT', '/api/config/impressora', GERENTE, ({ quem, corpo }) => { B.salvarImpressora(corpo); return comEstado(quem); });
  rota('PUT', '/api/config/fiscal', GERENTE, ({ quem, corpo }) => { B.salvarChecklist(corpo.checklist); return comEstado(quem); });

  // usuários (gerente)
  rota('GET', '/api/usuarios', GERENTE, () => ({ usuarios: B.listarUsuarios() }));
  rota('POST', '/api/usuarios', GERENTE, ({ corpo }) => { B.criarUsuario(corpo); return { ok: true, usuarios: B.listarUsuarios() }; });
  rota('PATCH', '/api/usuarios/:id', GERENTE, ({ quem, corpo, p }) => { B.alterarUsuario(Number(p.id), corpo, quem); return { ok: true, usuarios: B.listarUsuarios() }; });

  // cópia de segurança do banco (gerente)
  rota('GET', '/api/backup', GERENTE, ({ res }) => {
    const tmp = path.join(os.tmpdir(), `altos-sabores-backup-${process.pid}-${Date.now()}.db`);
    B.backup(tmp);
    const nome = `altos-sabores-${new Date().toISOString().slice(0, 10)}.db`;
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${nome}"`, 'Cache-Control': 'no-store' });
    fs.createReadStream(tmp).on('close', () => fs.rm(tmp, { force: true }, () => {})).pipe(res);
    return null;
  });

  /* ---------- arquivos da tela ---------- */
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

  const servidor = http.createServer(async (req, res) => {
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
        if (origem && new URL(origem).host !== req.headers.host) throw new ErroUso('Origem não permitida.', 403);
      }
      const quem = B.usuarioDaSessao(cookies(req)[COOKIE]);
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
      if (/UNIQUE constraint failed: comandas/.test(e.message)) return json(res, 409, { erro: 'Essa comanda já está aberta em outro computador. Atualize a tela.' });
      if (/UNIQUE constraint failed: caixas/.test(e.message)) return json(res, 409, { erro: 'O caixa já foi aberto em outro computador.' });
      console.error(new Date().toISOString(), req.method, url.pathname, e);
      json(res, 500, { erro: 'Erro inesperado no servidor. Tente de novo.' });
    }
  });
  servidor.banco = B;
  servidor.on('close', () => B.fechar());
  return servidor;
}

module.exports = { criarServidor };

if (require.main === module) {
  const porta = Number(process.env.PORTA || 3000);
  const s = criarServidor({ arquivoBanco: process.env.BANCO || path.join(__dirname, 'dados', 'restaurante.db') });
  s.listen(porta, '0.0.0.0', () => {
    const ips = Object.values(os.networkInterfaces()).flat().filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address);
    console.log('\n  Altos Sabores · sistema de caixa no ar');
    console.log(`  Neste computador:      http://localhost:${porta}`);
    ips.forEach(ip => console.log(`  Outros computadores:   http://${ip}:${porta}`));
    console.log('\n  Deixe esta janela aberta enquanto o restaurante estiver funcionando.\n');
  });
}

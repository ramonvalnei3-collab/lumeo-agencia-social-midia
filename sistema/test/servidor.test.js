'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { criarServidor } = require('../servidor');

let srv, base;
before(async () => {
  srv = criarServidor({ arquivoBanco: ':memory:' });
  await new Promise(ok => srv.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${srv.address().port}`;
});
after(() => new Promise(ok => srv.close(ok)));

/* cliente com cookie próprio, como um navegador */
function cliente() {
  let cookie = '';
  return async (metodo, url, corpo) => {
    const r = await fetch(base + url, { method: metodo, headers: { ...(corpo !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body: corpo !== undefined ? JSON.stringify(corpo) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    return { status: r.status, d: await r.json().catch(() => ({})) };
  };
}
const gerente = cliente(), operador = cliente(), anonimo = cliente();
const SENHA_G = 'senha-do-gerente-1', SENHA_O = 'senha-operador-22';

test('sem login a API recusa', async () => {
  const r = await anonimo('GET', '/api/estado');
  assert.equal(r.status, 401);
  assert.equal((await anonimo('GET', '/api/auth/estado')).d.temUsuarios, false);
});

test('primeiro acesso cria o gerente uma única vez', async () => {
  assert.equal((await gerente('POST', '/api/auth/primeiro-acesso', { nome: 'Gerente', email: 'gerente@exemplo.com', senha: 'curta' })).status, 400);
  const r = await gerente('POST', '/api/auth/primeiro-acesso', { nome: 'Gerente', email: 'Gerente@Exemplo.com', senha: SENHA_G });
  assert.equal(r.status, 200);
  assert.equal((await anonimo('POST', '/api/auth/primeiro-acesso', { nome: 'Outro', email: 'x@exemplo.com', senha: 'qualquer-senha-1' })).status, 409);
  const e = await gerente('GET', '/api/estado');
  assert.equal(e.d.usuario.perfil, 'gerente');
  assert.equal(e.d.usuario.email, 'gerente@exemplo.com');
});

test('senha fica guardada embaralhada, nunca em texto', async () => {
  const linha = srv.banco.db.prepare('SELECT senha_hash FROM usuarios').get();
  assert.ok(linha.senha_hash.startsWith('scrypt$'));
  assert.ok(!linha.senha_hash.includes(SENHA_G));
});

test('gerente cria operador; operador entra e não mexe em configurações', async () => {
  assert.equal((await gerente('POST', '/api/usuarios', { nome: 'Ana', email: 'ana@exemplo.com', perfil: 'operador', senha: SENHA_O })).status, 200);
  assert.equal((await operador('POST', '/api/auth/login', { email: 'ana@exemplo.com', senha: 'errada-123' })).status, 401);
  assert.equal((await operador('POST', '/api/auth/login', { email: 'ANA@exemplo.com', senha: SENHA_O })).status, 200);
  assert.equal((await operador('PUT', '/api/config/preco-kg', { precoKgCents: 100 })).status, 403);
  assert.equal((await operador('POST', '/api/produtos', { nome: 'X', cat: 'Bebida', precoCents: 100 })).status, 403);
  assert.equal((await operador('GET', '/api/usuarios')).status, 403);
});

test('login bloqueia depois de 5 tentativas erradas', async () => {
  const c = cliente();
  for (let i = 0; i < 5; i++) assert.equal((await c('POST', '/api/auth/login', { email: 'alvo@exemplo.com', senha: 'nao-e-essa' })).status, 401);
  assert.equal((await c('POST', '/api/auth/login', { email: 'alvo@exemplo.com', senha: 'nao-e-essa' })).status, 429);
});

test('envio que não é JSON é recusado (proteção contra outro site)', async () => {
  const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'email=a&senha=b' });
  assert.equal(r.status, 415);
});

let produtoId, comandaId;
test('produtos: cadastro, código único e exemplos', async () => {
  const r = await gerente('POST', '/api/produtos', { nome: 'Refri lata', cat: 'Bebida', precoCents: 600, codigo: '101' });
  assert.equal(r.status, 200); produtoId = r.d.id;
  assert.equal((await gerente('POST', '/api/produtos', { nome: 'Outro', cat: 'Bebida', precoCents: 500, codigo: '101' })).status, 409);
  assert.equal((await gerente('POST', '/api/produtos', { nome: 'Sem preço', cat: 'Bebida', precoCents: 0 })).status, 400);
  assert.equal((await gerente('POST', '/api/produtos/exemplo', {})).status, 409);
});

test('balança: abre a comanda e calcula 507 g × R$ 95,00 = R$ 48,17 no servidor', async () => {
  const r = await operador('POST', '/api/balanca', { numero: 12, gramas: 507 });
  assert.equal(r.status, 200);
  assert.equal(r.d.nova, true);
  assert.equal(r.d.item.totalCents, 4817);
  comandaId = r.d.comandaId;
  const r2 = await operador('POST', '/api/balanca', { numero: 12, gramas: 380 });
  assert.equal(r2.d.nova, false);
  assert.equal(r2.d.item.totalCents, 3610);
  assert.equal((await operador('POST', '/api/balanca', { numero: 12, gramas: 9000 })).status, 400);
});

test('itens: produto soma quantidade; preço vem do cadastro, não da tela', async () => {
  await operador('POST', `/api/comandas/${comandaId}/itens`, { tipo: 'un', produtoId, precoCents: 1 });
  const r = await operador('POST', `/api/comandas/${comandaId}/itens`, { tipo: 'un', produtoId });
  const c = r.d.estado.comandas.find(x => x.id === comandaId);
  const refri = c.itens.find(i => i.produtoId === produtoId);
  assert.equal(refri.qtd, 2);
  assert.equal(refri.totalCents, 1200);
  assert.equal(c.itens.reduce((s, i) => s + i.totalCents, 0), 4817 + 3610 + 1200);
});

test('pagamento: exige caixa aberto, valida troco e fecha a comanda', async () => {
  assert.equal((await operador('POST', `/api/comandas/${comandaId}/pagar`, { pagamentos: [{ forma: 'pix', valorCents: 9627 }] })).status, 409);
  assert.equal((await operador('POST', '/api/caixa/abrir', { fundoCents: 20000 })).status, 200);
  assert.equal((await operador('POST', '/api/caixa/abrir', { fundoCents: 20000 })).status, 409);
  assert.equal((await operador('POST', `/api/comandas/${comandaId}/pagar`, { pagamentos: [{ forma: 'pix', valorCents: 5000 }] })).status, 400);
  assert.equal((await operador('POST', `/api/comandas/${comandaId}/pagar`, { pagamentos: [{ forma: 'credito', valorCents: 20000 }] })).status, 400);
  const r = await operador('POST', `/api/comandas/${comandaId}/pagar`, { pagamentos: [{ forma: 'pix', valorCents: 5000 }, { forma: 'dinheiro', valorCents: 5000 }] });
  assert.equal(r.status, 200);
  assert.equal(r.d.trocoCents, 373);
  assert.equal(r.d.estado.comandas.find(x => x.id === comandaId).status, 'fechada');
});

test('reabrir e cancelar exigem senha de gerente quando é o operador', async () => {
  assert.equal((await operador('POST', `/api/comandas/${comandaId}/reabrir`, { motivo: 'cliente pediu sobremesa', senhaGerente: 'errada-000' })).status, 403);
  assert.equal((await operador('POST', `/api/comandas/${comandaId}/reabrir`, { motivo: 'cliente pediu sobremesa', senhaGerente: SENHA_G })).status, 200);
  const r = await operador('POST', `/api/comandas/${comandaId}/cancelar`, { motivo: 'teste de cancelamento', senhaGerente: SENHA_G });
  assert.equal(r.status, 200);
  const c = r.d.estado.comandas.find(x => x.id === comandaId);
  assert.equal(c.status, 'cancelada');
  assert.deepEqual(c.log.map(l => l.acao), ['reaberta', 'cancelada']);
  assert.equal(c.log[1].autorizadoPor, 'Gerente');
});

test('fechamento de caixa: dinheiro esperado = fundo + vendas em dinheiro − troco + suprimento − sangria', async () => {
  const b = await operador('POST', '/api/balanca', { numero: 5, gramas: 1000 });   // R$ 95,00
  await operador('POST', `/api/comandas/${b.d.comandaId}/pagar`, { pagamentos: [{ forma: 'dinheiro', valorCents: 10000 }] }); // troco 5,00
  await operador('POST', '/api/caixa/movimentos', { tipo: 'suprimento', valorCents: 5000, motivo: 'moedas' });
  assert.equal((await operador('POST', '/api/caixa/movimentos', { tipo: 'sangria', valorCents: 99999999, motivo: 'cofre' })).status, 400);
  await operador('POST', '/api/caixa/movimentos', { tipo: 'sangria', valorCents: 10000, motivo: 'cofre' });
  // 200 + (100 − 5) + 50 − 100 = 245,00
  const r = await operador('POST', '/api/caixa/fechar', { contado: { dinheiro: 24000 } });
  assert.equal(r.status, 200);
  assert.equal(r.d.fechamento.esperado.dinheiro, 24500);
  assert.equal(r.d.fechamento.diferencaCents, -500);
  assert.equal(r.d.estado.caixa.aberto, false);
});

test('sair encerra a sessão', async () => {
  const c = cliente();
  await c('POST', '/api/auth/login', { email: 'ana@exemplo.com', senha: SENHA_O });
  assert.equal((await c('GET', '/api/versao')).status, 200);
  await c('POST', '/api/auth/sair', {});
  assert.equal((await c('GET', '/api/versao')).status, 401);
});

test('operador desativado perde o acesso na hora', async () => {
  const lista = (await gerente('GET', '/api/usuarios')).d.usuarios;
  const ana = lista.find(u => u.email === 'ana@exemplo.com');
  assert.equal((await gerente('PATCH', `/api/usuarios/${ana.id}`, { ativo: false })).status, 200);
  assert.equal((await operador('GET', '/api/estado')).status, 401);
  const eu = lista.find(u => u.perfil === 'gerente');
  assert.equal((await gerente('PATCH', `/api/usuarios/${eu.id}`, { ativo: false })).status, 400);
});

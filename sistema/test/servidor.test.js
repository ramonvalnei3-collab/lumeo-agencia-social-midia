'use strict';
/* Testes do servidor. Rodam com SQLite (computador do caixa) e, se existir
   TEST_DATABASE_URL, também com Postgres (modo nuvem/Vercel). */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { criarServidor } = require('../servidor');

const CODIGO = 'codigo-primeiro-acesso-teste';
const bancos = [['SQLite (computador do caixa)', { arquivo: ':memory:' }]];
if (process.env.TEST_DATABASE_URL) bancos.push(['Postgres (nuvem)', { url: process.env.TEST_DATABASE_URL, codigoPrimeiroAcesso: CODIGO }]);

for (const [nomeBanco, opcoes] of bancos) describe(nomeBanco, () => {
  const nuvem = !!opcoes.url;
  let srv, base;
  before(async () => {
    srv = await criarServidor(opcoes);
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
      return { status: r.status, d: await r.json().catch(() => ({})), cookie: sc };
    };
  }
  const gerente = cliente(), operador = cliente(), anonimo = cliente();
  const SENHA_G = 'senha-do-gerente-1', SENHA_O = 'senha-operador-22';

  test('sem login a API recusa', async () => {
    assert.equal((await anonimo('GET', '/api/estado')).status, 401);
    const e = (await anonimo('GET', '/api/auth/estado')).d;
    assert.equal(e.temUsuarios, false);
    assert.equal(e.modo, nuvem ? 'nuvem' : 'local');
  });

  test('primeiro acesso cria o gerente uma única vez', async () => {
    const dados = { nome: 'Gerente', email: 'Gerente@Exemplo.com', senha: SENHA_G };
    assert.equal((await gerente('POST', '/api/auth/primeiro-acesso', { ...dados, senha: 'curta', codigo: CODIGO })).status, 400);
    if (nuvem) assert.equal((await gerente('POST', '/api/auth/primeiro-acesso', { ...dados, codigo: 'chute-errado' })).status, 403);
    const r = await gerente('POST', '/api/auth/primeiro-acesso', { ...dados, codigo: CODIGO });
    assert.equal(r.status, 200);
    assert.equal(r.cookie.includes('Secure'), nuvem, 'cookie seguro (https) só na nuvem');
    assert.equal((await anonimo('POST', '/api/auth/primeiro-acesso', { nome: 'Outro', email: 'x@exemplo.com', senha: 'qualquer-senha-1', codigo: CODIGO })).status, 409);
    const e = await gerente('GET', '/api/estado');
    assert.equal(e.d.usuario.perfil, 'gerente');
    assert.equal(e.d.usuario.email, 'gerente@exemplo.com');
  });

  test('senha fica guardada embaralhada, nunca em texto', async () => {
    const linha = await srv.banco.consulta('SELECT senha_hash FROM usuarios');
    assert.ok(linha.senha_hash.startsWith('scrypt$'));
    assert.ok(!linha.senha_hash.includes(SENHA_G));
  });

  test('gerente cria operador; operador entra e não mexe em configurações', async () => {
    assert.equal((await gerente('POST', '/api/usuarios', { nome: 'Ana', email: 'ana@exemplo.com', perfil: 'operador', senha: SENHA_O })).status, 200);
    assert.equal((await gerente('POST', '/api/usuarios', { nome: 'Ana 2', email: 'ANA@exemplo.com', perfil: 'operador', senha: SENHA_O })).status, 409);
    assert.equal((await operador('POST', '/api/auth/login', { email: 'ana@exemplo.com', senha: 'errada-123' })).status, 401);
    assert.equal((await operador('POST', '/api/auth/login', { email: 'ANA@exemplo.com', senha: SENHA_O })).status, 200);
    assert.equal((await operador('PUT', '/api/config/preco-kg', { precoKgCents: 100 })).status, 403);
    assert.equal((await operador('POST', '/api/produtos', { nome: 'X', cat: 'Bebida', precoCents: 100 })).status, 403);
    assert.equal((await operador('GET', '/api/usuarios')).status, 403);
    assert.equal((await operador('GET', '/api/backup')).status, 403);
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
    assert.equal((await gerente('PATCH', `/api/produtos/${produtoId}`, { precoCents: 650 })).status, 200);
    assert.equal((await gerente('PATCH', `/api/produtos/${produtoId}`, { precoCents: 600 })).status, 200);
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

  test('duas balanças abrindo a mesma comanda ao mesmo tempo não duplicam', async () => {
    const rs = await Promise.all([1, 2, 3].map(() => operador('POST', '/api/balanca', { numero: 77, gramas: 300 })));
    rs.forEach(r => assert.equal(r.status, 200));
    const e = (await operador('GET', '/api/estado')).d;
    const c77 = e.comandas.filter(c => c.numero === 77 && c.status === 'aberta');
    assert.equal(c77.length, 1);
    assert.equal(c77[0].itens.length, 3);
    await operador('POST', `/api/comandas/${c77[0].id}/cancelar`, { motivo: 'limpeza do teste', senhaGerente: SENHA_G });
  });

  test('itens: produto soma quantidade; preço vem do cadastro, não da tela', async () => {
    await operador('POST', `/api/comandas/${comandaId}/itens`, { tipo: 'un', produtoId, precoCents: 1 });
    const r = await operador('POST', `/api/comandas/${comandaId}/itens`, { tipo: 'un', produtoId });
    const c = r.d.estado.comandas.find(x => x.id === comandaId);
    const refri = c.itens.find(i => i.produtoId === produtoId);
    assert.equal(refri.qtd, 2);
    assert.equal(refri.totalCents, 1200);
    assert.equal(c.itens.reduce((s, i) => s + i.totalCents, 0), 4817 + 3610 + 1200);
    const r3 = await operador('PATCH', `/api/itens/${refri.id}`, { qtd: 3 });
    assert.equal(r3.d.estado.comandas.find(x => x.id === comandaId).itens.find(i => i.id === refri.id).totalCents, 1800);
    await operador('PATCH', `/api/itens/${refri.id}`, { qtd: 2 });
  });

  test('pagamento: exige caixa aberto, valida troco e fecha a comanda', async () => {
    assert.equal((await operador('POST', `/api/comandas/${comandaId}/pagar`, { pagamentos: [{ forma: 'pix', valorCents: 9627 }] })).status, 409);
    assert.equal((await operador('POST', '/api/caixa/abrir', { fundoCents: 20000 })).status, 200);
    assert.equal((await operador('POST', '/api/caixa/abrir', { fundoCents: 20000 })).status, 409);
    assert.equal((await operador('POST', `/api/comandas/${comandaId}/pagar`, { pagamentos: [{ forma: 'pix', valorCents: 5000 }] })).status, 400);
    assert.equal((await operador('POST', `/api/comandas/${comandaId}/pagar`, { pagamentos: [{ forma: 'credito', valorCents: 20000 }] })).status, 400);
    const pags = [{ forma: 'pix', valorCents: 5000 }, { forma: 'dinheiro', valorCents: 5000 }];
    assert.equal((await operador('POST', `/api/comandas/${comandaId}/pagar`, { pagamentos: pags, cpf: '63.062.421/0001-67' })).status, 400, 'NFC-e não aceita CNPJ');
    assert.equal((await operador('POST', `/api/comandas/${comandaId}/pagar`, { pagamentos: pags, cpf: '123.456.789-00' })).status, 400, 'CPF com dígito errado');
    const r = await operador('POST', `/api/comandas/${comandaId}/pagar`, { pagamentos: pags, cpf: '529.982.247-25' });
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
    // conferência parcial (sem fechar)
    const parc = (await operador('GET', '/api/caixa/relatorio')).d.relatorio;
    assert.equal(parc.parcial, true);
    assert.equal(parc.dinheiro.esperadoCents, 24500);
    // 200 + (100 − 5) + 50 − 100 = 245,00
    const r = await operador('POST', '/api/caixa/fechar', { contado: { dinheiro: 24000 }, observacao: 'faltou troco de 5 reais', contagem: { 10000: 2, 2000: 2, 999: 3 } });
    const rel = r.d.relatorio;
    assert.equal(rel.parcial, false);
    assert.equal(rel.dinheiro.fundoCents, 20000);
    assert.equal(rel.dinheiro.recebidoCents, 10000);
    assert.equal(rel.dinheiro.trocoCents, 500);
    assert.equal(rel.dinheiro.suprimentosCents, 5000);
    assert.equal(rel.dinheiro.sangriasCents, 10000);
    assert.equal(rel.dinheiro.contadoCents, 24000);
    assert.equal(rel.movimentos.length, 2);
    assert.equal(rel.totais.comandas, 1);
    assert.equal(rel.totais.pratos, 1);
    assert.equal(rel.canceladas.length, 1, 'a comanda 12 foi cancelada com o caixa aberto');
    assert.ok(rel.ocorrencias.some(o => o.acao === 'reaberta'));
    assert.equal(rel.caixa.observacao, 'faltou troco de 5 reais');
    assert.deepEqual(rel.caixa.contagem, { 10000: 2, 2000: 2 }, 'só guarda notas que existem');
    const antigo = (await gerente('GET', `/api/caixas/${rel.caixa.id}/relatorio`)).d.relatorio;
    assert.equal(antigo.totais.diferencaCents, -500);
    assert.equal(r.status, 200);
    assert.equal(r.d.fechamento.esperado.dinheiro, 24500);
    assert.equal(r.d.fechamento.diferencaCents, -500);
    assert.equal(r.d.estado.caixa.aberto, false);
    assert.equal(r.d.estado.fechamentos.length, 1);
  });

  test('backup do gerente traz as tabelas, sem sessões nem senhas em texto', async () => {
    const g2 = cliente();
    await g2('POST', '/api/auth/login', { email: 'gerente@exemplo.com', senha: SENHA_G });
    const b = await g2('GET', '/api/backup');
    assert.equal(b.status, 200);
    assert.ok(b.d.dados.comandas.length >= 2);
    assert.ok(!('sessoes' in b.d.dados));
    assert.ok(!JSON.stringify(b.d).includes(SENHA_G));
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
});

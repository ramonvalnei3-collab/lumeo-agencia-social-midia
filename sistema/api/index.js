'use strict';
/* Entrada do sistema na Vercel: todas as rotas /api/... caem aqui (veja vercel.json).
   O banco é o Postgres da variável DATABASE_URL (criada pela integração Neon da Vercel). */
const { criarApp } = require('../servidor');

let pronto = null;
function app() {
  if (!pronto) {
    const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
    if (!url) return Promise.reject(new Error('Falta o banco de dados: conecte um Postgres (Neon) ao projeto na Vercel.'));
    pronto = criarApp({ url, codigoPrimeiroAcesso: process.env.CODIGO_PRIMEIRO_ACESSO }).catch(e => { pronto = null; throw e; });
  }
  return pronto;
}

module.exports = async (req, res) => {
  try {
    const a = await app();
    await a.handler(req, res);
  } catch (e) {
    console.error(e);
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ erro: e.message.startsWith('Falta o banco') ? e.message : 'O sistema não conseguiu falar com o banco de dados. Tente de novo em instantes.' }));
  }
};

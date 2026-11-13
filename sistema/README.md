# Sistema de caixa · Altos Sabores

O mesmo sistema roda de dois jeitos:

| | **Na internet (Vercel)** | **No computador do caixa** |
|---|---|---|
| Abre de onde | Qualquer lugar, com o endereço do site | Só nos computadores da rede do restaurante |
| Banco de dados | Postgres na nuvem (Neon) | Arquivo `dados/restaurante.db` |
| Sem internet | **Não funciona** | Funciona |
| Custo | Vercel Pro (US$ 20/mês, uso comercial) + Neon (grátis no começo) | Só o computador |

## Publicar na Vercel (passo a passo)

1. Entre em **vercel.com** com a sua conta do GitHub.
2. **Add New → Project** → escolha o repositório `lumeo-agencia-social-midia` → **Import**.
3. Em **Root Directory**, clique em *Edit* e escolha a pasta **`sistema`**. Framework: *Other*. Clique em **Deploy**.
   (O primeiro deploy vai abrir o site com o aviso "Falta o banco de dados"; é normal.)
4. No projeto, aba **Storage → Create Database → Neon (Postgres)**. Escolha a região **São Paulo (sa-east-1)**
   e conecte ao projeto. A Vercel cria sozinha a variável `DATABASE_URL`.
5. Aba **Settings → Environment Variables**: crie **`CODIGO_PRIMEIRO_ACESSO`** com uma senha só sua
   (pelo menos 8 caracteres). Ela serve só para criar o primeiro gerente.
6. Aba **Deployments** → nos três pontinhos do último deploy → **Redeploy**.
7. Abra o endereço do site (algo como `altos-sabores.vercel.app`): aparece **Primeiro acesso**.
   Digite o código do passo 5, seu nome, e-mail e senha. Pronto.

Depois disso, todo envio para o GitHub atualiza o site sozinho.

**Atenção:**
- O plano grátis da Vercel (Hobby) é só para uso pessoal, sem fins comerciais. Para o restaurante use o **Pro**.
- Na nuvem, se a internet do restaurante cair, o sistema para até ela voltar. Tenha um plano B
  (por exemplo, internet do celular roteada) ou use o modo do computador do caixa.
- A impressora térmica fica no restaurante; a impressão automática vai precisar de um pequeno programa
  no computador do caixa (próxima etapa).

## Instalar no computador do caixa (sem internet)

1. Instale o **Node.js** versão 22.13 ou mais nova: <https://nodejs.org> (botão "LTS").
2. Copie esta pasta `sistema` para o computador, por exemplo em `C:\AltosSabores\sistema`.
3. Dê dois cliques em **`iniciar.bat`**. Vai abrir uma janela preta mostrando os endereços.
4. No navegador do caixa, abra **http://localhost:3000**.
5. Na primeira vez aparece **Primeiro acesso**: crie o login do gerente (nome, e-mail e senha).
   Só funciona no próprio computador do caixa.

Não precisa instalar mais nada: o banco de dados e a criptografia das senhas já vêm no Node.js.

## Usar todo dia

- Ligue o computador do caixa e dê dois cliques em `iniciar.bat`. Deixe a janela preta aberta.
- **Balança ou outro computador:** abra o endereço "Outros computadores" que aparece na janela preta
  (ex.: `http://192.168.0.10:3000`). Para não mudar, peça um IP fixo para o computador do caixa no roteador.
- Cada funcionário entra com o próprio e-mail e senha. O gerente cria os logins em
  **Configurações → Usuários**.

## Perfis

| Perfil | Pode |
|---|---|
| Operador | Balança, comandas, receber, abrir/fechar caixa, sangria, suprimento, pesquisar, relatório. Cancelar ou reabrir comanda só com a senha de um gerente. |
| Gerente | Tudo, mais produtos, preço do quilo, empresa, impressora, nota fiscal, usuários e backup. |

## Segurança

- Senhas guardadas com **scrypt** (embaralhadas com sal); ninguém consegue ler a senha no banco.
- Login bloqueia por 10 minutos depois de 5 tentativas erradas.
- Sessão dura 12 horas; usuário desativado perde o acesso na hora.
- Preços, troco e fechamento de caixa são calculados no servidor, não na tela.
- O certificado digital (.pfx) e a senha dele **não** ficam neste sistema nem no GitHub.

## Backup

Em **Configurações → Backup** o gerente baixa uma cópia (arquivo .json). Faça toda semana e guarde fora do computador.
Na nuvem, a Neon também guarda o histórico do banco e permite voltar para um horário anterior.

## Para quem programa

```
npm install  # só precisa para o modo nuvem (driver do Postgres)
npm test     # testes no SQLite; com TEST_DATABASE_URL=postgres://... roda também no Postgres
npm start    # sobe em http://localhost:3000 (SQLite); com DATABASE_URL sobe usando o Postgres
```

- `servidor.js`: HTTP, login, sessões e rotas `/api/...` (`criarApp` serve os dois modos)
- `api/index.js` + `vercel.json`: entrada na Vercel (região São Paulo, `gru1`)
- `banco.js`: esquema e regras de negócio, iguais nos dois bancos
- `adaptadores.js`: SQLite (`node:sqlite`) e Postgres (`pg`)
- `public/index.html`: a tela

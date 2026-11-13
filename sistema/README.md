# Sistema de caixa · Altos Sabores

Programa que roda no **computador do caixa** e guarda tudo num banco de dados (arquivo `dados/restaurante.db`).
A balança e outros computadores da mesma rede abrem o sistema pelo navegador.

## Instalar (uma vez só, no computador do caixa)

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

Em **Configurações → Backup** o gerente baixa uma cópia do banco. Faça toda semana e guarde fora do computador.

## Para quem programa

```
npm test     # testes do servidor (login, permissões, preços, troco, fechamento de caixa)
npm start    # sobe em http://localhost:3000  (PORTA=8080 npm start para outra porta)
```

- `servidor.js`: HTTP, login, sessões e rotas `/api/...`
- `banco.js`: esquema SQLite (`node:sqlite`) e regras de negócio
- `public/index.html`: a tela

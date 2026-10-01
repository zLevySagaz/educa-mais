# Educa Mais
Requer Node 22.13+ (sem `npm install`: usa apenas módulos nativos, incluindo `node:sqlite`).

    cp .env.example .env   # defina SEED_PASSWORD
    npm start              # http://localhost:3000

Usuários demo (senha = SEED_PASSWORD): ana@, bruno@ (fotografia, publicadores), carla@, diego@ (gamers, publicadores), eva@, filipe@ (membros), todos com final `educamais.local`.

Novo usuário (limite de 7 publicadores por grupo, validado no servidor):

    node server.js add-user "Nome" login@dominio fotografia publisher "senha"

Segurança: senhas com scrypt + salt, sessão por cookie HttpOnly (token aleatório guardado só como hash), permissão de publicar validada no backend, grupo do post definido pela sessão, textos sanitizados e escapados ao renderizar, limite de tentativas de login, CSP.

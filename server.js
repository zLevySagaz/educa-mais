// Educa Mais - servidor sem dependências externas (Node 22.13+ / 24, usa node:sqlite)
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
try { process.loadEnvFile(path.join(__dirname, '.env')); } catch {}

const PORT = process.env.PORT || 3000;
const SECURE = process.env.COOKIE_SECURE === '1' ? '; Secure' : '';
const MAX_PUB = 7;
const GRUPOS = ['fotografia', 'gamers'];

const db = new DatabaseSync(process.env.DB_FILE || path.join(__dirname, 'educa.db'));
db.exec(`PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY,nome TEXT NOT NULL,email TEXT UNIQUE NOT NULL,senha_hash TEXT NOT NULL,
  grupo TEXT NOT NULL CHECK(grupo IN('fotografia','gamers')),role TEXT NOT NULL CHECK(role IN('publisher','member')),
  data_criacao TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id),expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS posts(id INTEGER PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id),grupo TEXT NOT NULL,
  texto TEXT NOT NULL,imagem TEXT,data_criacao TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS likes(post_id INTEGER REFERENCES posts(id),user_id INTEGER REFERENCES users(id),PRIMARY KEY(post_id,user_id));
CREATE TABLE IF NOT EXISTS comments(id INTEGER PRIMARY KEY,post_id INTEGER NOT NULL REFERENCES posts(id),
  user_id INTEGER NOT NULL REFERENCES users(id),texto TEXT NOT NULL,data_criacao TEXT DEFAULT CURRENT_TIMESTAMP);`);

// ---------- segurança ----------
const sha = t => crypto.createHash('sha256').update(t).digest('hex');
const hash = p => { const s = crypto.randomBytes(16); return s.toString('hex') + ':' + crypto.scryptSync(p, s, 64).toString('hex'); };
const check = (p, h) => {
  const [s, k] = h.split(':');
  return crypto.timingSafeEqual(crypto.scryptSync(p, Buffer.from(s, 'hex'), 64), Buffer.from(k, 'hex'));
};
const clean = (s, n) => String(s ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, n);

function addUser(nome, email, senha, grupo, role) {
  if (!GRUPOS.includes(grupo) || !['publisher', 'member'].includes(role)) throw new Error('grupo/role inválido');
  if (role === 'publisher' &&
      db.prepare("SELECT COUNT(*) c FROM users WHERE grupo=? AND role='publisher'").get(grupo).c >= MAX_PUB)
    throw new Error(`Limite de ${MAX_PUB} publicadores no grupo ${grupo}`);
  db.prepare('INSERT INTO users(nome,email,senha_hash,grupo,role) VALUES(?,?,?,?,?)')
    .run(nome, email.toLowerCase(), hash(senha), grupo, role);
}

// CLI: node server.js add-user "Nome" email grupo role senha
if (process.argv[2] === 'add-user') {
  const [nome, email, grupo, role, senha] = process.argv.slice(3);
  try { addUser(nome, email, senha, grupo, role); console.log('Usuário criado.'); } catch (e) { console.error(e.message); process.exit(1); }
  process.exit(0);
}

// ---------- dados de demonstração ----------
function seed() {
  if (db.prepare('SELECT COUNT(*) c FROM users').get().c) return;
  const pw = process.env.SEED_PASSWORD || crypto.randomBytes(6).toString('hex');
  const U = [['Ana Lente', 'ana', 'fotografia', 'publisher'], ['Bruno Foco', 'bruno', 'fotografia', 'publisher'],
    ['Carla Pixel', 'carla', 'gamers', 'publisher'], ['Diego Play', 'diego', 'gamers', 'publisher'],
    ['Eva Visitante', 'eva', 'fotografia', 'member'], ['Filipe Visitante', 'filipe', 'gamers', 'member']];
  U.forEach(u => addUser(u[0], u[1] + '@educamais.local', pw, u[2], u[3]));
  const img = (a, b, t) => 'data:image/svg+xml;utf8,' + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 500"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="800" height="500" fill="url(#g)"/><text x="400" y="270" font-size="48" fill="#fff" text-anchor="middle" font-family="sans-serif">${t}</text></svg>`);
  const P = [[1, 'fotografia', 'Golden hour na serra: ISO 100, f/8 e tripé fizeram toda a diferença. 🌄', img('#f59e0b', '#7c3aed', 'Paisagem')],
    [2, 'fotografia', 'Dica de edição: comece ajustando exposição e balanço de branco antes de mexer nas cores.', null],
    [3, 'gamers', 'Gameplay da semana: finalmente zerei o chefe final sem tomar dano! 🎮', img('#2563eb', '#16a34a', 'Gameplay')],
    [4, 'gamers', 'Notícia: novo update chegando com modo cooperativo. Quem topa jogar junto?', null]];
  P.forEach(p => db.prepare('INSERT INTO posts(user_id,grupo,texto,imagem) VALUES(?,?,?,?)').run(...p));
  [[1, 5, 'Ficou lindo! Qual lente você usou?'], [1, 1, 'Uma 24-70mm, obrigada!'], [3, 6, 'Parabéns! Manda a dica do chefe 😄'],
    [4, 3, 'Eu entro! Sábado à noite?']].forEach(c => db.prepare('INSERT INTO comments(post_id,user_id,texto) VALUES(?,?,?)').run(...c));
  db.prepare('INSERT INTO likes VALUES(1,5),(1,2),(3,6)').run();
  console.log(`\nDados de demonstração criados. Senha de todos os usuários demo: ${pw}`);
  console.log('Logins: ana@ / bruno@ (fotografia, publicadores), carla@ / diego@ (gamers, publicadores),');
  console.log('        eva@ / filipe@ (membros) — todos com final educamais.local\n');
}
seed();

// ---------- helpers HTTP ----------
const send = (res, c, o, h = {}) => { res.writeHead(c, { 'Content-Type': 'application/json', 'X-Content-Type-Options': 'nosniff', ...h }); res.end(JSON.stringify(o)); };
const body = req => new Promise((ok, no) => {
  let d = '';
  req.on('data', c => { d += c; if (d.length > 3e6) { no(new Error('grande')); req.destroy(); } });
  req.on('end', () => { try { ok(JSON.parse(d || '{}')); } catch (e) { no(e); } });
});
function auth(req) {
  const m = /(?:^|; )sid=([a-f0-9]{64})/.exec(req.headers.cookie || '');
  if (!m) return null;
  return db.prepare('SELECT u.id,u.nome,u.email,u.grupo,u.role FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires>?')
    .get(sha(m[1]), Date.now()) || null;
}
function feed(uid, f = {}) {
  const w = [], a = [uid];
  if (f.grupo) { w.push('p.grupo=?'); a.push(f.grupo); }
  if (f.id) { w.push('p.id=?'); a.push(f.id); }
  const rows = db.prepare(`SELECT p.id,p.grupo,p.texto,p.imagem,p.data_criacao,u.nome autor,
    (SELECT COUNT(*) FROM likes WHERE post_id=p.id) curtidas,
    EXISTS(SELECT 1 FROM likes WHERE post_id=p.id AND user_id=?) curtiu
    FROM posts p JOIN users u ON u.id=p.user_id ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY p.id DESC LIMIT 50`).all(...a);
  const cm = db.prepare('SELECT c.texto,c.data_criacao,u.nome,u.grupo FROM comments c JOIN users u ON u.id=c.user_id WHERE c.post_id=? ORDER BY c.id');
  return rows.map(r => ({ ...r, curtiu: !!r.curtiu, comentarios: cm.all(r.id).map(c => ({ ...c })) }));
}

const tries = new Map();
const INDEX = path.join(__dirname, 'public', 'index.html');

http.createServer(async (req, res) => {
  try {
    const p = new URL(req.url, 'http://x').pathname, q = new URL(req.url, 'http://x').searchParams;
    if (!p.startsWith('/api/')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin',
        'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; frame-ancestors 'none'" });
      return res.end(fs.readFileSync(INDEX));
    }
    if (req.method === 'POST' && !(req.headers['content-type'] || '').startsWith('application/json'))
      return send(res, 415, { erro: 'Formato inválido' });

    if (p === '/api/login' && req.method === 'POST') {
      const ip = req.socket.remoteAddress, r = tries.get(ip) || { n: 0, t: Date.now() };
      if (Date.now() - r.t > 9e5) { r.n = 0; r.t = Date.now(); }
      if (r.n >= 10) return send(res, 429, { erro: 'Muitas tentativas. Aguarde alguns minutos.' });
      const b = await body(req);
      const row = db.prepare('SELECT * FROM users WHERE email=?').get(clean(b.email, 120).toLowerCase());
      if (!row || !check(String(b.senha || '').slice(0, 200), row.senha_hash)) {
        r.n++; tries.set(ip, r);
        return send(res, 401, { erro: 'Usuário ou senha incorretos.' });
      }
      db.prepare('DELETE FROM sessions WHERE expires<?').run(Date.now());
      const t = crypto.randomBytes(32).toString('hex');
      db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(sha(t), row.id, Date.now() + 7 * 864e5);
      return send(res, 200, { user: { nome: row.nome, grupo: row.grupo, role: row.role } },
        { 'Set-Cookie': `sid=${t}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800${SECURE}` });
    }

    const me = auth(req);
    if (!me) return send(res, 401, { erro: 'Não autenticado.' });

    if (p === '/api/logout' && req.method === 'POST') {
      const m = /(?:^|; )sid=([a-f0-9]{64})/.exec(req.headers.cookie || '');
      db.prepare('DELETE FROM sessions WHERE token=?').run(sha(m[1]));
      return send(res, 200, { ok: true }, { 'Set-Cookie': `sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${SECURE}` });
    }
    if (p === '/api/me') return send(res, 200, { user: { nome: me.nome, grupo: me.grupo, role: me.role } });

    if (p === '/api/posts' && req.method === 'GET') {
      const g = q.get('grupo');
      return send(res, 200, { posts: feed(me.id, GRUPOS.includes(g) ? { grupo: g } : {}) });
    }
    if (p === '/api/posts' && req.method === 'POST') {
      if (me.role !== 'publisher') return send(res, 403, { erro: 'Você não tem permissão para publicar.' }); // validação no servidor
      const b = await body(req), texto = clean(b.texto, 2000);
      let img = null;
      if (b.imagem) {
        if (typeof b.imagem !== 'string' || b.imagem.length > 2.5e6 || !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(b.imagem))
          return send(res, 400, { erro: 'Imagem inválida ou muito grande.' });
        img = b.imagem;
      }
      if (!texto && !img) return send(res, 400, { erro: 'Escreva um texto ou adicione uma imagem.' });
      const r = db.prepare('INSERT INTO posts(user_id,grupo,texto,imagem) VALUES(?,?,?,?)').run(me.id, me.grupo, texto, img); // grupo vem da sessão
      return send(res, 201, { post: feed(me.id, { id: Number(r.lastInsertRowid) })[0] });
    }
    const m = /^\/api\/posts\/(\d+)\/(like|comments)$/.exec(p);
    if (m && req.method === 'POST') {
      const id = Number(m[1]);
      if (!db.prepare('SELECT 1 FROM posts WHERE id=?').get(id)) return send(res, 404, { erro: 'Publicação não encontrada.' });
      if (m[2] === 'like') {
        const del = db.prepare('DELETE FROM likes WHERE post_id=? AND user_id=?').run(id, me.id);
        if (!del.changes) db.prepare('INSERT INTO likes VALUES(?,?)').run(id, me.id);
      } else {
        const t = clean((await body(req)).texto, 500);
        if (!t) return send(res, 400, { erro: 'Comentário vazio.' });
        db.prepare('INSERT INTO comments(post_id,user_id,texto) VALUES(?,?,?)').run(id, me.id, t);
      }
      return send(res, 200, { post: feed(me.id, { id })[0] });
    }
    send(res, 404, { erro: 'Não encontrado.' });
  } catch (e) { console.error(e); send(res, 500, { erro: 'Erro interno.' }); }
}).listen(PORT, () => console.log(`Educa Mais rodando em http://localhost:${PORT}`));

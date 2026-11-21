'use strict';

/**
 * DOM ALPHA AJATO - API
 * Plataforma de servicos, obras e reformas.
 * Persistencia em arquivo JSON (sem servico externo).
 */

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const INDEX_FILE = path.join(__dirname, 'index.html');

const CATEGORIES = [
  'Alvenaria e estrutura', 'Pintura e acabamento', 'Elétrica', 'Hidráulica', 'Gesso e pisos',
  'Telhados', 'Marcenaria', 'Limpeza pós-obra', 'Reformas em geral', 'Ajudante'
];
const ROLES = ['client', 'professional', 'helper'];
const PLANS = {
  professional: { key: 'professional', name: 'Alpha Diamante', durationMeses: 2, points: 100, price: 99.9 },
  helper: { key: 'helper', name: 'Alpha Ouro', durationMeses: 2, points: 80, price: 59.9 }
};

/* Profissional e ajudante novo recebem o plano completo grátis por 2 meses. */
const TRIAL_MESES = 2;

/* Ativa o plano de teste (2 meses grátis) para quem acabou de se cadastrar. */
function startTrial(user) {
  if (!user || !PLANS[user.role]) return null;
  const plan = PLANS[user.role];
  const until = addMonths(new Date(), TRIAL_MESES);
  user.plan = {
    key: plan.key,
    name: plan.name,
    since: nowISO(),
    until: until.toISOString(),
    trial: true
  };
  user.trialUsed = true;
  user.trialUntil = until.toISOString();
  return user.plan;
}

app.disable('x-powered-by');
app.use(express.json({ limit: '8mb' }));

/* ------------------------------ utilidades ------------------------------ */

const nowISO = () => new Date().toISOString();
const uid = (p) => p + '_' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
const addMonths = (date, n) => { const d = new Date(date); d.setMonth(d.getMonth() + n); return d; };
const clean = (v, max) => String(v == null ? '' : v).trim().slice(0, max || 4000);

/* ---------------------------------- PIX --------------------------------- */

const PIX_TYPES = ['cpf', 'cnpj', 'email', 'telefone', 'aleatoria'];
const PLATFORM_PIX = {
  key: clean(process.env.PLATFORM_PIX_KEY, 140) || 'financeiro@domalphaajato.com',
  holder: clean(process.env.PLATFORM_PIX_HOLDER, 80) || 'DOM ALPHA AJATO'
};

/* A chave que recebe o dinheiro dos planos é sempre a chave PIX da conta do dono. */
function platformPix() {
  const owner = (db && Array.isArray(db.users)) ? db.users.find((u) => u.role === 'owner' && u.pixKey) : null;
  if (owner) {
    return {
      key: owner.pixKey,
      holder: owner.pixHolder || owner.name,
      ownerName: owner.name,
      source: 'owner'
    };
  }
  return { key: PLATFORM_PIX.key, holder: PLATFORM_PIX.holder, ownerName: null, source: 'padrao' };
}

function normalizePix(type, rawKey) {
  const t = PIX_TYPES.includes(String(type || '').toLowerCase()) ? String(type).toLowerCase() : 'aleatoria';
  const digits = String(rawKey || '').replace(/\D/g, '');
  let value = clean(rawKey, 140);
  if (!value) return { error: 'Informe a chave PIX.' };
  if (t === 'email') {
    value = value.toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)) return { error: 'Chave PIX de e-mail inválida.' };
  } else if (t === 'cpf') {
    if (digits.length !== 11) return { error: 'A chave PIX de CPF precisa ter 11 números.' };
    value = digits;
  } else if (t === 'cnpj') {
    if (digits.length !== 14) return { error: 'A chave PIX de CNPJ precisa ter 14 números.' };
    value = digits;
  } else if (t === 'telefone') {
    if (digits.length < 10 || digits.length > 13) return { error: 'Telefone da chave PIX inválido. Use DDD + número.' };
    value = digits;
  } else if (value.length < 8) {
    return { error: 'Chave aleatória inválida.' };
  }
  return { type: t, value };
}

function maskPix(key) {
  const v = String(key || '');
  if (!v) return '';
  if (v.includes('@')) {
    const parts = v.split('@');
    return parts[0].slice(0, 2) + '***@' + parts[1];
  }
  if (v.length <= 6) return '***' + v.slice(-2);
  return v.slice(0, 3) + '***' + v.slice(-2);
}

function hashPassword(password, salt) {
  const s = salt || crypto.randomBytes(16).toString('hex');
  return { salt: s, hash: crypto.scryptSync(String(password), s, 64).toString('hex') };
}

function checkPassword(password, salt, hash) {
  const candidate = crypto.scryptSync(String(password), salt || '', 64);
  const expected = Buffer.from(String(hash || ''), 'hex');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

function makeUser(input) {
  const { salt, hash } = hashPassword(input.password);
  return {
    id: uid('u'),
    name: clean(input.name, 80),
    email: clean(input.email, 120).toLowerCase(),
    salt,
    hash,
    role: input.role,
    city: clean(input.city, 80),
    state: clean(input.state, 2).toUpperCase(),
    category: clean(input.category, 80),
    bio: clean(input.bio, 1200),
    phone: clean(input.phone, 30),
    pixKey: null,
    pixKeyType: null,
    pixHolder: clean(input.pixHolder, 80),
    photo: null,
    skills: [],
    points: 0,
    cyclePoints: 0,
    jobsDone: 0,
    ratingSum: 0,
    ratingCount: 0,
    plan: null,
    status: 'ativo',
    createdAt: nowISO()
  };
}

/* ------------------------------ banco local ----------------------------- */

let db;

function blankDB() {
  return {
    users: [], jobs: [], proposals: [], contracts: [], chats: [], messages: [],
    notifications: [], reports: [], reviews: [], ledger: [], sessions: {},
    rankingCycle: { start: nowISO(), end: addMonths(new Date(), 2).toISOString() }
  };
}

function seedDB() {
  const data = blankDB();

  const owner = makeUser({
    name: 'Caio da Silva de Souza', email: 'dono@domalphaajato.com',
    password: 'dono123', role: 'owner'
  });
  owner.pixKey = 'financeiro@domalphaajato.com';
  owner.pixKeyType = 'email';
  owner.pixHolder = 'Caio da Silva de Souza';
  data.users.push(owner);

  for (const adm of [
    { name: 'ADM 1 - Operação', email: 'adm1@domalphaajato.com', password: 'adm123' },
    { name: 'ADM 2 - Suporte', email: 'adm2@domalphaajato.com', password: 'adm123' }
  ]) {
    data.users.push(makeUser({ ...adm, role: 'admin' }));
  }

  const pros = [
    {
      name: 'Carlos Ferreira', email: 'carlos@domalphaajato.com', role: 'professional',
      city: 'São Paulo', state: 'SP', category: 'Alvenaria e estrutura', phone: '(11) 98888-1010',
      bio: 'Mestre de obras com 15 anos de experiência em alvenaria, estrutura e reformas completas.',
      points: 260, cyclePoints: 180, jobsDone: 12, ratingSum: 57, ratingCount: 12,
      plan: PLANS.professional
    },
    {
      name: 'Ana Souza', email: 'ana@domalphaajato.com', role: 'professional',
      city: 'Rio de Janeiro', state: 'RJ', category: 'Pintura e acabamento', phone: '(21) 97777-2020',
      bio: 'Pintura residencial e predial, textura, grafiato e acabamento fino.',
      points: 190, cyclePoints: 120, jobsDone: 9, ratingSum: 43, ratingCount: 9
    },
    {
      name: 'Marcos Alves', email: 'marcos@domalphaajato.com', role: 'professional',
      city: 'Campinas', state: 'SP', category: 'Elétrica', phone: '(19) 96666-3030',
      bio: 'Eletricista predial, instalação de quadros, tomadas e iluminação.',
      points: 95, cyclePoints: 95, jobsDone: 5, ratingSum: 24, ratingCount: 5
    },
    {
      name: 'João Batista', email: 'joao@domalphaajato.com', role: 'helper',
      city: 'Belo Horizonte', state: 'MG', category: 'Ajudante', phone: '(31) 95555-4040',
      bio: 'Ajudante geral de obra, carregamento, limpeza e apoio em reformas.',
      points: 120, cyclePoints: 60, jobsDone: 7, ratingSum: 33, ratingCount: 7,
      plan: PLANS.helper
    }
  ];

  for (const p of pros) {
    const user = makeUser({ ...p, password: 'demo123' });
    user.points = p.points || 0;
    user.cyclePoints = p.cyclePoints || 0;
    user.jobsDone = p.jobsDone || 0;
    user.ratingSum = p.ratingSum || 0;
    user.ratingCount = p.ratingCount || 0;
    if (p.plan) {
      user.plan = {
        key: p.plan.key, name: p.plan.name,
        since: nowISO(), until: addMonths(new Date(), 2).toISOString()
      };
    }
    data.users.push(user);
  }

  const client = makeUser({
    name: 'Marina Lima', email: 'marina@domalphaajato.com', password: 'demo123',
    role: 'client', city: 'São Paulo', state: 'SP', phone: '(11) 94444-5050'
  });
  data.users.push(client);

  data.jobs.push(
    {
      id: uid('j'), clientId: client.id, title: 'Reforma de banheiro completo',
      category: 'Reformas em geral', city: 'São Paulo', state: 'SP',
      description: 'Banheiro de 4m²: troca de revestimento, louças, box e pintura.',
      budget: 6500, deadline: addMonths(new Date(), 1).toISOString().slice(0, 10),
      status: 'aberto', createdAt: nowISO()
    },
    {
      id: uid('j'), clientId: client.id, title: 'Pintura de apartamento 70m²',
      category: 'Pintura e acabamento', city: 'São Paulo', state: 'SP',
      description: 'Pintura interna completa, massa corrida e duas demãos de tinta acrílica.',
      budget: 3800, deadline: addMonths(new Date(), 1).toISOString().slice(0, 10),
      status: 'aberto', createdAt: nowISO()
    }
  );

  return data;
}

function writeDB() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

function ensureOwnerAccounts() {
  if (!db.users.some((u) => u.role === 'owner')) {
    const owner = makeUser({
      name: 'Caio da Silva de Souza', email: 'dono@domalphaajato.com',
      password: 'dono123', role: 'owner'
    });
    owner.pixKey = 'financeiro@domalphaajato.com';
    owner.pixKeyType = 'email';
    owner.pixHolder = 'Caio da Silva de Souza';
    db.users.push(owner);
  }
  for (const adm of [
    { name: 'ADM 1 - Operação', email: 'adm1@domalphaajato.com' },
    { name: 'ADM 2 - Suporte', email: 'adm2@domalphaajato.com' }
  ]) {
    if (!db.users.some((u) => u.email === adm.email)) {
      db.users.push(makeUser({ ...adm, password: 'adm123', role: 'admin' }));
    }
  }
}

function ensureDB() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DB_FILE)) {
    try {
      db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    } catch (err) {
      db = seedDB();
    }
  } else {
    db = seedDB();
  }
  for (const key of ['users', 'jobs', 'proposals', 'contracts', 'chats', 'messages', 'notifications', 'reports', 'reviews', 'ledger']) {
    if (!Array.isArray(db[key])) db[key] = [];
  }
  if (!db.sessions || typeof db.sessions !== 'object') db.sessions = {};
  if (!db.rankingCycle || !db.rankingCycle.start) {
    db.rankingCycle = { start: nowISO(), end: addMonths(new Date(), 2).toISOString() };
  }
  if (!db.users.length) db = seedDB();
  ensureOwnerAccounts();
  writeDB();
}

ensureDB();

/* --------------------------- sessao e permissao -------------------------- */

function userFromReq(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token || !db.sessions[token]) return null;
  return db.users.find((u) => u.id === db.sessions[token]) || null;
}

function auth(required) {
  return (req, res, next) => {
    req.user = userFromReq(req);
    req.token = (req.headers.authorization || '').replace('Bearer ', '').trim();
    if (required && !req.user) return res.status(401).json({ error: 'Faça login para continuar.' });
    if (req.user && req.user.status === 'banido') {
      return res.status(403).json({ error: 'Conta suspensa. Fale com a administração.' });
    }
    next();
  };
}

function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Faça login para continuar.' });
  if (!['admin', 'owner'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Acesso restrito à administração.' });
  }
  next();
}

function pub(u, viewer) {
  if (!u) return null;
  const out = {
    id: u.id, name: u.name, role: u.role, city: u.city || '', state: u.state || '',
    category: u.category || '', bio: u.bio || '', photo: u.photo || null,
    skills: u.skills || [], points: u.points || 0, cyclePoints: u.cyclePoints || 0,
    jobsDone: u.jobsDone || 0, ratingCount: u.ratingCount || 0,
    rating: u.ratingCount ? Number((u.ratingSum / u.ratingCount).toFixed(2)) : 0,
    plan: u.plan || null, status: u.status || 'ativo', createdAt: u.createdAt,
    phone: u.phone || '',
    pixKeyType: u.pixKeyType || null,
    hasPix: !!u.pixKey,
    pixKeyMasked: u.pixKey ? maskPix(u.pixKey) : ''
  };
  const privileged = !!viewer && (viewer.id === u.id || ['admin', 'owner'].includes(viewer.role));
  // Quem recebe pagamento (profissional/ajudante) tem a chave PIX liberada para
  // qualquer usuário autenticado: é assim que o cliente copia a chave, paga pelo
  // próprio banco e volta para enviar o comprovante. Visitante anônimo continua
  // vendo apenas a versão mascarada (pixKeyMasked).
  const canReceive = !!viewer && (u.role === 'professional' || u.role === 'helper');
  if (privileged) {
    out.email = u.email;
  }
  if (privileged || canReceive) {
    out.pixKey = u.pixKey || '';
    out.pixHolder = u.pixHolder || '';
  }
  return out;
}

function addPoints(user, n) {
  user.points = (user.points || 0) + n;
  user.cyclePoints = (user.cyclePoints || 0) + n;
}

function notify(userId, text) {
  if (!userId) return;
  db.notifications.push({ id: uid('n'), uid: userId, text: clean(text, 300), read: false, date: nowISO() });
}

function findOrCreateChat(aId, bId) {
  let chat = db.chats.find((c) => c.participants.length === 2 && c.participants.includes(aId) && c.participants.includes(bId));
  if (!chat) {
    chat = { id: uid('c'), participants: [aId, bId], createdAt: nowISO(), lastAt: nowISO() };
    db.chats.push(chat);
  }
  return chat;
}

function chatSummary(chat, viewerId) {
  const otherId = chat.participants.find((p) => p !== viewerId);
  const other = db.users.find((u) => u.id === otherId);
  const last = db.messages.filter((m) => m.chatId === chat.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).pop();
  return {
    id: chat.id,
    other: pub(other),
    lastMessage: last ? { text: last.text, fromId: last.fromId, createdAt: last.createdAt } : null,
    unread: db.messages.filter((m) => m.chatId === chat.id && m.fromId !== viewerId && !(m.readBy || []).includes(viewerId)).length,
    lastAt: chat.lastAt || chat.createdAt
  };
}

/* -------------------------------- saude --------------------------------- */

app.get('/api/health', (req, res) => {
  res.json({ ok: true, app: 'DOM ALPHA AJATO', users: db.users.length, jobs: db.jobs.length });
});

/* -------------------------------- contas -------------------------------- */

app.post('/api/auth/register', (req, res) => {
  const body = req.body || {};
  const name = clean(body.name, 80);
  const email = clean(body.email, 120).toLowerCase();
  const password = String(body.password || '');
  if (['admin', 'owner'].includes(String(body.role || ''))) {
    return res.status(403).json({
      error: 'Contas de administração e de dono não podem ser criadas pelo cadastro. Somente o dono define quem é administrador.'
    });
  }
  const role = ROLES.includes(body.role) ? body.role : 'client';

  if (name.length < 3) return res.status(400).json({ error: 'Informe seu nome completo.' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return res.status(400).json({ error: 'Informe um e-mail válido.' });
  if (password.length < 6) return res.status(400).json({ error: 'A senha deve ter pelo menos 6 caracteres.' });
  if (db.users.some((u) => u.email === email)) return res.status(409).json({ error: 'Este e-mail já está cadastrado.' });

  const user = makeUser({
    name, email, password, role,
    city: body.city, state: body.state, category: body.category,
    bio: body.bio, phone: body.phone
  });
  if (role !== 'client' && !user.category) user.category = 'Reformas em geral';

  const pixKeyRaw = clean(body.pixKey, 140);
  if (pixKeyRaw) {
    const pix = normalizePix(body.pixKeyType, pixKeyRaw);
    if (pix.error) return res.status(400).json({ error: pix.error });
    user.pixKey = pix.value;
    user.pixKeyType = pix.type;
  }
  user.pixHolder = clean(body.pixHolder || user.name, 80);

  /* Profissional e ajudante começam com 2 meses de plano grátis. */
  const trial = startTrial(user);
  if (trial) addPoints(user, PLANS[user.role].points);

  db.users.push(user);
  const token = crypto.randomBytes(24).toString('hex');
  db.sessions[token] = user.id;
  notify(user.id, 'Bem-vindo(a) ao DOM ALPHA AJATO! Complete seu perfil para aparecer nas buscas.');
  if (trial) {
    notify(user.id, 'Presente de boas-vindas: ' + TRIAL_MESES + ' meses do plano ' + trial.name + ' grátis, válido até ' + new Date(trial.until).toLocaleDateString('pt-BR') + '. Ative ou renove quando quiser no seu perfil.');
  }
  writeDB();
  res.status(201).json({ token, user: pub(user, user), trial: trial || null });
});

app.post('/api/auth/login', (req, res) => {
  const email = clean((req.body || {}).email, 120).toLowerCase();
  const password = String((req.body || {}).password || '');
  const user = db.users.find((u) => u.email === email);
  if (!user || !checkPassword(password, user.salt, user.hash)) {
    return res.status(401).json({ error: 'E-mail ou senha incorretos.' });
  }
  if (user.status === 'banido') return res.status(403).json({ error: 'Conta suspensa. Fale com a administração.' });
  const token = crypto.randomBytes(24).toString('hex');
  db.sessions[token] = user.id;
  writeDB();
  res.json({ token, user: pub(user, user) });
});

app.post('/api/auth/logout', auth(), (req, res) => {
  if (req.token && db.sessions[req.token]) {
    delete db.sessions[req.token];
    writeDB();
  }
  res.json({ ok: true });
});

app.get('/api/auth/me', auth(true), (req, res) => {
  res.json({ user: pub(req.user, req.user) });
});

app.patch('/api/me', auth(true), (req, res) => {
  const body = req.body || {};
  const u = req.user;
  if (body.name !== undefined) {
    const name = clean(body.name, 80);
    if (name.length < 3) return res.status(400).json({ error: 'Informe seu nome completo.' });
    u.name = name;
  }
  if (body.phone !== undefined) u.phone = clean(body.phone, 30);
  if (body.city !== undefined) u.city = clean(body.city, 80);
  if (body.state !== undefined) u.state = clean(body.state, 2).toUpperCase();
  if (body.category !== undefined && u.role !== 'client') u.category = clean(body.category, 80);
  if (body.bio !== undefined) u.bio = clean(body.bio, 1200);
  if (body.skills !== undefined && Array.isArray(body.skills)) {
    u.skills = body.skills.slice(0, 12).map((s) => clean(s, 40)).filter(Boolean);
  }
  if (body.pixKey !== undefined) {
    const pixRaw = clean(body.pixKey, 140);
    if (!pixRaw) {
      u.pixKey = null;
      u.pixKeyType = null;
    } else {
      const pix = normalizePix(body.pixKeyType || u.pixKeyType, pixRaw);
      if (pix.error) return res.status(400).json({ error: pix.error });
      u.pixKey = pix.value;
      u.pixKeyType = pix.type;
    }
  }
  if (body.pixHolder !== undefined) u.pixHolder = clean(body.pixHolder, 80);
  if (body.photo !== undefined) {
    if (body.photo === null) u.photo = null;
    else if (typeof body.photo === 'string' && /^data:image\//.test(body.photo) && body.photo.length < 3_000_000) u.photo = body.photo;
    else return res.status(400).json({ error: 'Foto inválida. Envie uma imagem JPG ou PNG pequena.' });
  }
  writeDB();
  res.json({ user: pub(u, u) });
});

/* ------------------------------ profissionais --------------------------- */

app.get('/api/professionals', (req, res) => {
  const category = clean(req.query.category, 80);
  const q = clean(req.query.q, 80).toLowerCase();
  const city = clean(req.query.city, 80).toLowerCase();
  const now = Date.now();

  let list = db.users.filter((u) => ['professional', 'helper'].includes(u.role) && u.status === 'ativo');
  if (category) list = list.filter((u) => u.category === category || (u.role === 'helper' && category === 'Ajudante'));
  if (city) list = list.filter((u) => (u.city || '').toLowerCase().includes(city));
  if (q) {
    list = list.filter((u) =>
      (u.name || '').toLowerCase().includes(q) ||
      (u.category || '').toLowerCase().includes(q) ||
      (u.bio || '').toLowerCase().includes(q)
    );
  }

  const ranked = list
    .map((u) => pub(u))
    .sort((a, b) => {
      const aPaid = a.plan && new Date(a.plan.until).getTime() > now ? 1 : 0;
      const bPaid = b.plan && new Date(b.plan.until).getTime() > now ? 1 : 0;
      if (aPaid !== bPaid) return bPaid - aPaid;
      return (b.cyclePoints || 0) - (a.cyclePoints || 0) || b.rating - a.rating;
    });

  res.json({ professionals: ranked, total: ranked.length, categories: CATEGORIES });
});

app.get('/api/users/:id', (req, res) => {
  const viewer = userFromReq(req);
  const u = db.users.find((x) => x.id === req.params.id);
  if (!u) return res.status(404).json({ error: 'Perfil não encontrado.' });
  const reviews = db.reviews
    .filter((r) => r.toId === u.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 10)
    .map((r) => ({ ...r, fromName: (db.users.find((x) => x.id === r.fromId) || {}).name || 'Cliente' }));
  res.json({ user: pub(u, viewer), reviews });
});

/* -------------------------------- ranking ------------------------------- */

app.get('/api/ranking', (req, res) => {
  const list = (role) => db.users
    .filter((u) => u.role === role && u.status === 'ativo')
    .map((u) => pub(u))
    .sort((a, b) => (b.cyclePoints || 0) - (a.cyclePoints || 0) || (b.points || 0) - (a.points || 0) || a.name.localeCompare(b.name));
  res.json({ cycle: db.rankingCycle, professional: list('professional'), helper: list('helper') });
});

/* --------------------------------- planos ------------------------------- */

app.get('/api/plans', (req, res) => {
  res.json({
    plans: PLANS,
    trialMeses: TRIAL_MESES,
    cycle: db.rankingCycle,
    platformPix: platformPix()
  });
});

app.post('/api/plans/subscribe', auth(true), (req, res) => {
  const body = req.body || {};
  const key = body.plan;
  const plan = PLANS[key];
  if (!plan) return res.status(400).json({ error: 'Plano inválido.' });
  if (req.user.role !== key) {
    return res.status(400).json({ error: 'Este plano é exclusivo para ' + (key === 'helper' ? 'ajudantes.' : 'profissionais.') });
  }
  if (!req.user.pixKey) {
    return res.status(400).json({
      error: 'Cadastre sua chave PIX no perfil antes de assinar o plano.',
      code: 'pix_missing'
    });
  }
  const proof = clean(body.pixProof, 80);
  const pix = platformPix();
  if (!proof) {
    return res.status(400).json({
      error: 'O pagamento é por PIX. Pague a chave da plataforma e informe o ID da transação.',
      code: 'pix_proof_required',
      payment: { amount: plan.price, planName: plan.name, pixKey: pix.key, holder: pix.holder }
    });
  }

  const until = addMonths(new Date(), plan.durationMeses);
  req.user.plan = { key: plan.key, name: plan.name, since: nowISO(), until: until.toISOString(), paidWith: 'pix', proof };
  addPoints(req.user, plan.points);
  db.ledger.push({
    id: uid('l'), uid: req.user.id, type: 'assinatura', method: 'pix', proof, amount: plan.price,
    receiverPixKey: pix.key, receiverOwnerId: (db.users.find((u) => u.role === 'owner') || {}).id || null,
    desc: 'Assinatura ' + plan.name + ' (' + plan.durationMeses + ' meses) paga via PIX', date: nowISO()
  });
  const ownerUser = db.users.find((u) => u.role === 'owner');
  if (ownerUser) {
    notify(ownerUser.id, 'Plano ' + plan.name + ' pago por PIX: R$ ' + plan.price + ' para a chave ' + pix.key + ' (' + req.user.name + ').');
  }
  notify(req.user.id, 'Pagamento PIX registrado. Plano ' + plan.name + ' ativado! Você ganhou ' + plan.points + ' pontos e destaque no PERFUME.');
  writeDB();
  res.json({ user: pub(req.user, req.user), plan: req.user.plan, paid: true, proof });
});

/* ------------------------------ oportunidades --------------------------- */

function jobView(job, viewer) {
  const client = db.users.find((u) => u.id === job.clientId);
  const proposals = db.proposals.filter((p) => p.jobId === job.id);
  const out = {
    ...job,
    clientName: client ? client.name : 'Cliente',
    clientId: job.clientId,
    proposalsCount: proposals.length,
    isOwner: !!viewer && viewer.id === job.clientId
  };
  if (viewer && ['admin', 'owner'].includes(viewer.role)) out.proposalsCount = proposals.length;
  return out;
}

app.get('/api/jobs', (req, res) => {
  const viewer = userFromReq(req);
  const status = clean(req.query.status, 20);
  const category = clean(req.query.category, 80);
  const q = clean(req.query.q, 80).toLowerCase();
  const mine = req.query.mine === '1';

  let list = db.jobs.slice();
  if (mine) {
    if (!viewer) return res.status(401).json({ error: 'Faça login para ver seus serviços.' });
    list = list.filter((j) => j.clientId === viewer.id);
  }
  if (status) list = list.filter((j) => j.status === status);
  if (category) list = list.filter((j) => j.category === category);
  if (q) list = list.filter((j) => (j.title || '').toLowerCase().includes(q) || (j.description || '').toLowerCase().includes(q));

  list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  res.json({ jobs: list.map((j) => jobView(j, viewer)) });
});

app.post('/api/jobs', auth(true), (req, res) => {
  if (!['client', 'admin', 'owner'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Apenas contas de cliente podem publicar serviços.' });
  }
  const body = req.body || {};
  const title = clean(body.title, 100);
  const description = clean(body.description, 2000);
  const category = clean(body.category, 80);
  if (title.length < 5) return res.status(400).json({ error: 'Descreva o título do serviço (mínimo 5 caracteres).' });
  if (description.length < 10) return res.status(400).json({ error: 'Descreva o serviço com pelo menos 10 caracteres.' });
  if (!CATEGORIES.includes(category)) return res.status(400).json({ error: 'Escolha uma categoria válida.' });

  const job = {
    id: uid('j'), clientId: req.user.id, title, description, category,
    city: clean(body.city, 80) || req.user.city || '',
    state: (clean(body.state, 2) || req.user.state || '').toUpperCase(),
    budget: Number(body.budget) || 0,
    deadline: clean(body.deadline, 10),
    status: 'aberto', createdAt: nowISO()
  };
  db.jobs.push(job);
  writeDB();
  res.status(201).json({ job: jobView(job, req.user) });
});

app.get('/api/jobs/:id', auth(true), (req, res) => {
  const job = db.jobs.find((j) => j.id === req.params.id);
  if (!job) return res.status(404).json({ error: 'Serviço não encontrado.' });
  const owner = job.clientId === req.user.id || ['admin', 'owner'].includes(req.user.role);
  const proposals = db.proposals
    .filter((p) => p.jobId === job.id && (owner || p.proId === req.user.id))
    .map((p) => ({
      ...p,
      proName: (db.users.find((u) => u.id === p.proId) || {}).name || 'Profissional',
      proRating: pub(db.users.find((u) => u.id === p.proId)) || null
    }));
  let payment = null;
  if (owner && job.hiredProId) {
    const pro = db.users.find((u) => u.id === job.hiredProId);
    const contract = db.contracts.find((c) => c.jobId === job.id && c.status !== 'cancelado');
    if (pro) {
      payment = {
        contractId: contract ? contract.id : null,
        proId: pro.id,
        proName: pro.name,
        amount: contract ? contract.price : null,
        contractStatus: contract ? contract.status : null,
        pixKey: pro.pixKey || null,
        pixKeyType: pro.pixKeyType || null,
        pixHolder: pro.pixHolder || pro.name,
        paid: !!(contract && contract.paidAt),
        paidAt: contract && contract.paidAt ? contract.paidAt : null
      };
    }
  }
  res.json({ job: jobView(job, req.user), proposals, payment });
});

app.post('/api/jobs/:id/complete', auth(true), (req, res) => {
  const job = db.jobs.find((j) => j.id === req.params.id);
  if (!job) return res.status(404).json({ error: 'Serviço não encontrado.' });
  if (job.clientId !== req.user.id && !['admin', 'owner'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Apenas o cliente que publicou pode concluir.' });
  }
  if (job.status === 'concluido') return res.status(400).json({ error: 'Este serviço já foi concluído.' });

  job.status = 'concluido';
  job.completedAt = nowISO();
  const contract = db.contracts.find((c) => c.jobId === job.id && c.status !== 'cancelado');
  if (contract) {
    contract.status = 'concluido';
    const pro = db.users.find((u) => u.id === contract.proId);
    if (pro) {
      pro.jobsDone = (pro.jobsDone || 0) + 1;
      addPoints(pro, 30);
      notify(pro.id, 'Serviço concluído: "' + job.title + '". +30 pontos no ranking.');
    }
  }
  writeDB();
  res.json({ job: jobView(job, req.user) });
});

app.post('/api/jobs/:id/review', auth(true), (req, res) => {
  const job = db.jobs.find((j) => j.id === req.params.id);
  if (!job) return res.status(404).json({ error: 'Serviço não encontrado.' });
  if (job.clientId !== req.user.id) return res.status(403).json({ error: 'Apenas o cliente pode avaliar.' });
  if (job.status !== 'concluido') return res.status(400).json({ error: 'Conclua o serviço antes de avaliar.' });

  const stars = Number((req.body || {}).stars);
  if (!(stars >= 1 && stars <= 5)) return res.status(400).json({ error: 'Escolha de 1 a 5 estrelas.' });

  const contract = db.contracts.find((c) => c.jobId === job.id && c.status !== 'cancelado');
  if (!contract) return res.status(400).json({ error: 'Não há profissional contratado para avaliar.' });
  if (db.reviews.some((r) => r.jobId === job.id && r.fromId === req.user.id)) {
    return res.status(409).json({ error: 'Você já avaliou este serviço.' });
  }

  const review = {
    id: uid('r'), jobId: job.id, fromId: req.user.id, toId: contract.proId,
    stars, comment: clean((req.body || {}).comment, 600), createdAt: nowISO()
  };
  db.reviews.push(review);
  const pro = db.users.find((u) => u.id === contract.proId);
  if (pro) {
    pro.ratingSum = (pro.ratingSum || 0) + stars;
    pro.ratingCount = (pro.ratingCount || 0) + 1;
    notify(pro.id, 'Você recebeu uma avaliação de ' + stars + ' estrela(s).');
  }
  writeDB();
  res.status(201).json({ review });
});

/* -------------------------------- propostas ----------------------------- */

app.get('/api/proposals', auth(true), (req, res) => {
  const mine = ['professional', 'helper'].includes(req.user.role);
  const list = db.proposals
    .filter((p) => (mine ? p.proId === req.user.id : db.jobs.some((j) => j.id === p.jobId && j.clientId === req.user.id)))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((p) => {
      const job = db.jobs.find((j) => j.id === p.jobId) || {};
      const pro = db.users.find((u) => u.id === p.proId);
      return {
        ...p,
        jobTitle: job.title || 'Serviço removido',
        jobStatus: job.status || 'cancelado',
        jobBudget: job.budget || 0,
        clientId: job.clientId,
        proName: pro ? pro.name : 'Profissional',
        pro: pub(pro)
      };
    });
  res.json({ proposals: list, mode: mine ? 'sent' : 'received' });
});

app.post('/api/proposals', auth(true), (req, res) => {
  if (!['professional', 'helper'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Apenas profissionais e ajudantes enviam propostas.' });
  }
  const body = req.body || {};
  const job = db.jobs.find((j) => j.id === body.jobId);
  if (!job) return res.status(404).json({ error: 'Serviço não encontrado.' });
  if (job.clientId === req.user.id) return res.status(400).json({ error: 'Você não pode propor no seu próprio serviço.' });
  if (job.status !== 'aberto') return res.status(400).json({ error: 'Este serviço não está mais aberto.' });
  if (db.proposals.some((p) => p.jobId === job.id && p.proId === req.user.id)) {
    return res.status(409).json({ error: 'Você já enviou uma proposta para este serviço.' });
  }
  const price = Number(body.price);
  if (!(price > 0)) return res.status(400).json({ error: 'Informe um valor válido para a proposta.' });
  const message = clean(body.message, 1000);
  if (message.length < 10) return res.status(400).json({ error: 'Escreva uma mensagem com pelo menos 10 caracteres.' });

  const proposal = {
    id: uid('p'), jobId: job.id, proId: req.user.id, price,
    days: Number(body.days) || 0, message, status: 'pendente', createdAt: nowISO()
  };
  db.proposals.push(proposal);
  notify(job.clientId, req.user.name + ' enviou uma proposta para "' + job.title + '".');
  writeDB();
  res.status(201).json({ proposal });
});

app.post('/api/proposals/:id/accept', auth(true), (req, res) => {
  const proposal = db.proposals.find((p) => p.id === req.params.id);
  if (!proposal) return res.status(404).json({ error: 'Proposta não encontrada.' });
  const job = db.jobs.find((j) => j.id === proposal.jobId);
  if (!job) return res.status(404).json({ error: 'Serviço não encontrado.' });
  if (job.clientId !== req.user.id) return res.status(403).json({ error: 'Apenas o cliente pode aceitar propostas.' });
  if (proposal.status !== 'pendente') return res.status(400).json({ error: 'Esta proposta já foi respondida.' });
  if (job.status !== 'aberto') return res.status(400).json({ error: 'Este serviço não está mais aberto.' });

  proposal.status = 'aceita';
  proposal.answeredAt = nowISO();
  for (const other of db.proposals.filter((p) => p.jobId === job.id && p.id !== proposal.id && p.status === 'pendente')) {
    other.status = 'recusada';
    other.answeredAt = nowISO();
    notify(other.proId, 'Sua proposta para "' + job.title + '" não foi escolhida desta vez.');
  }

  job.status = 'em_andamento';
  job.hiredProId = proposal.proId;

  const contract = {
    id: uid('ct'), jobId: job.id, proposalId: proposal.id, clientId: job.clientId,
    proId: proposal.proId, price: proposal.price, status: 'ativo', createdAt: nowISO()
  };
  db.contracts.push(contract);

  const pro = db.users.find((u) => u.id === proposal.proId);
  if (pro) {
    addPoints(pro, 10);
    notify(pro.id, 'Proposta aceita para "' + job.title + '". +10 pontos. Combine os detalhes no chat.');
  }
  notify(job.clientId, 'Você contratou ' + (pro ? pro.name : 'o profissional') + ' para "' + job.title + '".');

  const chat = findOrCreateChat(job.clientId, proposal.proId);
  chat.lastAt = nowISO();
  writeDB();
  res.json({ proposal, contract, chatId: chat.id });
});

app.post('/api/proposals/:id/reject', auth(true), (req, res) => {
  const proposal = db.proposals.find((p) => p.id === req.params.id);
  if (!proposal) return res.status(404).json({ error: 'Proposta não encontrada.' });
  const job = db.jobs.find((j) => j.id === proposal.jobId);
  if (!job) return res.status(404).json({ error: 'Serviço não encontrado.' });
  if (job.clientId !== req.user.id) return res.status(403).json({ error: 'Apenas o cliente pode recusar propostas.' });
  if (proposal.status !== 'pendente') return res.status(400).json({ error: 'Esta proposta já foi respondida.' });

  proposal.status = 'recusada';
  proposal.answeredAt = nowISO();
  notify(proposal.proId, 'Sua proposta para "' + job.title + '" foi recusada.');
  writeDB();
  res.json({ proposal });
});

app.post('/api/contracts/:id/paid', auth(true), (req, res) => {
  const contract = db.contracts.find((c) => c.id === req.params.id);
  if (!contract) return res.status(404).json({ error: 'Contrato não encontrado.' });
  if (contract.clientId !== req.user.id) return res.status(403).json({ error: 'Apenas o cliente pode confirmar o pagamento.' });
  if (contract.paidAt) return res.status(400).json({ error: 'Este pagamento já foi confirmado.' });
  const proof = clean((req.body || {}).proof, 80);
  contract.paidAt = nowISO();
  contract.paymentMethod = 'pix';
  contract.pixProof = proof || null;
  db.ledger.push({
    id: uid('l'), uid: contract.proId, type: 'recebimento', method: 'pix', proof: contract.pixProof,
    amount: contract.price, desc: 'Serviço pago via PIX pelo cliente', date: nowISO()
  });
  notify(contract.proId, 'Pagamento via PIX confirmado pelo cliente' + (proof ? ' (ID ' + proof + ')' : '') + '. Confira seu extrato.');
  writeDB();
  res.json({ contract });
});

/* ---------------------------------- chat -------------------------------- */

app.get('/api/chats', auth(true), (req, res) => {
  const list = db.chats
    .filter((c) => c.participants.includes(req.user.id))
    .map((c) => chatSummary(c, req.user.id))
    .sort((a, b) => String(b.lastAt).localeCompare(String(a.lastAt)));
  res.json({ chats: list });
});

app.post('/api/chats', auth(true), (req, res) => {
  const targetId = (req.body || {}).userId;
  if (!targetId) return res.status(400).json({ error: 'Informe com quem você quer conversar.' });
  if (targetId === req.user.id) return res.status(400).json({ error: 'Você não pode conversar consigo mesmo.' });
  const target = db.users.find((u) => u.id === targetId);
  if (!target) return res.status(404).json({ error: 'Pessoa não encontrada.' });

  const chat = findOrCreateChat(req.user.id, targetId);
  writeDB();
  res.json({ chat: chatSummary(chat, req.user.id) });
});

app.get('/api/chats/:id/messages', auth(true), (req, res) => {
  const chat = db.chats.find((c) => c.id === req.params.id);
  if (!chat) return res.status(404).json({ error: 'Conversa não encontrada.' });
  if (!chat.participants.includes(req.user.id)) return res.status(403).json({ error: 'Você não participa desta conversa.' });

  let changed = false;
  for (const m of db.messages.filter((m) => m.chatId === chat.id)) {
    if (m.fromId !== req.user.id) {
      m.readBy = Array.isArray(m.readBy) ? m.readBy : [];
      if (!m.readBy.includes(req.user.id)) { m.readBy.push(req.user.id); changed = true; }
    }
  }
  if (changed) writeDB();

  const messages = db.messages
    .filter((m) => m.chatId === chat.id)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((m) => ({
      id: m.id, fromId: m.fromId, text: m.text, createdAt: m.createdAt,
      fromName: (db.users.find((u) => u.id === m.fromId) || {}).name || 'Usuário',
      mine: m.fromId === req.user.id
    }));

  res.json({ chat: chatSummary(chat, req.user.id), messages });
});

app.post('/api/chats/:id/messages', auth(true), (req, res) => {
  const chat = db.chats.find((c) => c.id === req.params.id);
  if (!chat) return res.status(404).json({ error: 'Conversa não encontrada.' });
  if (!chat.participants.includes(req.user.id)) return res.status(403).json({ error: 'Você não participa desta conversa.' });

  const text = clean((req.body || {}).text, 2000);
  if (!text) return res.status(400).json({ error: 'Escreva uma mensagem.' });

  const message = {
    id: uid('m'), chatId: chat.id, fromId: req.user.id, text,
    createdAt: nowISO(), readBy: [req.user.id]
  };
  db.messages.push(message);
  chat.lastAt = message.createdAt;

  const otherId = chat.participants.find((p) => p !== req.user.id);
  notify(otherId, 'Nova mensagem de ' + req.user.name + ': ' + text.slice(0, 60));
  writeDB();
  res.status(201).json({ message: { ...message, mine: true, fromName: req.user.name } });
});

/* ----------------------------- notificacoes ----------------------------- */

app.get('/api/notifications', auth(true), (req, res) => {
  const list = db.notifications
    .filter((n) => n.uid === req.user.id)
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 60);
  res.json({ notifications: list, unread: list.filter((n) => !n.read).length });
});

app.post('/api/notifications/read', auth(true), (req, res) => {
  for (const n of db.notifications) if (n.uid === req.user.id) n.read = true;
  writeDB();
  res.json({ ok: true });
});

/* -------------------------------- denuncias ----------------------------- */

app.post('/api/reports', auth(true), (req, res) => {
  const targetId = (req.body || {}).targetId;
  const reason = clean((req.body || {}).reason, 600);
  if (!targetId || reason.length < 5) return res.status(400).json({ error: 'Descreva o motivo da denúncia.' });
  const report = { id: uid('rp'), fromId: req.user.id, targetId, reason, status: 'aberto', createdAt: nowISO() };
  db.reports.push(report);
  writeDB();
  res.status(201).json({ report });
});

/* ----------------------------- administracao ---------------------------- */

app.get('/api/admin/overview', auth(), requireAdmin, (req, res) => {
  const activePlans = db.users.filter((u) => u.plan && new Date(u.plan.until).getTime() > Date.now()).length;
  res.json({
    users: db.users.length,
    professionals: db.users.filter((u) => u.role === 'professional').length,
    helpers: db.users.filter((u) => u.role === 'helper').length,
    clients: db.users.filter((u) => u.role === 'client').length,
    banned: db.users.filter((u) => u.status === 'banido').length,
    jobs: db.jobs.length,
    openJobs: db.jobs.filter((j) => j.status === 'aberto').length,
    proposals: db.proposals.length,
    contracts: db.contracts.length,
    activePlans,
    revenue: db.ledger.reduce((sum, l) => sum + (Number(l.amount) || 0), 0),
    openReports: db.reports.filter((r) => r.status === 'aberto').length,
    cycle: db.rankingCycle
  });
});

app.get('/api/admin/users', auth(), requireAdmin, (req, res) => {
  const q = clean(req.query.q, 80).toLowerCase();
  let list = db.users.slice();
  if (q) list = list.filter((u) => (u.name + ' ' + u.email).toLowerCase().includes(q));
  res.json({
    users: list
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((u) => ({ ...pub(u, req.user), email: u.email, role: u.role }))
  });
});

app.patch('/api/admin/users/:id', auth(), requireAdmin, (req, res) => {
  const user = db.users.find((u) => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'Usuário não encontrado.' });
  const body = req.body || {};

  if (body.status !== undefined) {
    if (!['ativo', 'banido'].includes(body.status)) return res.status(400).json({ error: 'Status inválido.' });
    if (user.id === req.user.id) return res.status(400).json({ error: 'Você não pode alterar o seu próprio status.' });
    user.status = body.status;
    if (body.status === 'banido') {
      for (const [token, id] of Object.entries(db.sessions)) if (id === user.id) delete db.sessions[token];
    }
  }
  if (body.role !== undefined) {
    if (req.user.role !== 'owner') {
      return res.status(403).json({ error: 'Somente a conta do dono pode definir administradores.' });
    }
    if (!['client', 'professional', 'helper', 'admin'].includes(body.role)) return res.status(400).json({ error: 'Perfil inválido.' });
    if (user.id === req.user.id) return res.status(400).json({ error: 'Você não pode alterar o seu próprio perfil.' });
    if (user.role === 'owner') return res.status(403).json({ error: 'A conta do dono não pode ser alterada.' });
    user.role = body.role;
  }
  writeDB();
  res.json({ user: { ...pub(user, req.user), email: user.email } });
});

app.get('/api/admin/reports', auth(), requireAdmin, (req, res) => {
  res.json({
    reports: db.reports
      .slice()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((r) => ({
        ...r,
        fromName: (db.users.find((u) => u.id === r.fromId) || {}).name || 'Usuário',
        targetName: (db.users.find((u) => u.id === r.targetId) || {}).name || 'Usuário'
      }))
  });
});

app.patch('/api/admin/reports/:id', auth(), requireAdmin, (req, res) => {
  const report = db.reports.find((r) => r.id === req.params.id);
  if (!report) return res.status(404).json({ error: 'Denúncia não encontrada.' });
  report.status = (req.body || {}).status === 'aberto' ? 'aberto' : 'resolvido';
  writeDB();
  res.json({ report });
});

app.post('/api/admin/cycle', auth(), requireAdmin, (req, res) => {
  db.rankingCycle = { start: nowISO(), end: addMonths(new Date(), 2).toISOString() };
  for (const u of db.users) u.cyclePoints = 0;
  writeDB();
  res.json({ cycle: db.rankingCycle });
});

/* -------------------------------- entrega ------------------------------- */

app.get('/', (req, res) => res.sendFile(INDEX_FILE));
app.get('/index.html', (req, res) => res.sendFile(INDEX_FILE));

app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api/')) return res.sendFile(INDEX_FILE);
  next();
});

app.use((req, res) => res.status(404).json({ error: 'Recurso não encontrado.' }));

app.use((err, req, res, next) => {
  console.error('[dom-alpha] erro:', err && err.message);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Erro interno. Tente novamente.' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log('DOM ALPHA AJATO rodando na porta ' + PORT);
});

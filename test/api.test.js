'use strict';

/**
 * Teste de fluxo completo do DOM ALPHA AJATO.
 * Sobe o servidor real em uma porta livre e exercita:
 * cadastro, login, publicacao de servico, proposta, aceite,
 * chat interno, plano pago (ranking) e conclusao com avaliacao.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 3400 + Math.floor(Math.random() * 400);
const BASE = 'http://127.0.0.1:' + PORT;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'domalpha-'));

let child;
let clientToken;
let proToken;
let clientId;
let proId;
let jobId;
let proposalId;
let chatId;

async function call(method, route, body, token) {
  const res = await fetch(BASE + route, {
    method,
    headers: Object.assign(
      { 'content-type': 'application/json' },
      token ? { authorization: 'Bearer ' + token } : {}
    ),
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let json = null;
  try { json = await res.json(); } catch { /* resposta sem JSON */ }
  return { status: res.status, json };
}

async function waitForServer() {
  for (let i = 0; i < 100; i += 1) {
    try {
      const r = await fetch(BASE + '/api/health');
      if (r.ok) return;
    } catch { /* ainda subindo */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('O servidor nao respondeu em /api/health.');
}

before(async () => {
  child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT), DATA_DIR }),
    stdio: 'ignore'
  });
  await waitForServer();
});

after(() => {
  if (child) child.kill('SIGKILL');
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

test('health responde ok', async () => {
  const r = await call('GET', '/api/health');
  assert.strictEqual(r.status, 200);
});

test('cadastro de cliente e de profissional', async () => {
  const c = await call('POST', '/api/auth/register', {
    name: 'Cliente Teste', email: 'cliente.teste@exemplo.com',
    password: 'senha123', role: 'client', city: 'Sao Paulo', state: 'SP'
  });
  assert.strictEqual(c.status, 201, JSON.stringify(c.json));
  assert.ok(c.json.token, 'cadastro deve devolver token');
  clientToken = c.json.token;
  clientId = c.json.user.id;

  const p = await call('POST', '/api/auth/register', {
    name: 'Profissional Teste', email: 'pro.teste@exemplo.com',
    password: 'senha123', role: 'professional', city: 'Sao Paulo',
    state: 'SP', category: 'Reformas em geral'
  });
  assert.strictEqual(p.status, 201, JSON.stringify(p.json));
  proToken = p.json.token;
  proId = p.json.user.id;
});

test('e-mail duplicado e senha curta sao recusados', async () => {
  const dup = await call('POST', '/api/auth/register', {
    name: 'Outro Nome', email: 'cliente.teste@exemplo.com', password: 'senha123', role: 'client'
  });
  assert.strictEqual(dup.status, 409);

  const curta = await call('POST', '/api/auth/register', {
    name: 'Outro Nome', email: 'curta@exemplo.com', password: '123', role: 'client'
  });
  assert.strictEqual(curta.status, 400);
});

test('login valida credenciais', async () => {
  const ok = await call('POST', '/api/auth/login', {
    email: 'cliente.teste@exemplo.com', password: 'senha123'
  });
  assert.strictEqual(ok.status, 200);
  assert.ok(ok.json.token);

  const bad = await call('POST', '/api/auth/login', {
    email: 'cliente.teste@exemplo.com', password: 'errada'
  });
  assert.strictEqual(bad.status, 401);

  const me = await call('GET', '/api/auth/me', undefined, ok.json.token);
  assert.strictEqual(me.status, 200);
  assert.strictEqual(me.json.user.email, 'cliente.teste@exemplo.com');
});

test('cliente publica servico e ele aparece nas oportunidades', async () => {
  const job = await call('POST', '/api/jobs', {
    title: 'Reforma de banheiro completo',
    description: 'Trocar revestimento, loucas e metais do banheiro.',
    category: 'Reformas em geral', city: 'Sao Paulo', state: 'SP', budget: 4500
  }, clientToken);
  assert.strictEqual(job.status, 201, JSON.stringify(job.json));
  jobId = job.json.job.id;

  const list = await call('GET', '/api/jobs?status=aberto');
  assert.strictEqual(list.status, 200);
  assert.ok(list.json.jobs.some((j) => j.id === jobId));
});

test('profissional envia proposta e cliente aceita', async () => {
  const proposal = await call('POST', '/api/proposals', {
    jobId, price: 4200, days: 7,
    message: 'Faco o servico completo com material incluso.'
  }, proToken);
  assert.strictEqual(proposal.status, 201, JSON.stringify(proposal.json));
  proposalId = proposal.json.proposal.id;

  const received = await call('GET', '/api/proposals', undefined, clientToken);
  assert.strictEqual(received.status, 200);
  assert.strictEqual(received.json.mode, 'received');
  assert.ok(received.json.proposals.some((p) => p.id === proposalId));

  const accepted = await call('POST', '/api/proposals/' + proposalId + '/accept', {}, clientToken);
  assert.strictEqual(accepted.status, 200, JSON.stringify(accepted.json));
  assert.ok(accepted.json.chatId, 'aceite deve abrir o chat interno');
  chatId = accepted.json.chatId;
});

test('chat interno troca mensagens nos dois sentidos', async () => {
  const sent = await call('POST', '/api/chats/' + chatId + '/messages', {
    text: 'Podemos comecar amanha as 8h?'
  }, clientToken);
  assert.strictEqual(sent.status, 201, JSON.stringify(sent.json));

  const reply = await call('POST', '/api/chats/' + chatId + '/messages', {
    text: 'Combinado, estarei la.'
  }, proToken);
  assert.strictEqual(reply.status, 201);

  const view = await call('GET', '/api/chats/' + chatId + '/messages', undefined, proToken);
  assert.strictEqual(view.status, 200);
  assert.strictEqual(view.json.messages.length, 2);
  assert.ok(view.json.messages.some((m) => m.text.includes('amanha')));

  const chats = await call('GET', '/api/chats', undefined, clientToken);
  assert.ok(chats.json.chats.some((c) => c.id === chatId));

  const forbidden = await call('GET', '/api/chats/' + chatId + '/messages', undefined, clientToken.replace(/a/g, 'b'));
  assert.ok([401, 403].includes(forbidden.status));
});

test('plano pago coloca o profissional no ranking (PERFUME)', async () => {
  const sub = await call('POST', '/api/plans/subscribe', { plan: 'professional' }, proToken);
  assert.strictEqual(sub.status, 200, JSON.stringify(sub.json));
  assert.strictEqual(sub.json.plan.key, 'professional');
  assert.ok(sub.json.user.cyclePoints > 0, 'plano deve gerar pontos');

  const wrongPlan = await call('POST', '/api/plans/subscribe', { plan: 'helper' }, proToken);
  assert.strictEqual(wrongPlan.status, 400);

  const ranking = await call('GET', '/api/ranking');
  assert.strictEqual(ranking.status, 200);
  assert.ok(JSON.stringify(ranking.json).includes('Profissional Teste'), 'ranking deve listar o profissional');
});

test('servico concluido soma obra e aceita avaliacao', async () => {
  const done = await call('POST', '/api/jobs/' + jobId + '/complete', {}, clientToken);
  assert.strictEqual(done.status, 200, JSON.stringify(done.json));
  assert.strictEqual(done.json.job.status, 'concluido');

  const review = await call('POST', '/api/jobs/' + jobId + '/review', {
    stars: 5, comment: 'Otimo trabalho, recomendo.'
  }, clientToken);
  assert.ok([200, 201].includes(review.status), JSON.stringify(review.json));

  const pro = await call('GET', '/api/users/' + proId);
  assert.strictEqual(pro.status, 200);
  assert.strictEqual(pro.json.user.jobsDone, 1);
});

test('administracao exige permissao', async () => {
  const denied = await call('GET', '/api/admin/overview', undefined, clientToken);
  assert.strictEqual(denied.status, 403);

  const login = await call('POST', '/api/auth/login', {
    email: 'admin@domalphaajato.com', password: 'admin123'
  });
  assert.strictEqual(login.status, 200, 'admin do seed deve existir');
  const overview = await call('GET', '/api/admin/overview', undefined, login.json.token);
  assert.strictEqual(overview.status, 200);
  assert.ok(overview.json.users >= 3);
});

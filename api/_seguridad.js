// api/_seguridad.js — utilidades de seguridad compartidas (el "_" evita que Vercel lo exponga como ruta).
//  - cors(): solo tu propio sitio (y la app/localhost) pueden llamar a la API desde un navegador.
//  - limitar(): límite de peticiones REAL (contadores en Redis, válidos entre instancias serverless).
//  - ipDe(): IP del cliente (no se puede falsear desde el cuerpo de la petición, a diferencia de un "usuarioId").
//  - igual(): comparación de secretos en tiempo constante.
const crypto = require('crypto');

const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

async function redis(args) {
  if (!REDIS_URL || !REDIS_TOKEN) throw new Error('sin-redis');
  const r = await fetch(REDIS_URL, { method: 'POST', headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(args) });
  const d = await r.json();
  if (d && d.error) throw new Error(d.error);
  return d ? d.result : null;
}

function ipDe(req) {
  const x = req.headers && req.headers['x-forwarded-for'];
  const ip = x ? String(x).split(',')[0].trim() : (req.socket && req.socket.remoteAddress);
  return String(ip || 'desconocida').slice(0, 64);
}

const EXTRA = ['capacitor://localhost', 'https://localhost', 'http://localhost', 'http://localhost:3000', 'http://127.0.0.1:3000'];
function origenesPermitidos() {
  const l = String(process.env.SITE_URL || '').split(',').map(s => s.trim().replace(/\/$/, '')).filter(Boolean);
  ['VERCEL_URL', 'VERCEL_BRANCH_URL', 'VERCEL_PROJECT_PRODUCTION_URL'].forEach(k => { if (process.env[k]) l.push('https://' + process.env[k]); });
  return l.concat(EXTRA);
}
// Devuelve false si el origen NO está permitido (el handler debe responder 403).
function cors(req, res, metodos) {
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', metodos || 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  const o = req.headers && req.headers.origin;
  if (!o) return true; // misma web o llamada de servidor
  let host = ''; try { host = new URL(o).host; } catch (e) { return false; }
  const ok = host === (req.headers.host || '') || origenesPermitidos().includes(o);
  if (ok) res.setHeader('Access-Control-Allow-Origin', o);
  return ok;
}

const mem = new Map();
async function limitar(clave, max, ventanaSeg) { // true = se ha pasado del límite
  try {
    const k = 'rl:' + clave;
    const n = await redis(['INCR', k]);
    if (n === 1) await redis(['EXPIRE', k, String(ventanaSeg)]);
    return n > max;
  } catch (e) { // sin Redis: límite en memoria (menos fiable, pero algo)
    const ahora = Date.now(), v = (mem.get(clave) || []).filter(t => ahora - t < ventanaSeg * 1000);
    v.push(ahora); mem.set(clave, v); return v.length > max;
  }
}

function igual(a, b) {
  const h = s => crypto.createHash('sha256').update(String(s == null ? '' : s)).digest();
  return crypto.timingSafeEqual(h(a), h(b));
}

module.exports = { redisCmd: redis, redis, ipDe, cors, limitar, igual };

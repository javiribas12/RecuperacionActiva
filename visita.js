// api/visita.js — contador de visitas y búsquedas, anónimo y sin cookies.
// Guarda SOLO totales: visitas por día, páginas vistas, visitantes únicos aproximados (hash con sal que
// cambia cada día, no reversible) y el texto de las búsquedas (sin datos de la persona).
// No guarda IP, ni email, ni nada que identifique a nadie.
const crypto = require('crypto');
const seg = require('../api/_seguridad');

const DIAS_GUARDADO = 120 * 86400;
const hoy = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Madrid' });

module.exports = async function handler(req, res) {
  const origenOk = seg.cors(req, res, 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(origenOk ? 204 : 403).end();
  if (!origenOk) return res.status(403).end();
  if (req.method !== 'POST') return res.status(405).end();
  // Las peticiones de sendBeacon pueden llegar como texto: se acepta JSON o texto JSON.
  let b = req.body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  b = b || {};
  try {
    if (await seg.limitar('visita-ip:' + seg.ipDe(req), 240, 3600)) return res.status(204).end();
    const d = hoy();
    if (b.tipo === 'busqueda') {
      const q = String(b.q || '').replace(/[\u0000-\u001f<>]/g, ' ').trim().slice(0, 80);
      if (q.length < 2) return res.status(204).end();
      await seg.redisCmd(['LPUSH', 'stat:busq', JSON.stringify({ q, t: new Date().toISOString() })]);
      await seg.redisCmd(['LTRIM', 'stat:busq', '0', '199']);
      return res.status(204).end();
    }
    const pagina = String(b.pagina || 'inicio').toLowerCase();
    if (!/^[a-z0-9-]{1,30}$/.test(pagina)) return res.status(204).end();
    const dispositivo = b.movil ? 'movil' : 'ordenador';
    const huella = crypto.createHash('sha256').update(seg.ipDe(req) + '|' + (req.headers['user-agent'] || '') + '|' + d + '|ra').digest('hex').slice(0, 24);
    await seg.redisCmd(['INCR', 'stat:v:' + d]);
    await seg.redisCmd(['HINCRBY', 'stat:p:' + d, pagina, '1']);
    await seg.redisCmd(['HINCRBY', 'stat:d:' + d, dispositivo, '1']);
    await seg.redisCmd(['PFADD', 'stat:uv:' + d, huella]);
    if (b.primera) await seg.redisCmd(['INCR', 'stat:s:' + d]);
    for (const k of ['stat:v:', 'stat:p:', 'stat:d:', 'stat:uv:', 'stat:s:']) await seg.redisCmd(['EXPIRE', k + d, String(DIAS_GUARDADO)]);
  } catch (e) { /* medir nunca debe romper la web */ }
  return res.status(204).end();
};

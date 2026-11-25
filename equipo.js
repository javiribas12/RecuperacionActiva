// api/equipo.js — diario (check-ins y mapa corporal), objetivos funcionales y mensajes con el profesional.
// Claves Redis: usuario:{email}:diario (lista, máx. 400) · usuario:{email}:objetivos · usuario:{email}:mensajes (lista, máx. 200)
// Paciente (requiere sesión): diario-guardar · diario-listar · objetivos-guardar · mensaje-enviar
// Profesional verificado (solo pacientes vinculados): profesional-resumen · profesional-mensaje
const seg = require('../api/_seguridad');
const num = (x, min, max, dec = 0) => { const n = Number(String(x).replace(',', '.')); if (!isFinite(n)) return 0; return Math.round(Math.max(min, Math.min(max, n)) * 10 ** dec) / 10 ** dec; };
const txt = (x, n) => String(x == null ? '' : x).replace(/[<>]/g, '').slice(0, n);
const lista = (a, n, m) => (Array.isArray(a) ? a : []).slice(0, n).map(v => txt(v, m)).filter(Boolean);

function limpiarEntrada(e) {
  if (!e || typeof e !== 'object') return null;
  const f = Number(e.f) || Date.now();
  if (e.tipo === 'checkin') return { tipo: 'checkin', id: txt(e.id, 40) || 'ck-' + f, f, dolor: num(e.dolor, 0, 10), energia: num(e.energia, 1, 5), sueno: num(e.sueno, 1, 5), estres: num(e.estres, 1, 5), carga: num(e.carga, 1, 5), ctx: lista(e.ctx, 8, 30), decision: txt(e.decision, 20), riesgo: !!e.riesgo };
  if (e.tipo === 'mapa') return { tipo: 'mapa', id: txt(e.id, 40) || 'mp-' + f, f, zona: txt(e.zona, 40), lado: txt(e.lado, 10), dolorTipo: txt(e.dolorTipo, 30), intensidad: num(e.intensidad, 0, 10), mejora: lista(e.mejora, 8, 40), empeora: lista(e.empeora, 8, 40), nota: txt(e.nota, 300) };
  return null;
}
function limpiarObjetivos(a) {
  return (Array.isArray(a) ? a : []).slice(0, 10).map(o => ({ id: txt(o.id, 40), texto: txt(o.texto, 120), progreso: num(o.progreso, 0, 100), f: Number(o.f) || Date.now(), hist: (Array.isArray(o.hist) ? o.hist : []).slice(-30).map(h => ({ f: Number(h.f) || 0, p: num(h.p, 0, 100) })) })).filter(o => o.id && o.texto);
}
const parse = a => (a || []).map(s => { try { return JSON.parse(s); } catch (e) { return null; } }).filter(Boolean);
async function emailDe(token) { return token ? await seg.redis(['GET', `sesion:${token}`]) : null; }
async function profesionalDe(token) {
  const email = await emailDe(token); if (!email) return null;
  const raw = await seg.redis(['GET', `cuenta:${email}`]); const c = raw ? JSON.parse(raw) : null;
  return (c && c.rol === 'profesional' && c.profesionalEstado === 'verificado') ? { email, cuenta: c } : null;
}
async function leer(email) {
  const [d, o, m] = await Promise.all([
    seg.redis(['LRANGE', `usuario:${email}:diario`, '0', '399']), seg.redis(['GET', `usuario:${email}:objetivos`]), seg.redis(['LRANGE', `usuario:${email}:mensajes`, '0', '199'])]);
  return { diario: parse(d), objetivos: o ? JSON.parse(o) : [], mensajes: parse(m).sort((a, b) => a.f - b.f) };
}

module.exports = async function handler(req, res) {
  const origenOk = seg.cors(req, res, 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(origenOk ? 204 : 403).end();
  if (!origenOk) return res.status(403).json({ error: 'Origen no permitido.' });
  if (req.method !== 'POST') return res.status(405).json({ error: 'Usa POST.' });
  if (await seg.limitar('equipo-ip:' + seg.ipDe(req), 400, 3600)) return res.status(429).json({ error: 'Demasiadas peticiones.' });
  const { accion, token } = req.body || {};
  try {
    if (['diario-guardar', 'diario-listar', 'objetivos-guardar', 'mensaje-enviar'].includes(accion)) {
      const email = await emailDe(token); if (!email) return res.status(401).json({ error: 'Inicia sesión para sincronizar.' });
      if (accion === 'diario-guardar') {
        const e = limpiarEntrada(req.body.entrada); if (!e) return res.status(400).json({ error: 'Entrada no válida.' });
        await seg.redis(['LPUSH', `usuario:${email}:diario`, JSON.stringify(e)]); await seg.redis(['LTRIM', `usuario:${email}:diario`, '0', '399']);
        return res.status(200).json({ ok: true });
      }
      if (accion === 'objetivos-guardar') { await seg.redis(['SET', `usuario:${email}:objetivos`, JSON.stringify(limpiarObjetivos(req.body.objetivos))]); return res.status(200).json({ ok: true }); }
      if (accion === 'mensaje-enviar') {
        if (await seg.limitar('equipo-msg:' + email, 40, 3600)) return res.status(429).json({ error: 'Demasiados mensajes seguidos.' });
        const raw = await seg.redis(['GET', `cuenta:${email}`]); const c = raw ? JSON.parse(raw) : null;
        if (!c || !c.profesionalVinculado) return res.status(400).json({ error: 'Aún no estás vinculado a un profesional. Pide su código y vincúlate desde tu perfil.' });
        const texto = txt(req.body.texto, 1000).trim(); if (!texto) return res.status(400).json({ error: 'Escribe un mensaje.' });
        const m = { de: 'paciente', f: Date.now(), texto };
        await seg.redis(['LPUSH', `usuario:${email}:mensajes`, JSON.stringify(m)]); await seg.redis(['LTRIM', `usuario:${email}:mensajes`, '0', '199']);
        return res.status(200).json({ ok: true });
      }
      const raw = await seg.redis(['GET', `cuenta:${email}`]); const c = raw ? JSON.parse(raw) : null;
      const out = await leer(email); out.profesional = c && c.profesionalVinculado ? c.profesionalVinculado : null;
      if (out.profesional) { const rp = await seg.redis(['GET', `cuenta:${out.profesional}`]); const cp = rp ? JSON.parse(rp) : null; out.profesionalNombre = cp ? cp.nombre : out.profesional; }
      return res.status(200).json(out);
    }
    if (accion && accion.indexOf('profesional-') === 0) {
      const pro = await profesionalDe(token); if (!pro) return res.status(403).json({ error: 'Solo disponible para profesionales verificados.' });
      const paciente = String(req.body.pacienteEmail || '').trim().toLowerCase();
      if (!(await seg.redis(['SISMEMBER', `profesional:${pro.email}:pacientes`, paciente]))) return res.status(403).json({ error: 'Ese paciente no está vinculado a ti.' });
      if (accion === 'profesional-resumen') return res.status(200).json(await leer(paciente));
      if (accion === 'profesional-mensaje') {
        const texto = txt(req.body.texto, 1000).trim(); if (!texto) return res.status(400).json({ error: 'Escribe un mensaje.' });
        const m = { de: 'profesional', f: Date.now(), texto, por: txt(pro.cuenta.nombre || pro.email, 60), revision: !!req.body.revision };
        await seg.redis(['LPUSH', `usuario:${paciente}:mensajes`, JSON.stringify(m)]); await seg.redis(['LTRIM', `usuario:${paciente}:mensajes`, '0', '199']);
        return res.status(200).json({ ok: true });
      }
    }
    return res.status(400).json({ error: 'Acción no reconocida.' });
  } catch (err) { console.error('Error en api/equipo:', err); return res.status(502).json({ error: 'No se ha podido completar la operación ahora mismo.' }); }
};

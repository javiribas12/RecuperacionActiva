// api/entrenos.js — entrenos con pesos/series/repeticiones, y rutinas pautadas por el profesional.
// Claves Redis: usuario:{id}:entrenos (lista, máx. 300) · usuario:{id}:rutina (pauta del profesional)
// Acciones paciente:     guardar · listar · borrar
// Acciones profesional:  profesional-listar · profesional-pautar · profesional-quitar-pauta
// El profesional SOLO puede ver/modificar a pacientes vinculados a él (por su código de vinculación).
const seg = require('./_seguridad');
const ID_ANON = /^anon-[a-z0-9]{8,64}$/;
const MAX = 300;

const num = (x, min, max, dec = 2) => { const n = Number(String(x).replace(',', '.')); if (!isFinite(n)) return 0; const v = Math.max(min, Math.min(max, n)); return Math.round(v * 10 ** dec) / 10 ** dec; };
const txt = (x, n) => String(x == null ? '' : x).replace(/[<>]/g, '').slice(0, n);

function limpiarEntreno(e) {
  if (!e || typeof e !== 'object') return null;
  const ejercicios = (Array.isArray(e.ejercicios) ? e.ejercicios : []).slice(0, 25).map(x => ({
    id: txt(x.id, 60), nombre: txt(x.nombre, 100), unidad: x.unidad === 's' ? 's' : 'rep',
    dolor: !!x.dolor,
    sets: (Array.isArray(x.sets) ? x.sets : []).slice(0, 15).map(s => ({ kg: num(s.kg, 0, 1000, 1), reps: num(s.reps, 0, 500, 0), ok: !!s.ok })).filter(s => s.reps > 0 || s.kg > 0)
  })).filter(x => x.id && x.sets.length);
  if (!ejercicios.length) return null;
  return {
    id: txt(e.id, 60) || ('en-' + Date.now()), f: Number(e.f) || Date.now(), espacio: txt(e.espacio, 20), rutina: txt(e.rutina, 40), nombre: txt(e.nombre, 100),
    pauta: !!e.pauta, sens: num(e.sens, 0, 5, 0), nota: txt(e.nota, 500), ejercicios
  };
}
function limpiarRutina(r) {
  if (!r || typeof r !== 'object') return null;
  const ejercicios = (Array.isArray(r.ejercicios) ? r.ejercicios : []).slice(0, 25).map(x => ({
    id: txt(x.id, 60), series: num(x.series, 1, 12, 0), repMin: num(x.repMin, 1, 100, 0), repMax: num(x.repMax, 1, 200, 0), kg: x.kg === '' || x.kg == null ? null : num(x.kg, 0, 1000, 1), nota: txt(x.nota, 200)
  })).filter(x => x.id);
  if (!ejercicios.length) return null;
  return { nombre: txt(r.nombre, 100) || 'Rutina pautada', espacio: txt(r.espacio, 20), nota: txt(r.nota, 600), ejercicios, f: Date.now() };
}

async function identidad(token, usuarioId) {
  if (token) { const email = await seg.redis(['GET', `sesion:${token}`]); if (email) return { id: email, email }; }
  if (typeof usuarioId === 'string' && ID_ANON.test(usuarioId)) return { id: usuarioId, email: null };
  return null;
}
async function profesionalDe(token) {
  if (!token) return null;
  const email = await seg.redis(['GET', `sesion:${token}`]); if (!email) return null;
  const raw = await seg.redis(['GET', `cuenta:${email}`]); const c = raw ? JSON.parse(raw) : null;
  return (c && c.rol === 'profesional' && c.profesionalEstado === 'verificado') ? { email, cuenta: c } : null;
}
const parse = a => (a || []).map(s => { try { return JSON.parse(s); } catch (e) { return null; } }).filter(Boolean);

module.exports = async function handler(req, res) {
  const origenOk = seg.cors(req, res, 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(origenOk ? 204 : 403).end();
  if (!origenOk) return res.status(403).json({ error: 'Origen no permitido.' });
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido. Usa POST.' });
  if (await seg.limitar('entrenos-ip:' + seg.ipDe(req), 400, 3600)) return res.status(429).json({ error: 'Demasiadas peticiones.' });
  const { accion, token, usuarioId } = req.body || {};
  try {
    if (accion === 'guardar' || accion === 'listar' || accion === 'borrar') {
      const who = await identidad(token, usuarioId);
      if (!who) return res.status(401).json({ error: 'Inicia sesión para sincronizar tus entrenos.' });
      const key = `usuario:${who.id}:entrenos`;
      if (accion === 'guardar') {
        const e = limpiarEntreno(req.body.entreno);
        if (!e) return res.status(400).json({ error: 'El entreno no tiene series válidas.' });
        // si ya existía (mismo id) se sustituye, para poder corregir un entreno
        const actuales = parse(await seg.redis(['LRANGE', key, '0', String(MAX - 1)]));
        const otros = actuales.filter(x => x.id !== e.id);
        otros.unshift(e); otros.sort((a, b) => b.f - a.f);
        await seg.redis(['DEL', key]);
        const lote = otros.slice(0, MAX).reverse().map(x => JSON.stringify(x));
        for (let i = 0; i < lote.length; i += 50) await seg.redis(['LPUSH', key, ...lote.slice(i, i + 50)]);
        await seg.redis(['SADD', 'indice:usuarios', who.id]);
        return res.status(200).json({ ok: true });
      }
      if (accion === 'borrar') {
        const id = txt(req.body.id, 60);
        const actuales = parse(await seg.redis(['LRANGE', key, '0', String(MAX - 1)])).filter(x => x.id !== id);
        await seg.redis(['DEL', key]);
        const lote = actuales.reverse().map(x => JSON.stringify(x));
        for (let i = 0; i < lote.length; i += 50) await seg.redis(['LPUSH', key, ...lote.slice(i, i + 50)]);
        return res.status(200).json({ ok: true });
      }
      const entrenos = parse(await seg.redis(['LRANGE', key, '0', String(MAX - 1)]));
      const rr = await seg.redis(['GET', `usuario:${who.id}:rutina`]);
      return res.status(200).json({ entrenos, rutina: rr ? JSON.parse(rr) : null });
    }

    if (accion && accion.indexOf('profesional-') === 0) {
      const pro = await profesionalDe(token);
      if (!pro) return res.status(403).json({ error: 'Solo disponible para profesionales verificados.' });
      const paciente = String(req.body.pacienteEmail || '').trim().toLowerCase();
      const vinculado = await seg.redis(['SISMEMBER', `profesional:${pro.email}:pacientes`, paciente]);
      if (!vinculado) return res.status(403).json({ error: 'Ese paciente no está vinculado a ti.' });
      if (accion === 'profesional-listar') {
        const entrenos = parse(await seg.redis(['LRANGE', `usuario:${paciente}:entrenos`, '0', String(MAX - 1)]));
        const rr = await seg.redis(['GET', `usuario:${paciente}:rutina`]);
        return res.status(200).json({ entrenos, rutina: rr ? JSON.parse(rr) : null });
      }
      if (accion === 'profesional-pautar') {
        const r = limpiarRutina(req.body.rutina); if (!r) return res.status(400).json({ error: 'La rutina no tiene ejercicios válidos.' });
        r.por = pro.cuenta.nombre || pro.email;
        await seg.redis(['SET', `usuario:${paciente}:rutina`, JSON.stringify(r)]);
        return res.status(200).json({ ok: true });
      }
      if (accion === 'profesional-quitar-pauta') { await seg.redis(['DEL', `usuario:${paciente}:rutina`]); return res.status(200).json({ ok: true }); }
    }
    return res.status(400).json({ error: 'Acción no reconocida.' });
  } catch (err) {
    console.error('Error en api/entrenos:', err);
    return res.status(502).json({ error: 'No se ha podido completar la operación ahora mismo.' });
  }
};

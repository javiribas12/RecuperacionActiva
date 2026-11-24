// api/grupos.js — grupos/equipos de un entrenador: cargas de cada jugador, evolución y entrenos para todo el grupo.
// Claves Redis: profesional:{email}:grupos (JSON [{id,nombre,miembros:[email]}]) · usa los datos de api/entrenos.js y api/equipo.js
// Acciones (solo profesional/entrenador verificado; solo ve a sus pacientes vinculados):
//   grupos-listar · grupo-crear · grupo-borrar · grupo-asignar · grupo-pautar
const seg = require('./_seguridad');
const DIA = 864e5;
const txt = (x, n) => String(x == null ? '' : x).replace(/[<>]/g, '').slice(0, n);
const num = (x, min, max, dec = 0) => { const n = Number(String(x).replace(',', '.')); if (!isFinite(n)) return 0; return Math.round(Math.max(min, Math.min(max, n)) * 10 ** dec) / 10 ** dec; };
const parse = a => (a || []).map(s => { try { return JSON.parse(s); } catch (e) { return null; } }).filter(Boolean);

async function profesionalDe(token) {
  if (!token) return null;
  const email = await seg.redis(['GET', `sesion:${token}`]); if (!email) return null;
  const raw = await seg.redis(['GET', `cuenta:${email}`]); const c = raw ? JSON.parse(raw) : null;
  return (c && c.rol === 'profesional' && c.profesionalEstado === 'verificado') ? { email, cuenta: c } : null;
}
function limpiarRutina(r) {
  if (!r || typeof r !== 'object') return null;
  const ejercicios = (Array.isArray(r.ejercicios) ? r.ejercicios : []).slice(0, 25).map(x => ({
    id: txt(x.id, 60), series: num(x.series, 1, 12), repMin: num(x.repMin, 1, 100), repMax: num(x.repMax, 1, 200), kg: x.kg === '' || x.kg == null ? null : num(x.kg, 0, 1000, 1), nota: txt(x.nota, 200)
  })).filter(x => x.id);
  if (!ejercicios.length) return null;
  return { nombre: txt(r.nombre, 100) || 'Entreno del grupo', espacio: txt(r.espacio, 20), nota: txt(r.nota, 600), ejercicios, f: Date.now() };
}
// Carga de un jugador: volumen (kg×reps de series hechas) de los últimos 7 días frente a su media semanal de los últimos 28.
function resumenCarga(entrenos, diario) {
  const ahora = Date.now();
  const vol = e => (e.ejercicios || []).reduce((t, x) => t + (x.sets || []).filter(s => s.ok !== false).reduce((u, s) => u + (Number(s.kg) || 1) * (Number(s.reps) || 0), 0), 0);
  const s7 = entrenos.filter(e => ahora - e.f < 7 * DIA), s28 = entrenos.filter(e => ahora - e.f < 28 * DIA);
  const agudo = s7.reduce((t, e) => t + vol(e), 0);
  const cronico = s28.reduce((t, e) => t + vol(e), 0) / 4;
  const ratio = cronico > 0 ? Math.round((agudo / cronico) * 100) / 100 : null;
  const dolor = s7.filter(e => (e.ejercicios || []).some(x => x.dolor)).length;
  const ultimo = entrenos.length ? Math.max(...entrenos.map(e => e.f)) : null;
  const ck = (diario || []).filter(d => d.tipo === 'checkin' && ahora - d.f < 7 * DIA);
  const dolorMax = ck.length ? Math.max(...ck.map(c => c.dolor || 0)) : null;
  let nivel = 'ok', motivo = '';
  if (dolor >= 2 || (dolorMax != null && dolorMax >= 7)) { nivel = 'alto'; motivo = 'Dolor marcado esta semana'; }
  else if (ratio != null && ratio > 1.5) { nivel = 'alto'; motivo = 'Subida de carga brusca (>1,5× su media)'; }
  else if (dolor === 1 || (ratio != null && ratio > 1.3)) { nivel = 'atencion'; motivo = ratio > 1.3 ? 'Carga algo por encima de su media' : 'Ha marcado dolor en un ejercicio'; }
  else if (!s7.length && s28.length) { nivel = 'atencion'; motivo = 'Sin entrenar esta semana'; }
  const semanas = [3, 2, 1, 0].map(i => entrenos.filter(e => ahora - e.f >= i * 7 * DIA && ahora - e.f < (i + 1) * 7 * DIA).reduce((t, e) => t + vol(e), 0));
  return { sesiones7: s7.length, sesiones28: s28.length, agudo: Math.round(agudo), cronico: Math.round(cronico), ratio, dolor7: dolor, dolorMax, ultimo, nivel, motivo, semanas };
}

module.exports = async function handler(req, res) {
  const origenOk = seg.cors(req, res, 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(origenOk ? 204 : 403).end();
  if (!origenOk) return res.status(403).json({ error: 'Origen no permitido.' });
  if (req.method !== 'POST') return res.status(405).json({ error: 'Usa POST.' });
  if (await seg.limitar('grupos-ip:' + seg.ipDe(req), 300, 3600)) return res.status(429).json({ error: 'Demasiadas peticiones.' });
  const { accion, token } = req.body || {};
  try {
    const pro = await profesionalDe(token);
    if (!pro) return res.status(403).json({ error: 'Solo disponible para entrenadores y profesionales verificados.' });
    const kG = `profesional:${pro.email}:grupos`;
    const leerG = async () => { const r = await seg.redis(['GET', kG]); try { return r ? JSON.parse(r) : []; } catch (e) { return []; } };
    const mios = (await seg.redis(['SMEMBERS', `profesional:${pro.email}:pacientes`])) || [];
    let grupos = await leerG();
    const guardar = () => seg.redis(['SET', kG, JSON.stringify(grupos)]);

    if (accion === 'grupo-crear') {
      const nombre = txt(req.body.nombre, 50).trim(); if (!nombre) return res.status(400).json({ error: 'Pon un nombre al grupo.' });
      if (grupos.length >= 30) return res.status(400).json({ error: 'Máximo 30 grupos.' });
      if (grupos.some(g => g.nombre.toLowerCase() === nombre.toLowerCase())) return res.status(400).json({ error: 'Ya tienes un grupo con ese nombre.' });
      grupos.push({ id: 'g' + Date.now().toString(36), nombre, miembros: [] }); await guardar();
      return res.status(200).json({ ok: true, grupos });
    }
    if (accion === 'grupo-borrar') { grupos = grupos.filter(g => g.id !== req.body.id); await guardar(); return res.status(200).json({ ok: true, grupos }); }
    if (accion === 'grupo-asignar') {
      const p = String(req.body.pacienteEmail || '').trim().toLowerCase();
      if (!mios.includes(p)) return res.status(403).json({ error: 'Ese jugador no está vinculado a ti.' });
      grupos.forEach(g => { g.miembros = g.miembros.filter(m => m !== p); });
      const g = grupos.find(x => x.id === req.body.id); if (g) g.miembros.push(p);
      await guardar(); return res.status(200).json({ ok: true, grupos });
    }
    if (accion === 'grupo-pautar') {
      const g = grupos.find(x => x.id === req.body.id); if (!g) return res.status(404).json({ error: 'Grupo no encontrado.' });
      const r = limpiarRutina(req.body.rutina); if (!r) return res.status(400).json({ error: 'El entreno no tiene ejercicios válidos.' });
      r.por = pro.cuenta.nombre || pro.email;
      const dest = g.miembros.filter(m => mios.includes(m));
      for (const m of dest) await seg.redis(['SET', `usuario:${m}:rutina`, JSON.stringify(r)]);
      return res.status(200).json({ ok: true, enviados: dest.length });
    }
    if (accion === 'jugador-lesion') {
      const p = String(req.body.pacienteEmail || '').trim().toLowerCase();
      if (!mios.includes(p)) return res.status(403).json({ error: 'Ese jugador no está vinculado a ti.' });
      const l = req.body.lesion;
      if (!l || !l.zona) { await seg.redis(['DEL', `usuario:${p}:lesion-entrenador`]); return res.status(200).json({ ok: true, lesion: null }); }
      const les = { zona: txt(l.zona, 60), nota: txt(l.nota, 300), estado: l.estado === 'vuelta' ? 'vuelta' : 'activa', f: Date.now() };
      await seg.redis(['SET', `usuario:${p}:lesion-entrenador`, JSON.stringify(les)]);
      return res.status(200).json({ ok: true, lesion: les });
    }
    if (accion === 'jugador-quitar') {
      const p = String(req.body.pacienteEmail || '').trim().toLowerCase();
      if (!mios.includes(p)) return res.status(403).json({ error: 'Ese jugador no está vinculado a ti.' });
      await seg.redis(['SREM', `profesional:${pro.email}:pacientes`, p]);
      grupos.forEach(g => { g.miembros = g.miembros.filter(m => m !== p); }); await guardar();
      const rc = await seg.redis(['GET', `cuenta:${p}`]); if (rc) { const c = JSON.parse(rc); if (c.profesionalVinculado === pro.email) { delete c.profesionalVinculado; await seg.redis(['SET', `cuenta:${p}`, JSON.stringify(c)]); } }
      return res.status(200).json({ ok: true });
    }
    if (accion === 'grupos-listar') {
      const jugadores = [];
      for (const email of mios) {
        const [rc, en, di, ls] = await Promise.all([seg.redis(['GET', `cuenta:${email}`]), seg.redis(['LRANGE', `usuario:${email}:entrenos`, '0', '299']), seg.redis(['LRANGE', `usuario:${email}:diario`, '0', '60']), seg.redis(['GET', `usuario:${email}:lesion-entrenador`])]);
        let lesion = null; try { lesion = ls ? JSON.parse(ls) : null; } catch (e) {}
        const c = rc ? JSON.parse(rc) : null;
        const g = grupos.find(x => x.miembros.includes(email));
        jugadores.push(Object.assign({ email, nombre: c ? c.nombre : email, grupo: g ? g.id : '', lesion }, resumenCarga(parse(en), parse(di))));
      }
      return res.status(200).json({ codigo: pro.cuenta.codigoVinculacion || null, club: (pro.cuenta.profesionalDatos || {}).centro || '', grupos, jugadores });
    }
    return res.status(400).json({ error: 'Acción no reconocida.' });
  } catch (err) {
    console.error('Error en api/grupos:', err);
    return res.status(502).json({ error: 'No se ha podido completar la operación ahora mismo.' });
  }
};

// api/progreso.js
// Guarda y lee el progreso real de cada persona (sesiones completadas) en una
// base de datos Redis (Upstash, vía el Marketplace de Vercel). Antes esto solo
// vivía en localStorage del navegador de cada persona — con esto, el creador
// de la web puede verlo desde /admin/usuarios, y la persona puede ver su
// progreso aunque cambie de dispositivo.
//
// Requiere que en Vercel tengas conectada una integración de Redis (por
// ejemplo Upstash Redis, desde el Marketplace de Vercel). Comprueba en tu
// panel qué nombre exacto tienen las variables de entorno que te genera —
// este archivo acepta los dos nombres habituales.

const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

// Ejecuta un comando de Redis a través de la API REST (formato de comando en un array JSON,
// por ejemplo ["SET", "clave", "valor"]). Devuelve el campo "result" de la respuesta.
async function comandoRedis(args) {
  if (!REDIS_URL || !REDIS_TOKEN) {
    throw new Error('Redis no está configurado: faltan las variables de entorno de la base de datos.');
  }
  const r = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args)
  });
  const data = await r.json();
  if (data && data.error) throw new Error(data.error);
  return data ? data.result : null;
}

const MAX_SESIONES_POR_USUARIO = 200; // límite razonable para no crecer sin fin

// Si viene un token de sesión real (persona con cuenta), resuelve a su email y usa eso
// como identificador — así su progreso es el mismo en cualquier dispositivo donde inicie
// sesión. Si no hay token válido, se usa el ID anónimo de siempre (solo ese navegador).
const ID_ANON = /^anon-[a-z0-9]{8,64}$/;   // los ids anónimos nunca pueden ser un email ni imitar a una cuenta
async function resolverIdentidad(usuarioId, token) {
  if (token) {
    try {
      const email = await comandoRedis(['GET', `sesion:${token}`]);
      if (email) return email;
    } catch (e) { /* si falla la consulta, cae al ID anónimo de más abajo */ }
  }
  return (typeof usuarioId === 'string' && ID_ANON.test(usuarioId)) ? usuarioId : null;
}

const seg = require('../api/_seguridad');

module.exports = async function handler(req, res) {
  const origenOk = seg.cors(req, res, 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(origenOk ? 204 : 403).end();
  if (!origenOk) return res.status(403).json({ error: 'Origen no permitido.' });

  if (!REDIS_URL || !REDIS_TOKEN) {
    return res.status(500).json({ error: 'La base de datos de progreso no está configurada todavía en este servidor.' });
  }

  if (await seg.limitar('progreso-ip:' + seg.ipDe(req), 300, 3600)) return res.status(429).json({ error: 'Demasiadas peticiones.' });
  try {
    if (req.method === 'GET') {
      const usuarioId = req.query && req.query.usuarioId;
      const token = req.query && req.query.token;
      const id = await resolverIdentidad(usuarioId, token);
      if (!id) {
        return res.status(400).json({ error: 'Falta el parámetro usuarioId (o un token de sesión válido).' });
      }
      const perfilRaw = await comandoRedis(['GET', `usuario:${id}:perfil`]);
      const sesionesRaw = await comandoRedis(['LRANGE', `usuario:${id}:sesiones`, '0', String(MAX_SESIONES_POR_USUARIO - 1)]);
      const perfil = perfilRaw ? JSON.parse(perfilRaw) : null;
      const sesiones = (sesionesRaw || []).map(s => { try { return JSON.parse(s); } catch (e) { return null; } }).filter(Boolean);
      const tecnicaRaw = await comandoRedis(['LRANGE', `usuario:${id}:tecnica`, '0', '99']);
      const tecnica = (tecnicaRaw || []).map(s => { try { return JSON.parse(s); } catch (e) { return null; } }).filter(Boolean);
      return res.status(200).json({ perfil, sesiones, tecnica });
    }

    if (req.method === 'POST') {
      const { usuarioId, nombreCuenta, sesion, token, tecnica } = req.body || {};
      const id = await resolverIdentidad(usuarioId, token);
      if (!id) {
        return res.status(400).json({ error: 'Falta el campo usuarioId (o un token de sesión válido).' });
      }
      const ahora = new Date().toISOString();

      // Guarda/actualiza el perfil (nombre + primera vez visto + última actividad)
      const perfilExistenteRaw = await comandoRedis(['GET', `usuario:${id}:perfil`]);
      const perfilExistente = perfilExistenteRaw ? JSON.parse(perfilExistenteRaw) : null;
      const perfil = {
        nombreCuenta: (nombreCuenta && String(nombreCuenta).slice(0, 60)) || (perfilExistente ? perfilExistente.nombreCuenta : 'Sin nombre'),
        primeraVez: perfilExistente ? perfilExistente.primeraVez : ahora,
        ultimaActividad: ahora
      };
      await comandoRedis(['SET', `usuario:${id}:perfil`, JSON.stringify(perfil)]);

      // Mantiene un índice de todos los usuarios que han guardado progreso alguna vez (para el panel de admin)
      await comandoRedis(['SADD', 'indice:usuarios', id]);

      // Si viene una sesión nueva, la añade al historial de esa persona (y recorta si se pasa del máximo)
      if (sesion && Array.isArray(sesion.ejercicios) && sesion.ejercicios.length) {
        const sesionGuardada = {
          id: sesion.id || ('sesion-' + Date.now()),
          fecha: sesion.fecha || ahora,
          ejercicios: sesion.ejercicios.slice(0, 30).map(e => String(e).slice(0, 120))
        };
        await comandoRedis(['LPUSH', `usuario:${id}:sesiones`, JSON.stringify(sesionGuardada)]);
        await comandoRedis(['LTRIM', `usuario:${id}:sesiones`, '0', String(MAX_SESIONES_POR_USUARIO - 1)]);
        await comandoRedis(['INCR', 'indice:total-sesiones']);
      }

      // Análisis de técnica con la cámara (solo resultados numéricos; el vídeo nunca sale del dispositivo)
      if (tecnica && typeof tecnica === 'object' && tecnica.ej) {
        const lim = (x, n) => String(x == null ? '' : x).slice(0, n);
        const reg = {
          f: Number(tecnica.f) || Date.now(), ej: lim(tecnica.ej, 80), nombre: lim(tecnica.nombre, 120),
          v: lim(tecnica.v, 20), p: tecnica.p == null ? null : Math.max(0, Math.min(100, Number(tecnica.p) || 0)),
          reps: Math.max(0, Math.min(999, Number(tecnica.reps) || 0)),
          m: (Array.isArray(tecnica.m) ? tecnica.m : []).slice(0, 12).map(x => ({ n: lim(x.n, 120), v: Number(x.v) || 0, u: lim(x.u, 8), e: lim(x.e, 12), t: lim(x.t, 300) }))
        };
        await comandoRedis(['LPUSH', `usuario:${id}:tecnica`, JSON.stringify(reg)]);
        await comandoRedis(['LTRIM', `usuario:${id}:tecnica`, '0', '99']);
        await comandoRedis(['SADD', 'indice:usuarios', id]);
      }

      return res.status(200).json({ ok: true, perfil });
    }

    return res.status(405).json({ error: 'Método no permitido. Usa GET o POST.' });
  } catch (err) {
    console.error('Error en api/progreso:', err);
    return res.status(502).json({ error: 'No se pudo guardar o leer el progreso ahora mismo. Inténtalo de nuevo en un momento.' });
  }
};

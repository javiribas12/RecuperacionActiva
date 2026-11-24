// api/admin-resumen.js
// Devuelve un resumen agregado del progreso de TODAS las personas que han
// usado la web, para que el creador (Javier) pueda verlo desde /admin/usuarios.
// Protegido con una contraseña simple guardada en la variable de entorno
// ADMIN_PASSWORD — no es un sistema de login con usuarios, es un candado
// básico para que no cualquiera con la URL vea los datos.

const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

async function comandoRedis(args) {
  const r = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args)
  });
  const data = await r.json();
  if (data && data.error) throw new Error(data.error);
  return data ? data.result : null;
}

const MAX_USUARIOS_DETALLE = 100; // por si hay muchísimos usuarios, no cargues todos a la vez
const MAX_PAGOS_DETALLE = 200;

const seg = require('./_seguridad');

module.exports = async function handler(req, res) {
  const origenOk = seg.cors(req, res, 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(origenOk ? 204 : 403).end();
  if (!origenOk) return res.status(403).json({ error: 'Origen no permitido.' });
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido. Usa POST.' });

  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminPassword) {
    return res.status(500).json({ error: 'No has configurado ADMIN_PASSWORD en el servidor todavía, así que este panel está bloqueado por seguridad.' });
  }

  const { password } = req.body || {};
  if (await seg.limitar('admin-ip:' + seg.ipDe(req), 10, 900)) return res.status(429).json({ error: 'Demasiados intentos. Espera 15 minutos.' });
  if (!seg.igual(password, adminPassword)) {
    return res.status(401).json({ error: 'Contraseña incorrecta.' });
  }

  if (!REDIS_URL || !REDIS_TOKEN) {
    return res.status(500).json({ error: 'La base de datos de progreso no está configurada todavía en este servidor.' });
  }

  try {
    const usuarioIds = (await comandoRedis(['SMEMBERS', 'indice:usuarios'])) || [];
    const totalSesiones = (await comandoRedis(['GET', 'indice:total-sesiones'])) || 0;

    const idsAMostrar = usuarioIds.slice(0, MAX_USUARIOS_DETALLE);
    const usuarios = [];
    for (const usuarioId of idsAMostrar) {
      const perfilRaw = await comandoRedis(['GET', `usuario:${usuarioId}:perfil`]);
      const numSesiones = await comandoRedis(['LLEN', `usuario:${usuarioId}:sesiones`]);
      const ultimaSesionRaw = await comandoRedis(['LINDEX', `usuario:${usuarioId}:sesiones`, '0']);
      const tecRaw = (await comandoRedis(['LRANGE', `usuario:${usuarioId}:tecnica`, '0', '4'])) || [];
      const ultimasTecnicas = tecRaw.map(t => { try { const o = JSON.parse(t); return { f: o.f, nombre: o.nombre, p: o.p, v: o.v, m: (o.m || []).filter(x => x.e !== 'ok').slice(0, 3).map(x => x.n) }; } catch (e) { return null; } }).filter(Boolean);
      const perfil = perfilRaw ? JSON.parse(perfilRaw) : { nombreCuenta: 'Sin nombre', primeraVez: null, ultimaActividad: null };
      let ultimaSesion = null;
      if (ultimaSesionRaw) { try { ultimaSesion = JSON.parse(ultimaSesionRaw); } catch (e) { /* ignorar entradas corruptas */ } }
      usuarios.push({
        usuarioId,
        nombreCuenta: perfil.nombreCuenta,
        primeraVez: perfil.primeraVez,
        ultimaActividad: perfil.ultimaActividad,
        numSesiones: numSesiones || 0,
        ultimosEjercicios: ultimaSesion ? ultimaSesion.ejercicios : [],
        ultimasTecnicas
      });
    }
    usuarios.sort((a, b) => new Date(b.ultimaActividad || 0) - new Date(a.ultimaActividad || 0));

    // --- Pagos de sesiones (fisio/entreno), guardados por el webhook de Stripe ---
    const idsPagos = ((await comandoRedis(['SMEMBERS', 'indice:pagos-sesion'])) || []).slice(0, MAX_PAGOS_DETALLE);
    const pagos = [];
    let ingresosTotalesCentimos = 0;
    for (const stripeSessionId of idsPagos) {
      const raw = await comandoRedis(['GET', `pago:sesion:${stripeSessionId}`]);
      if (!raw) continue;
      let registro;
      try { registro = JSON.parse(raw); } catch (e) { continue; }
      ingresosTotalesCentimos += Number(registro.importeCentimos) || 0;
      pagos.push({
        nombre: registro.nombre, email: registro.email, tipoSesion: registro.tipoSesion,
        espacio: registro.espacio, fechaISO: registro.fechaISO, hora: registro.hora,
        importeCentimos: registro.importeCentimos, pagadoEn: registro.pagadoEn
      });
    }
    pagos.sort((a, b) => new Date(b.pagadoEn || 0) - new Date(a.pagadoEn || 0));

    // Valoraciones del chat (👍/👎) — guardadas por cualquier persona que las pulse, no solo en
    // el dispositivo del administrador. Las más recientes primero (LPUSH ya las deja así).
    const MAX_VALORACIONES_DETALLE = 200;
    const valoracionesRaw = (await comandoRedis(['LRANGE', 'valoraciones-chat', '0', String(MAX_VALORACIONES_DETALLE - 1)])) || [];
    const valoraciones = valoracionesRaw.map(v => { try { return JSON.parse(v); } catch (e) { return null; } }).filter(Boolean);
    const totalValoraciones = (await comandoRedis(['LLEN', 'valoraciones-chat'])) || 0;

    return res.status(200).json({
      totalUsuarios: usuarioIds.length,
      totalSesiones: Number(totalSesiones) || 0,
      usuarios,
      truncado: usuarioIds.length > MAX_USUARIOS_DETALLE,
      totalPagos: pagos.length,
      ingresosTotalesCentimos,
      pagos,
      pagosTruncado: idsPagos.length > MAX_PAGOS_DETALLE,
      valoraciones,
      totalValoraciones: Number(totalValoraciones) || 0,
      valoracionesTruncado: Number(totalValoraciones) > MAX_VALORACIONES_DETALLE,
      generadoEn: new Date().toISOString()
    });
  } catch (err) {
    console.error('Error en api/admin-resumen:', err);
    return res.status(502).json({ error: 'No se pudo leer el resumen ahora mismo. Inténtalo de nuevo en un momento.' });
  }
};

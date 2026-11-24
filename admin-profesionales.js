// api/admin-profesionales.js
// Panel de administrador para verificar manualmente a los profesionales que se
// registran diciendo trabajar en una mutua/centro. No existe una forma automática
// de comprobar que alguien es de verdad quien dice ser (eso requeriría un servicio
// externo de verificación de identidad), así que la verificación real es que TÚ,
// como responsable del centro, revises los datos que ha dado la persona (mutua,
// centro, número de colegiado) y decidas si los apruebas o no — igual que harías
// si alguien te lo pidiera en persona.
//
// Gated por la misma ADMIN_PASSWORD que ya usa api/admin-resumen.js.

const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

async function comandoRedis(args) {
  if (!REDIS_URL || !REDIS_TOKEN) throw new Error('Redis no está configurado.');
  const r = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args)
  });
  const data = await r.json();
  if (data && data.error) throw new Error(data.error);
  return data ? data.result : null;
}

function generarCodigo() {
  const alfabeto = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sin caracteres que se confundan (0/O, 1/I/L)
  let codigo = '';
  for (let i = 0; i < 6; i++) codigo += alfabeto[Math.floor(Math.random() * alfabeto.length)];
  return codigo;
}

async function enviarEmailResend(email, asunto, html) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { enviado: false };
  const remitente = process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev';
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: `Recuperación Activa <${remitente}>`, to: email, subject: asunto, html })
    });
    return { enviado: r.ok };
  } catch (err) {
    return { enviado: false, motivo: err.message };
  }
}

const seg = require('./_seguridad');

module.exports = async function handler(req, res) {
  const origenOk = seg.cors(req, res, 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(origenOk ? 204 : 403).end();
  if (!origenOk) return res.status(403).json({ error: 'Origen no permitido.' });
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido. Usa POST.' });

  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminPassword) return res.status(500).json({ error: 'No has configurado ADMIN_PASSWORD en el servidor todavía, así que este panel está bloqueado por seguridad.' });

  const { password, accion, email } = req.body || {};
  if (await seg.limitar('admin-ip:' + seg.ipDe(req), 10, 900)) return res.status(429).json({ error: 'Demasiados intentos. Espera 15 minutos.' });
  if (!seg.igual(password, adminPassword)) return res.status(401).json({ error: 'Contraseña incorrecta.' });

  if (!REDIS_URL || !REDIS_TOKEN) return res.status(500).json({ error: 'La base de datos no está configurada todavía en este servidor.' });

  try {
    if (accion === 'listar' || !accion) {
      const emails = (await comandoRedis(['SMEMBERS', 'indice:profesionales-pendientes'])) || [];
      const pendientes = [];
      for (const e of emails) {
        const raw = await comandoRedis(['GET', `cuenta:${e}`]);
        if (!raw) continue;
        const c = JSON.parse(raw);
        if (c.profesionalEstado !== 'pendiente') continue; // ya se decidió, no debería seguir en el índice, pero por si acaso
        pendientes.push({ email: c.email, nombre: c.nombre, profesionalDatos: c.profesionalDatos, fechaRegistro: c.fechaRegistro });
      }
      pendientes.sort((a, b) => new Date(a.fechaRegistro || 0) - new Date(b.fechaRegistro || 0));
      return res.status(200).json({ pendientes });
    }

    if (accion === 'aprobar' || accion === 'rechazar') {
      if (!email || typeof email !== 'string') return res.status(400).json({ error: 'Falta el email del profesional.' });
      const emailNorm = email.trim().toLowerCase();
      const raw = await comandoRedis(['GET', `cuenta:${emailNorm}`]);
      if (!raw) return res.status(404).json({ error: 'No existe esa cuenta.' });
      const cuenta = JSON.parse(raw);
      if (cuenta.rol !== 'profesional') return res.status(400).json({ error: 'Esa cuenta no es de un profesional.' });

      await comandoRedis(['SREM', 'indice:profesionales-pendientes', emailNorm]);

      if (accion === 'aprobar') {
        let codigo = generarCodigo();
        // Improbable, pero por si el código generado ya existiera, se reintenta unas pocas veces.
        for (let intento = 0; intento < 5; intento++) {
          const yaExiste = await comandoRedis(['GET', `vinculo:${codigo}`]);
          if (!yaExiste) break;
          codigo = generarCodigo();
        }
        cuenta.profesionalEstado = 'verificado';
        cuenta.codigoVinculacion = codigo;
        await comandoRedis(['SET', `cuenta:${emailNorm}`, JSON.stringify(cuenta)]);
        await comandoRedis(['SET', `vinculo:${codigo}`, emailNorm]);
        await enviarEmailResend(emailNorm, 'Tu cuenta de profesional ha sido verificada — Recuperación Activa',
          `<p>Hola ${cuenta.nombre || ''},</p>
           <p>Tu cuenta de profesional en Recuperación Activa ya está verificada.</p>
           <p>Tu código para que tus pacientes se vinculen a ti es: <b style="font-size:1.3em; letter-spacing:2px;">${codigo}</b></p>
           <p>Puedes verlo también en tu propio panel dentro de la web, en cualquier momento.</p>`
        ).catch(() => {});
        return res.status(200).json({ ok: true, codigoVinculacion: codigo });
      } else {
        cuenta.profesionalEstado = 'rechazado';
        await comandoRedis(['SET', `cuenta:${emailNorm}`, JSON.stringify(cuenta)]);
        return res.status(200).json({ ok: true });
      }
    }

    return res.status(400).json({ error: 'Acción no reconocida.' });
  } catch (err) {
    console.error('Error en api/admin-profesionales:', err);
    return res.status(502).json({ error: 'No se ha podido completar la operación ahora mismo. Inténtalo de nuevo en un momento.' });
  }
};

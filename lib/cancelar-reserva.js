// api/cancelar-reserva.js
// Permite cancelar una sesión de fisio/entreno ya pagada, con reembolso automático
// en Stripe. La verificación es sencilla a propósito: se pide el email con el que
// se pagó, igual que haría cualquier reserva de restaurante o vuelo por internet
// que no exige tener cuenta — no todo el que reserva tiene por qué haberse registrado.

const Stripe = require('stripe');

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

// Nunca se cancela con menos de esta antelación — igual que en la reserva de un
// restaurante o una consulta médica real, para poder ofrecer ese hueco a otra persona.
const HORAS_MINIMAS_ANTELACION = 24;

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

const seg = require('../api/_seguridad');

module.exports = async function handler(req, res) {
  const origenOk = seg.cors(req, res, 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(origenOk ? 204 : 403).end();
  if (!origenOk) return res.status(403).json({ error: 'Origen no permitido.' });
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido. Usa POST.' });

  if (!process.env.STRIPE_SECRET_KEY) return res.status(500).json({ error: 'Los pagos no están disponibles todavía: falta configurar Stripe en el servidor.' });
  if (!REDIS_URL || !REDIS_TOKEN) return res.status(500).json({ error: 'La base de datos no está configurada todavía en este servidor.' });

  if (await seg.limitar('cancel-ip:' + seg.ipDe(req), 10, 3600)) return res.status(429).json({ error: 'Demasiados intentos. Espera un rato.' });
  const { sessionId, email } = req.body || {};
  if (!sessionId || typeof sessionId !== 'string') return res.status(400).json({ error: 'Falta el identificador de la reserva.' });
  if (!email || typeof email !== 'string') return res.status(400).json({ error: 'Indica el email con el que pagaste la reserva.' });
  const emailNorm = email.trim().toLowerCase();

  try {
    const raw = await comandoRedis(['GET', `pago:sesion:${sessionId}`]);
    if (!raw) return res.status(404).json({ error: 'No se ha encontrado esa reserva.' });
    const registro = JSON.parse(raw);

    if (!registro.email || registro.email.toLowerCase() !== emailNorm) {
      return res.status(403).json({ error: 'El email no coincide con el de esta reserva.' });
    }
    if (registro.cancelado) return res.status(409).json({ error: 'Esta reserva ya estaba cancelada.' });

    if (registro.fechaISO) {
      const fechaCita = new Date(registro.fechaISO + 'T' + (registro.hora || '00:00') + ':00');
      const horasRestantes = (fechaCita.getTime() - Date.now()) / (1000 * 60 * 60);
      if (isFinite(horasRestantes) && horasRestantes < HORAS_MINIMAS_ANTELACION && horasRestantes > -999999) {
        return res.status(400).json({ error: `Ya no se puede cancelar: quedan menos de ${HORAS_MINIMAS_ANTELACION} horas para la cita. Contacta con nosotros directamente si es una urgencia.` });
      }
    }

    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (!session.payment_intent) return res.status(400).json({ error: 'No se ha encontrado el pago asociado a esta reserva.' });

    await stripe.refunds.create({ payment_intent: session.payment_intent });

    registro.cancelado = true;
    registro.canceladoEn = new Date().toISOString();
    await comandoRedis(['SET', `pago:sesion:${sessionId}`, JSON.stringify(registro)]);

    await enviarEmailResend(
      emailNorm,
      'Cita cancelada y reembolsada — Recuperación Activa',
      `<p>Hola${registro.nombre ? ' ' + registro.nombre : ''},</p>
       <p>Tu cita del <b>${registro.etiqueta || registro.fechaISO || ''}</b> ${registro.hora ? 'a las ' + registro.hora : ''} ha sido cancelada.</p>
       <p>El importe pagado se ha reembolsado a tu método de pago original — puede tardar unos días en aparecer, según tu banco.</p>`
    ).catch(() => {});

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Error en api/cancelar-reserva:', err);
    return res.status(502).json({ error: 'No se ha podido cancelar la reserva ahora mismo. Inténtalo de nuevo en un momento, o contacta con nosotros directamente.' });
  }
};

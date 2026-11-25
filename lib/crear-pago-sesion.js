// api/crear-pago-sesion.js
// Crea una sesión de pago único con Stripe (pago completo, no una señal) para una
// sesión de fisioterapia o entrenamiento reservada. El precio se fija AQUÍ, en el
// servidor — nunca se confía en un precio que venga del navegador, porque cualquiera
// podría manipularlo.
//
// Requiere STRIPE_SECRET_KEY configurada en Vercel. Stripe aloja la propia pantalla
// de pago (Checkout) — esta web nunca ve ni toca el número de la tarjeta.

const Stripe = require('stripe');

// Precios por tipo de sesión, en céntimos de euro. Cámbialos aquí si cambian.
const PRECIOS_CENTIMOS = {
  fisio: 5000,   // 50,00 €
  entreno: 4500  // 45,00 €
};

// Espacios donde se puede reservar una sesión de entrenamiento personal presencial.
const ESPACIOS_ENTRENO = {
  piscina: 'Piscina', gimnasio: 'Gimnasio', futbol: 'Campo de fútbol',
  padel: 'Pádel', tenis: 'Tenis', pabellon: 'Pabellón', crossfit: 'Crossfit'
};

// Modalidades del entrenamiento personal.
const MODALIDADES_ENTRENO = {
  presencial: 'Presencial', online: 'Online', videollamada: 'Videollamada'
};

const seg = require('../api/_seguridad');

module.exports = async function handler(req, res) {
  const origenOk = seg.cors(req, res, 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(origenOk ? 204 : 403).end();
  if (!origenOk) return res.status(403).json({ error: 'Origen no permitido.' });
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido. Usa POST.' });

  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(500).json({ error: 'Los pagos no están disponibles todavía: falta configurar Stripe en el servidor.' });
  }

  if (await seg.limitar('pago-ip:' + seg.ipDe(req), 20, 3600)) return res.status(429).json({ error: 'Demasiados intentos. Espera un rato.' });
  const { tipo, espacio, modalidad, fechaISO, hora, etiqueta, nombre, email, motivo, origen } = req.body || {};
  const tipoNorm = tipo === 'entreno' ? 'entreno' : 'fisio'; // por defecto fisio si no se manda nada, nunca se confía en un precio del navegador
  if (!nombre || typeof nombre !== 'string') return res.status(400).json({ error: 'Falta tu nombre.' });
  if (!email || typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Indica un email válido — Stripe lo necesita para enviarte el recibo.' });
  }
  let espacioNombre = '';
  let modalidadNorm = 'presencial';
  if (tipoNorm === 'entreno') {
    modalidadNorm = MODALIDADES_ENTRENO[modalidad] ? modalidad : 'presencial';
    if (modalidadNorm === 'presencial') {
      if (!espacio || !ESPACIOS_ENTRENO[espacio]) {
        return res.status(400).json({ error: 'Elige el espacio donde quieres entrenar.' });
      }
      espacioNombre = ESPACIOS_ENTRENO[espacio];
    }
  }

  try {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const base = (typeof origen === 'string' && /^https?:\/\//.test(origen)) ? origen : (process.env.SITE_URL || '');
    const descripcionCita = [etiqueta, hora, espacioNombre || MODALIDADES_ENTRENO[modalidadNorm]].filter(Boolean).join(', ');
    const nombreProducto = tipoNorm === 'entreno'
      ? `Sesión de entrenamiento personal (${espacioNombre || MODALIDADES_ENTRENO[modalidadNorm]}) — Recuperación Activa`
      : 'Sesión de fisioterapia — Recuperación Activa';

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'eur',
          product_data: {
            name: nombreProducto,
            description: descripcionCita || undefined
          },
          unit_amount: PRECIOS_CENTIMOS[tipoNorm]
        },
        quantity: 1
      }],
      customer_email: email,
      // Guardamos aquí los datos de la cita para poder recuperarlos en el webhook
      // cuando Stripe confirme que el pago se ha completado de verdad.
      metadata: {
        tipo: 'sesion', tipoSesion: tipoNorm, espacio: espacio || '', modalidad: modalidadNorm, fechaISO: fechaISO || '', hora: hora || '',
        etiqueta: etiqueta || '', nombre: nombre.slice(0, 100), motivo: (motivo || '').slice(0, 200)
      },
      success_url: `${base}/#reservar?pagado=1&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${base}/#reservar`
    });

    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('Error creando la sesión de pago de Stripe:', err);
    return res.status(502).json({ error: 'No se ha podido iniciar el pago ahora mismo. Inténtalo de nuevo en un momento.' });
  }
};

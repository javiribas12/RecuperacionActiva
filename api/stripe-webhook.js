// api/stripe-webhook.js
// Stripe llama a esta URL directamente (no el navegador de la persona) en cuanto un
// pago o una suscripción se confirma de verdad. Esto es lo que de verdad demuestra
// que se ha pagado — nunca te fíes solo de que alguien "llegue" a la página de éxito,
// porque esa URL se podría visitar sin haber pagado nada.
//
// Requiere dos variables de entorno en Vercel:
//  - STRIPE_SECRET_KEY (la misma que en los otros dos archivos)
//  - STRIPE_WEBHOOK_SECRET (la que te da Stripe al crear el webhook en su panel, empieza por "whsec_")
//
// Configura este webhook en el panel de Stripe (Developers → Webhooks → Add endpoint)
// apuntando a https://tu-web.vercel.app/api/stripe-webhook, escuchando al menos el
// evento "checkout.session.completed".

const Stripe = require('stripe');

const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

async function comandoRedis(args) {
  if (!REDIS_URL || !REDIS_TOKEN) return null; // sin base de datos configurada, se registra igualmente en Stripe, solo no queda copia aquí
  const r = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args)
  });
  const data = await r.json();
  return data ? data.result : null;
}

// Envía la confirmación por email con Resend (resend.com), el mismo servicio que ya
// se usa para recuperar contraseña. Si no has configurado RESEND_API_KEY, esta función
// no falla: simplemente no hay envío real — el pago y la cita se guardan igual.
async function enviarEmailResend(email, asunto, html) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { enviado: false, motivo: 'RESEND_API_KEY no configurada' };
  const remitente = process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev';
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: `Recuperación Activa <${remitente}>`, to: email, subject: asunto, html })
    });
    if (!r.ok) { const t = await r.text().catch(()=> ''); return { enviado: false, motivo: 'Resend respondió con error: ' + t }; }
    return { enviado: true };
  } catch (err) {
    return { enviado: false, motivo: err.message };
  }
}

function formatoImporte(centimos, moneda) {
  return ((centimos || 0) / 100).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ' + (moneda || 'eur').toUpperCase();
}

async function enviarConfirmacionSesion(registro) {
  if (!registro.email) return;
  const tipoTexto = registro.tipoSesion === 'entreno' ? 'Entrenamiento personal' : 'Fisioterapia';
  const modoTexto = registro.espacio ? registro.espacio : (registro.modalidad && registro.modalidad !== 'presencial' ? registro.modalidad.charAt(0).toUpperCase() + registro.modalidad.slice(1) : '');
  await enviarEmailResend(
    registro.email,
    'Cita confirmada — Recuperación Activa',
    `
      <p>Hola${registro.nombre ? ' ' + registro.nombre : ''},</p>
      <p>Tu cita de <b>${tipoTexto}</b> ha quedado confirmada y pagada.</p>
      <ul>
        <li><b>Día:</b> ${registro.etiqueta || registro.fechaISO || '—'}</li>
        <li><b>Hora:</b> ${registro.hora || '—'}</li>
        ${modoTexto ? `<li><b>${registro.espacio ? 'Espacio' : 'Modalidad'}:</b> ${modoTexto}</li>` : ''}
        <li><b>Importe pagado:</b> ${formatoImporte(registro.importeCentimos, registro.moneda)}</li>
      </ul>
      <p style="color:#888; font-size:.85em;">Si necesitas cambiar o cancelar la cita, contacta con nosotros respondiendo a este correo o por WhatsApp.</p>
    `
  );
}

// Stripe necesita los bytes EXACTOS del cuerpo de la petición para comprobar la firma,
// así que desactivamos el parseo automático de Vercel (ver module.exports.config al final)
// y lo leemos nosotros mismos.
function leerCuerpoCrudo(req) {
  return new Promise((resolve, reject) => {
    const trozos = [];
    req.on('data', (trozo) => trozos.push(trozo));
    req.on('end', () => resolve(Buffer.concat(trozos)));
    req.on('error', reject);
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Método no permitido.');

  if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_WEBHOOK_SECRET) {
    console.error('Webhook de Stripe recibido pero faltan STRIPE_SECRET_KEY o STRIPE_WEBHOOK_SECRET.');
    return res.status(500).send('Webhook no configurado.');
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const cuerpoCrudo = await leerCuerpoCrudo(req);
  const firma = req.headers['stripe-signature'];

  let evento;
  try {
    // Esto comprueba de verdad que la petición viene de Stripe y no de cualquiera
    // que le haya copiado la forma — es la parte más importante de todo el archivo.
    evento = stripe.webhooks.constructEvent(cuerpoCrudo, firma, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Firma de webhook de Stripe inválida:', err.message);
    return res.status(400).send(`Firma inválida: ${err.message}`);
  }

  try {
    if (evento.type === 'checkout.session.completed') {
      const session = evento.data.object;
      const meta = session.metadata || {};

      if (meta.tipo === 'sesion') {
        // Sesión de fisio/entrenamiento pagada de verdad — se guarda como cita pagada
        const registro = {
          fechaISO: meta.fechaISO, hora: meta.hora, etiqueta: meta.etiqueta, tipoSesion: meta.tipoSesion, espacio: meta.espacio, modalidad: meta.modalidad || 'presencial',
          nombre: meta.nombre, motivo: meta.motivo, email: session.customer_details ? session.customer_details.email : session.customer_email,
          importeCentimos: session.amount_total, moneda: session.currency,
          stripeSessionId: session.id, pagadoEn: new Date().toISOString()
        };
        await comandoRedis(['SET', `pago:sesion:${session.id}`, JSON.stringify(registro)]);
        await comandoRedis(['SADD', 'indice:pagos-sesion', session.id]);
        await enviarConfirmacionSesion(registro).catch(err => console.error('No se pudo enviar el email de confirmación de sesión:', err.message));
      }
    }

    return res.status(200).json({ recibido: true });
  } catch (err) {
    console.error('Error procesando el evento de Stripe:', err);
    // Importante: devolvemos 200 igualmente para que Stripe no reintente infinitamente
    // un evento que ya identificamos y que solo falló al guardarlo — evita duplicados.
    return res.status(200).json({ recibido: true, aviso: 'hubo un error interno al procesar, revisado en los logs' });
  }
};

module.exports.config = { api: { bodyParser: false } };

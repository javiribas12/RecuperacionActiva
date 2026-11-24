// api/shopify-webhook.js — Shopify avisa aquí cuando se paga un pedido (webhook "orders/paid").
// Activa Premium para el email del pedido: 3,99 €/mes (+31 días), anual (+366), entrenador (+31),
// y 1 mes gratis con cualquier sesión/bono. Verifica la firma HMAC con SHOPIFY_WEBHOOK_SECRET.
const crypto = require('crypto');
const seg = require('./_seguridad');

// IDs de variante de Shopify -> días de Premium que regalan/dan
const DIAS = {
  // Se rellenan con las variantes reales de los productos de suscripción:
  [process.env.SHOPIFY_VAR_PREMIUM_MES || 'premium_mes']: 31,
  [process.env.SHOPIFY_VAR_PREMIUM_ANIO || 'premium_anio']: 366,
  [process.env.SHOPIFY_VAR_ENTRENADOR || 'entrenador_mes']: 31,
  '60034541748556': 31, '60034542010700': 31, '60034632221004': 31, '60036717576524': 31, '60036717707596': 366, '60036718068044': 31, // premium + sesión fisio / entreno / combo: 1 mes gratis
  '60034542436684': 31, '60034542502220': 31                         // bonos
};

function leerCuerpo(req) {
  return new Promise((ok, ko) => { const c = []; req.on('data', d => c.push(d)); req.on('end', () => ok(Buffer.concat(c))); req.on('error', ko); });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const secreto = process.env.SHOPIFY_WEBHOOK_SECRET;
  if (!secreto) return res.status(500).json({ error: 'Falta SHOPIFY_WEBHOOK_SECRET' });
  const raw = await leerCuerpo(req);
  const firma = crypto.createHmac('sha256', secreto).update(raw).digest('base64');
  if (!seg.igual(firma, req.headers['x-shopify-hmac-sha256'] || '')) return res.status(401).end();
  let pedido; try { pedido = JSON.parse(raw.toString('utf8')); } catch (e) { return res.status(400).end(); }
  const email = String(pedido.email || (pedido.customer && pedido.customer.email) || '').trim().toLowerCase();
  if (!email) return res.status(200).json({ ok: true, sinEmail: true });
  let dias = 0;
  (pedido.line_items || []).forEach(li => { dias = Math.max(dias, DIAS[String(li.variant_id)] || 0); });
  if (!dias) return res.status(200).json({ ok: true, sinPremium: true });
  const actual = await seg.redisCmd(['GET', 'premium:' + email]);
  const base = actual && Date.parse(actual) > Date.now() ? Date.parse(actual) : Date.now();
  const hasta = new Date(base + dias * 86400000).toISOString();
  await seg.redisCmd(['SET', 'premium:' + email, hasta]);
  return res.status(200).json({ ok: true, email, hasta });
};
// Vercel: necesitamos el cuerpo sin procesar para verificar la firma.
module.exports.config = { api: { bodyParser: false } };

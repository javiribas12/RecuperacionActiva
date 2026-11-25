// api/panel-admin.js — Panel del fundador: usuarios, visitas, búsquedas, IA y ventas de Shopify.
// SOLO responde a la sesión de la cuenta cuyo email coincide con ADMIN_EMAIL (por defecto, el del fundador).
// No es una contraseña compartida: hay que haber iniciado sesión con esa cuenta, y la comprobación
// se hace aquí, en el servidor (nadie puede "hacerse administrador" desde el navegador).
const seg = require('../api/_seguridad');

const ADMIN_EMAIL = () => String(process.env.ADMIN_EMAIL || 'javiribas12@gmail.com').trim().toLowerCase();
const COSTE_LLAMADA_EUR = () => { const n = parseFloat(process.env.GEMINI_COSTE_LLAMADA_EUR); return isFinite(n) && n >= 0 ? n : 0.003; };
const SHOP = () => String(process.env.SHOPIFY_SHOP || 'qazu16-xy.myshopify.com').trim();

const fechaES = (d) => d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Madrid' });
function ultimosDias(n) { const a = []; for (let i = n - 1; i >= 0; i--) a.push(fechaES(new Date(Date.now() - i * 86400000))); return a; }

async function escanear(patron, tope) {
  let cursor = '0'; const claves = [];
  do {
    const r = await seg.redisCmd(['SCAN', cursor, 'MATCH', patron, 'COUNT', '200']);
    cursor = String(r[0]); (r[1] || []).forEach(k => claves.push(k));
  } while (cursor !== '0' && claves.length < tope);
  return claves.slice(0, tope);
}
async function leerVarios(claves) {
  const out = [];
  for (let i = 0; i < claves.length; i += 50) {
    const lote = claves.slice(i, i + 50);
    const vals = await seg.redisCmd(['MGET'].concat(lote));
    lote.forEach((k, j) => out.push([k, (vals || [])[j]]));
  }
  return out;
}
const num = (x) => parseInt(x, 10) || 0;

async function datosUsuarios() {
  const claves = await escanear('cuenta:*', 3000);
  const filas = await leerVarios(claves);
  const hoyD = fechaES(new Date()); const dias30 = ultimosDias(30);
  const porDia = Object.fromEntries(dias30.map(d => [d, 0]));
  const roles = { paciente: 0, profesional: 0, entrenador: 0 };
  const recientes = []; let total = 0;
  for (const [, raw] of filas) {
    if (!raw) continue; let c; try { c = JSON.parse(raw); } catch (e) { continue; }
    total++;
    const esEnt = c.profesionalDatos && c.profesionalDatos.tipo === 'entrenador';
    roles[esEnt ? 'entrenador' : (c.rol === 'profesional' ? 'profesional' : 'paciente')]++;
    const f = c.fechaRegistro ? fechaES(new Date(c.fechaRegistro)) : null;
    if (f && f in porDia) porDia[f]++;
    recientes.push({ nombre: String(c.nombre || '').slice(0, 40), email: c.email, fecha: c.fechaRegistro || '', rol: esEnt ? 'entrenador' : (c.rol || 'paciente'), estado: c.profesionalEstado || '' });
  }
  recientes.sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)));
  const pend = await seg.redisCmd(['SCARD', 'indice:profesionales-pendientes']);
  return { total, roles, hoy: porDia[hoyD] || 0, ultimos7: dias30.slice(-7).reduce((s, d) => s + porDia[d], 0), ultimos30: dias30.reduce((s, d) => s + porDia[d], 0),
    porDia: dias30.map(d => ({ d, n: porDia[d] })), recientes: recientes.slice(0, 15), profesionalesPendientes: num(pend) };
}
async function datosPremium() {
  const claves = await escanear('premium:*', 3000);
  const filas = await leerVarios(claves); const ahora = Date.now(); let activos = 0, caducan7 = 0;
  for (const [, v] of filas) { const t = Date.parse(v); if (t > ahora) { activos++; if (t - ahora < 7 * 86400000) caducan7++; } }
  return { activos, caducanEn7Dias: caducan7, mrrEstimado: Math.round(activos * 3.99 * 100) / 100 };
}
async function datosVisitas() {
  const dias = ultimosDias(14); const serie = []; const paginas = {}; const disp = { movil: 0, ordenador: 0 };
  for (const d of dias) {
    const v = num(await seg.redisCmd(['GET', 'stat:v:' + d]));
    const u = num(await seg.redisCmd(['PFCOUNT', 'stat:uv:' + d]));
    serie.push({ d, visitas: v, unicos: u });
    const p = await seg.redisCmd(['HGETALL', 'stat:p:' + d]) || [];
    for (let i = 0; i < p.length; i += 2) paginas[p[i]] = (paginas[p[i]] || 0) + num(p[i + 1]);
    const dv = await seg.redisCmd(['HGETALL', 'stat:d:' + d]) || [];
    for (let i = 0; i < dv.length; i += 2) if (dv[i] in disp) disp[dv[i]] += num(dv[i + 1]);
  }
  const top = Object.entries(paginas).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([pagina, n]) => ({ pagina, n }));
  const hoyS = serie[serie.length - 1];
  return { serie, hoy: hoyS.visitas, unicosHoy: hoyS.unicos, total14: serie.reduce((s, x) => s + x.visitas, 0), topPaginas: top, dispositivos: disp };
}
async function datosIA() {
  const dias = ultimosDias(30); const serie = [];
  for (const d of dias) serie.push({ d, n: num(await seg.redisCmd(['GET', 'stat:ia:' + d])) });
  const c = COSTE_LLAMADA_EUR(); const suma = (a) => a.reduce((s, x) => s + x.n, 0);
  const preg = ((await seg.redisCmd(['LRANGE', 'stat:preg', '0', '29'])) || []).map(x => { try { return JSON.parse(x); } catch (e) { return null; } }).filter(Boolean);
  return { serie, hoy: serie[serie.length - 1].n, ultimos7: suma(serie.slice(-7)), ultimos30: suma(serie),
    costeUnitarioEstimado: c, costeEstimado30: Math.round(suma(serie) * c * 100) / 100, ultimasPreguntas: preg };
}
async function datosBusquedas() {
  return ((await seg.redisCmd(['LRANGE', 'stat:busq', '0', '29'])) || []).map(x => { try { return JSON.parse(x); } catch (e) { return null; } }).filter(Boolean);
}
async function datosShopify() {
  const token = process.env.SHOPIFY_ADMIN_TOKEN;
  if (!token) return { conectado: false };
  const desde = new Date(Date.now() - 30 * 86400000).toISOString();
  const q = `query($q:String!){ orders(first:100, sortKey:CREATED_AT, reverse:true, query:$q){ nodes{ name createdAt displayFinancialStatus totalPriceSet{shopMoney{amount currencyCode}} lineItems(first:5){nodes{title quantity}} } } }`;
  const r = await fetch(`https://${SHOP()}/admin/api/2025-07/graphql.json`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token }, body: JSON.stringify({ query: q, variables: { q: 'created_at:>=' + desde } }) });
  if (!r.ok) return { conectado: false, error: 'Shopify respondió ' + r.status };
  const j = await r.json(); if (j.errors) return { conectado: false, error: String(j.errors[0] && j.errors[0].message || 'error').slice(0, 120) };
  const pedidos = (j.data && j.data.orders && j.data.orders.nodes) || [];
  let ingresos = 0; const productos = {}; const dias = Object.fromEntries(ultimosDias(30).map(d => [d, 0]));
  pedidos.forEach(p => { const pagado = /PAID|PARTIALLY/.test(p.displayFinancialStatus || ''); const a = parseFloat(p.totalPriceSet.shopMoney.amount) || 0;
    if (pagado) { ingresos += a; const f = fechaES(new Date(p.createdAt)); if (f in dias) dias[f] += a;
      (p.lineItems.nodes || []).forEach(li => { productos[li.title] = (productos[li.title] || 0) + li.quantity; }); } });
  return { conectado: true, pedidos30: pedidos.length, ingresos30: Math.round(ingresos * 100) / 100, moneda: (pedidos[0] && pedidos[0].totalPriceSet.shopMoney.currencyCode) || 'EUR',
    topProductos: Object.entries(productos).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([titulo, n]) => ({ titulo, n })),
    serie: Object.entries(dias).map(([d, n]) => ({ d, n: Math.round(n * 100) / 100 })),
    ultimos: pedidos.slice(0, 8).map(p => ({ pedido: p.name, fecha: p.createdAt, importe: p.totalPriceSet.shopMoney.amount, estado: p.displayFinancialStatus })) };
}

module.exports = async function handler(req, res) {
  const origenOk = seg.cors(req, res, 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(origenOk ? 204 : 403).end();
  if (!origenOk) return res.status(403).json({ error: 'Origen no permitido.' });
  if (req.method !== 'POST') return res.status(405).json({ error: 'Usa POST.' });
  try {
    if (await seg.limitar('panel-ip:' + seg.ipDe(req), 120, 3600)) return res.status(429).json({ error: 'Demasiadas peticiones.' });
    const { token, accion } = req.body || {};
    if (!token || typeof token !== 'string' || token.length > 200) return res.status(403).json({ error: 'No autorizado.' });
    const email = await seg.redisCmd(['GET', 'sesion:' + token]);
    if (!email || !seg.igual(String(email).toLowerCase(), ADMIN_EMAIL())) return res.status(403).json({ error: 'No autorizado.' });
    if (accion === 'whoami') return res.status(200).json({ admin: true });
    const seguro = async (f) => { try { return await f(); } catch (e) { return { error: String(e.message || e).slice(0, 100) }; } };
    const [usuarios, premium, visitas, ia, busquedas, shopify] = await Promise.all([seguro(datosUsuarios), seguro(datosPremium), seguro(datosVisitas), seguro(datosIA), seguro(datosBusquedas), seguro(datosShopify)]);
    return res.status(200).json({ generado: new Date().toISOString(), usuarios, premium, visitas, ia, busquedas, shopify });
  } catch (e) {
    return res.status(500).json({ error: 'No se pudo generar el panel.' });
  }
};

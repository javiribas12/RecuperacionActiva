// api/recordatorios.js — avisos por correo con consentimiento: eventos/novedades, rutina semanal y recordatorio diario personalizado.
// Preferencias en cuenta:{email}.avisos = { eventos, rutinas, diario, dias:[1..7 (1=lunes)], consentimiento:ISO }
// Índices Redis: indice:avisos-diario · indice:avisos-rutinas · indice:avisos-eventos (SETs de emails)
// Rutas:
//  POST accion=avisos-leer | avisos-guardar | avisos-prueba   (con token de sesión)
//  POST accion=admin-novedad                                   (contraseña de administrador; envía a quien aceptó eventos)
//  GET  /api/recordatorios                                     (Vercel Cron, cabecera Authorization: Bearer CRON_SECRET)
//  GET  /api/recordatorios?baja=EMAIL&sig=FIRMA                (enlace de baja de cada correo; sin login)
// Variables: RESEND_API_KEY, RESEND_FROM_EMAIL, CRON_SECRET, SITE_URL, ADMIN_PASSWORD (AVISOS_SECRET opcional para firmar bajas)
const crypto = require('crypto');
const seg = require('./_seguridad');

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const SECRETO = () => process.env.AVISOS_SECRET || process.env.CRON_SECRET || process.env.ADMIN_PASSWORD || '';
const BASE = () => String(process.env.SITE_URL || '').split(',')[0].trim().replace(/\/$/, '') || 'https://recuperacion-activa.vercel.app';
const firma = email => crypto.createHmac('sha256', SECRETO()).update(String(email).toLowerCase()).digest('hex').slice(0, 32);
const enlaceBaja = email => `${BASE()}/api/recordatorios?baja=${encodeURIComponent(email)}&sig=${firma(email)}`;
const DIAS = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];
const NOMBRE_DIA = { lunes: 'lunes', martes: 'martes', miercoles: 'miércoles', jueves: 'jueves', viernes: 'viernes', sabado: 'sábado', domingo: 'domingo' };

function limpiarAvisos(a, previo) {
  a = a && typeof a === 'object' ? a : {};
  const dias = (Array.isArray(a.dias) ? a.dias : [1, 2, 3, 4, 5]).map(Number).filter(n => n >= 1 && n <= 7).filter((n, i, x) => x.indexOf(n) === i);
  const out = { eventos: !!a.eventos, rutinas: !!a.rutinas, diario: !!a.diario, dias: dias.length ? dias : [1, 2, 3, 4, 5] };
  if (out.eventos || out.rutinas || out.diario) out.consentimiento = (previo && previo.consentimiento) || new Date().toISOString();
  return out;
}
async function indexar(email, av) {
  for (const [k, ind] of [['diario', 'indice:avisos-diario'], ['rutinas', 'indice:avisos-rutinas'], ['eventos', 'indice:avisos-eventos']])
    await seg.redis([av && av[k] ? 'SADD' : 'SREM', ind, email]);
}
async function enviar(email, asunto, html) {
  const key = process.env.RESEND_API_KEY; if (!key) return { enviado: false, motivo: 'RESEND_API_KEY no configurada' };
  if (!SECRETO()) return { enviado: false, motivo: 'Falta CRON_SECRET (o AVISOS_SECRET) para firmar los enlaces de baja' };
  const baja = enlaceBaja(email), from = process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev';
  const cuerpo = `<div style="font-family:system-ui,Segoe UI,sans-serif;max-width:560px;margin:auto;color:#241419;line-height:1.5">${html}
    <hr style="border:none;border-top:1px solid #eee;margin:24px 0"><p style="font-size:12px;color:#888">Recibes este correo porque lo aceptaste al registrarte en Recuperación Activa. Es orientativo y no sustituye a un profesional.
    <a href="${baja}">Darme de baja</a> de todos los avisos.</p></div>`;
  try {
    const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: `Recuperación Activa <${from}>`, to: email, subject: asunto, html: cuerpo, headers: { 'List-Unsubscribe': `<${baja}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } }) });
    if (!r.ok) return { enviado: false, motivo: 'Resend: ' + (await r.text().catch(() => '')).slice(0, 200) };
    return { enviado: true };
  } catch (e) { return { enviado: false, motivo: e.message }; }
}
const boton = (t, u) => `<p><a href="${u}" style="background:#E11F3D;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;display:inline-block">${esc(t)}</a></p>`;

/* ---------- qué le toca hoy a cada persona ---------- */
const ROT = { gimnasio: [['g-empuje', 'Pecho, hombro y tríceps'], ['g-tiron', 'Espalda y bíceps'], ['g-pierna', 'Pierna y glúteo']], casa: [['c-cuerpo', 'Cuerpo completo en casa'], ['c-pierna', 'Pierna y core en casa']], exterior: [['e-calistenia', 'Calistenia en el parque']] };
const nombreEj = x => esc(typeof x === 'string' ? x.replace(/-/g, ' ') : (x && (x.nombre || x.ejercicioId || x.id) ? String(x.nombre || x.ejercicioId || x.id).replace(/-/g, ' ') : ''));
const parse = a => (a || []).map(s => { try { return JSON.parse(s); } catch (e) { return null; } }).filter(Boolean);

async function contenidoHoy(email, cuenta, ahora) {
  const dia = DIAS[ahora.getDay()], hoyISO = ahora.toISOString().slice(0, 10);
  const nombre = esc((cuenta.nombre || '').split(' ')[0] || '');
  const [rawPlan, rawRut, entr, dia2] = await Promise.all([
    seg.redis(['GET', `plan-pautado:${email}`]), seg.redis(['GET', `usuario:${email}:rutina`]),
    seg.redis(['LRANGE', `usuario:${email}:entrenos`, '0', '5']), seg.redis(['LRANGE', `usuario:${email}:diario`, '0', '5'])]);
  const plan = rawPlan ? JSON.parse(rawPlan) : null, rutina = rawRut ? JSON.parse(rawRut) : null, entrenos = parse(entr), diario = parse(dia2);
  const url = BASE() + '/#mi-entreno';
  if (entrenos[0] && new Date(entrenos[0].f).toISOString().slice(0, 10) === hoyISO) return null;      // ya ha entrenado hoy: no insistimos
  const ck = diario.find(e => e.tipo === 'checkin' && Date.now() - e.f < 36 * 36e5);
  const suave = ck && ck.decision === 'rojo';
  let titulo, bloque;
  if (plan && Array.isArray(plan.dias) && plan.dias.includes(dia)) {
    titulo = `Hoy te toca: ${esc(plan.zona)}`;
    bloque = `<p>Tu plan pautado por ${esc(plan.profesionalNombre || 'tu profesional')} para hoy (${NOMBRE_DIA[dia]}):</p><ul>${(plan.ejercicios || []).slice(0, 8).map(x => `<li>${nombreEj(x)}</li>`).join('')}</ul>${boton('Abrir mi plan', BASE() + '/#perfil')}`;
  } else if (rutina && rutina.ejercicios && rutina.ejercicios.length) {
    titulo = `Hoy te toca: ${esc(rutina.nombre || 'tu rutina')}`;
    bloque = `<p>Rutina de ${esc(rutina.por || 'tu profesional')}:</p><ul>${rutina.ejercicios.slice(0, 8).map(e => `<li>${nombreEj(e.id)} — ${esc(e.series)} × ${esc(e.repMin)}-${esc(e.repMax)}${e.kg != null ? ' · ' + esc(e.kg) + ' kg' : ''}${e.nota ? ' <em>(' + esc(e.nota) + ')</em>' : ''}</li>`).join('')}</ul>${rutina.nota ? `<p><b>Nota:</b> ${esc(rutina.nota)}</p>` : ''}${boton('Entrenar y anotar mis pesos', url)}`;
  } else if (entrenos[0]) {
    const esp = ROT[entrenos[0].espacio] ? entrenos[0].espacio : 'gimnasio', lista = ROT[esp], idx = lista.findIndex(r => r[0] === entrenos[0].rutina);
    const sig = lista[(idx + 1) % lista.length];
    titulo = `Hoy te toca: ${sig[1]}`;
    bloque = `<p>Tu último entreno fue <b>${esc(entrenos[0].nombre || '')}</b>. Hoy toca <b>${esc(sig[1])}</b>. Te propondremos pesos y repeticiones según lo que hiciste.</p>${boton('Empezar entreno', url)}`;
  } else {
    titulo = 'Hoy: 10 minutos para moverte';
    bloque = `<p>Aún no has registrado ningún entreno. Empieza suave: 10 minutos de movilidad y un paseo, o elige una rutina de gimnasio, casa o aire libre.</p>${boton('Elegir mi rutina', url)}`;
  }
  const aviso = suave ? `<p style="background:#fdeceb;padding:10px 12px;border-radius:8px">Ayer marcaste bastante dolor. Hoy hazlo en versión suave, sin impacto, y si sigue molestando consúltalo con tu fisioterapeuta.</p>` : '';
  return { asunto: titulo.replace(/<[^>]+>/g, ''), html: `<h2 style="color:#C0182F">${nombre ? 'Hola, ' + nombre + ' 👋' : 'Hola 👋'}</h2><h3>${titulo}</h3>${aviso}${bloque}<p style="font-size:13px;color:#666">Cada sesión: para si hay dolor agudo. Puedes cambiar tus avisos en tu perfil.</p>` };
}
async function resumenSemana(email, cuenta) {
  const e = parse(await seg.redis(['LRANGE', `usuario:${email}:entrenos`, '0', '60'])).filter(x => Date.now() - x.f < 7 * 864e5);
  const nombre = esc((cuenta.nombre || '').split(' ')[0] || '');
  return { asunto: 'Tu semana en Recuperación Activa', html: `<h2 style="color:#C0182F">${nombre ? 'Buenos días, ' + nombre : 'Buenos días'} 👋</h2><p>${e.length ? `La semana pasada hiciste <b>${e.length}</b> entreno${e.length > 1 ? 's' : ''}. ¡Constancia!` : 'La semana pasada no registraste entrenos. No pasa nada: empieza esta semana con algo suave.'}</p><p>Objetivo orientativo: fortalecer los grandes grupos musculares al menos 2 días por semana (OMS).</p>${boton('Ver mi progreso', BASE() + '/#mi-espacio')}` };
}

/* ---------- aplicar preferencias (también lo usa auth.js al registrarse) ---------- */
async function aplicarAvisos(email, cuenta, avisosEntrada) {
  cuenta.avisos = limpiarAvisos(avisosEntrada, cuenta.avisos);
  await indexar(email, cuenta.avisos);
  return cuenta.avisos;
}
async function bienvenida(email, cuenta) {
  const a = cuenta.avisos || {}; if (!(a.eventos || a.rutinas || a.diario)) return;
  const lista = [a.diario ? 'recordatorio diario de tu entreno' : '', a.rutinas ? 'resumen semanal de tu rutina' : '', a.eventos ? 'eventos y novedades' : ''].filter(Boolean);
  await enviar(email, 'Tus avisos de Recuperación Activa', `<h2 style="color:#C0182F">¡Listo!</h2><p>Has aceptado recibir: <b>${lista.join(', ')}</b>.</p><p>Puedes cambiarlo o darte de baja cuando quieras desde tu perfil o con el enlace al final de cada correo.</p>${boton('Abrir mi espacio', BASE() + '/#mi-espacio')}`);
}

async function handler(req, res) {
  const origenOk = seg.cors(req, res, 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(origenOk ? 204 : 403).end();

  /* --- baja con un clic --- */
  if (req.method === 'GET' && req.query && req.query.baja) {
    if (await seg.limitar('baja-ip:' + seg.ipDe(req), 30, 3600)) return res.status(429).send('Demasiadas peticiones.');
    const email = String(req.query.baja).trim().toLowerCase(), sig = String(req.query.sig || '');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (!SECRETO() || !seg.igual(firma(email), sig)) return res.status(400).send('<p>Enlace de baja no válido.</p>');
    const raw = await seg.redis(['GET', `cuenta:${email}`]);
    if (raw) { const c = JSON.parse(raw); c.avisos = Object.assign({}, c.avisos, { eventos: false, rutinas: false, diario: false }); await seg.redis(['SET', `cuenta:${email}`, JSON.stringify(c)]); }
    await indexar(email, null);
    return res.status(200).send('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><body style="font-family:system-ui;max-width:480px;margin:60px auto;padding:0 16px"><h2>Te has dado de baja ✔</h2><p>No recibirás más avisos por correo. Puedes volver a activarlos desde tu perfil.</p><p><a href="' + esc(BASE()) + '">Volver a la web</a></p></body>');
  }

  /* --- cron diario --- */
  if (req.method === 'GET') {
    const s = process.env.CRON_SECRET, h = String(req.headers.authorization || '');
    if (!s || !seg.igual(h, 'Bearer ' + s)) return res.status(401).json({ error: 'No autorizado.' });
    const ahora = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Madrid' })); // hora de Madrid
    const dow = ahora.getDay() === 0 ? 7 : ahora.getDay(), hoyISO = ahora.toISOString().slice(0, 10);
    const diarios = await seg.redis(['SMEMBERS', 'indice:avisos-diario']) || [], semanales = dow === 1 ? (await seg.redis(['SMEMBERS', 'indice:avisos-rutinas']) || []) : [];
    const todos = [...new Set(diarios.concat(semanales))].slice(0, 500); let enviados = 0, omitidos = 0, fallos = 0;
    for (const email of todos) {
      try {
        const raw = await seg.redis(['GET', `cuenta:${email}`]); if (!raw) { await indexar(email, null); continue; }
        const c = JSON.parse(raw), a = c.avisos || {};
        if (!(await seg.redis(['SET', `aviso-enviado:${email}:${hoyISO}`, '1', 'NX', 'EX', '90000']))) { omitidos++; continue; }   // ya enviado hoy
        let msg = null;
        if (a.diario && diarios.includes(email) && (a.dias || [1, 2, 3, 4, 5]).includes(dow)) msg = await contenidoHoy(email, c, ahora);
        if (a.rutinas && dow === 1) { const rs = await resumenSemana(email, c); msg = msg ? { asunto: msg.asunto, html: msg.html + '<hr style="border:none;border-top:1px solid #eee;margin:20px 0">' + rs.html } : rs; }
        if (!msg) { omitidos++; continue; }
        const r = await enviar(email, msg.asunto, msg.html); r.enviado ? enviados++ : fallos++;
      } catch (e) { fallos++; }
    }
    return res.status(200).json({ ok: true, candidatos: todos.length, enviados, omitidos, fallos });
  }

  if (!origenOk) return res.status(403).json({ error: 'Origen no permitido.' });
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido.' });
  if (await seg.limitar('avisos-ip:' + seg.ipDe(req), 100, 3600)) return res.status(429).json({ error: 'Demasiadas peticiones.' });
  const { accion, token } = req.body || {};
  try {
    if (accion === 'admin-novedad') {
      const adm = process.env.ADMIN_PASSWORD;
      if (await seg.limitar('avisos-admin:' + seg.ipDe(req), 10, 900)) return res.status(429).json({ error: 'Demasiados intentos.' });
      if (!adm || !seg.igual(String(req.body.password || ''), adm)) return res.status(401).json({ error: 'Contraseña de administrador incorrecta.' });
      const asunto = String(req.body.asunto || '').slice(0, 150), texto = String(req.body.texto || '').slice(0, 5000);
      if (!asunto || !texto) return res.status(400).json({ error: 'Faltan asunto y texto.' });
      const lista = req.body.prueba ? [String(req.body.prueba).toLowerCase()] : (await seg.redis(['SMEMBERS', 'indice:avisos-eventos']) || []);
      if (req.body.soloContar) return res.status(200).json({ destinatarios: lista.length });
      const html = `<h2 style="color:#C0182F">${esc(asunto)}</h2>` + texto.split(/\n{2,}/).map(p => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('') + (req.body.enlace && /^https?:\/\//.test(req.body.enlace) ? boton(req.body.textoEnlace || 'Más información', req.body.enlace) : '');
      let ok = 0, ko = 0; for (const e of lista.slice(0, 500)) { const r = await enviar(e, asunto, html); r.enviado ? ok++ : ko++; }
      return res.status(200).json({ enviados: ok, fallos: ko });
    }
    const email = token ? await seg.redis(['GET', `sesion:${token}`]) : null;
    if (!email) return res.status(401).json({ error: 'Inicia sesión.' });
    const raw = await seg.redis(['GET', `cuenta:${email}`]); if (!raw) return res.status(404).json({ error: 'Cuenta no encontrada.' });
    const c = JSON.parse(raw);
    if (accion === 'avisos-leer') return res.status(200).json({ avisos: c.avisos || { eventos: false, rutinas: false, diario: false, dias: [1, 2, 3, 4, 5] }, email });
    if (accion === 'avisos-guardar') {
      const a = req.body.avisos || {};
      if ((a.eventos || a.rutinas || a.diario) && !req.body.consentimiento) return res.status(400).json({ error: 'Necesitamos tu consentimiento para enviarte correos.' });
      const nuevos = !(c.avisos && (c.avisos.eventos || c.avisos.rutinas || c.avisos.diario));
      await aplicarAvisos(email, c, a); await seg.redis(['SET', `cuenta:${email}`, JSON.stringify(c)]);
      if (nuevos) bienvenida(email, c);
      return res.status(200).json({ ok: true, avisos: c.avisos });
    }
    if (accion === 'avisos-prueba') {
      if (await seg.limitar('avisos-prueba:' + email, 3, 86400)) return res.status(429).json({ error: 'Solo puedes pedir 3 pruebas al día.' });
      const msg = await contenidoHoy(email, c, new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Madrid' }))) || { asunto: 'Hoy ya has entrenado 💪', html: '<p>Hoy ya has registrado un entreno. ¡Buen trabajo!</p>' };
      const r = await enviar(email, '[Prueba] ' + msg.asunto, msg.html);
      return res.status(r.enviado ? 200 : 502).json(r.enviado ? { ok: true } : { error: 'No se ha podido enviar: ' + r.motivo });
    }
    return res.status(400).json({ error: 'Acción no reconocida.' });
  } catch (err) { console.error('Error en api/recordatorios:', err); return res.status(502).json({ error: 'No se ha podido completar la operación ahora mismo.' }); }
}
module.exports = handler;
module.exports.aplicarAvisos = aplicarAvisos;
module.exports.bienvenida = bienvenida;
module.exports.indexar = indexar;

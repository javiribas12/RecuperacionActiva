// api/auth.js
// Autenticación real por email + contraseña, para que una persona tenga
// continuidad de su progreso entre dispositivos (antes solo existía un ID
// anónimo por navegador). Usa el módulo "crypto" que ya trae Node — no hace
// falta instalar ninguna librería nueva para el hash de contraseñas.
//
// Guarda: cuenta:{email} -> {email, nombre, salt, hash, fechaRegistro}
//         sesion:{token} -> email (con caducidad de 30 días)
// Requiere la misma base de datos Redis que api/progreso.js y api/admin-resumen.js.

const crypto = require('crypto');

const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

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

function hashPassword(password, salt) {
  // scrypt es lento a propósito (para dificultar ataques por fuerza bruta) — es el estándar
  // recomendado para contraseñas cuando no se usa una librería externa como bcrypt.
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function codigoNuevo() { const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let c = ''; const b = crypto.randomBytes(6); for (let i = 0; i < 6; i++) c += A[b[i] % A.length]; return c; }
function generarToken() {
  return crypto.randomBytes(32).toString('hex');
}

function emailValido(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

const DURACION_SESION_SEGUNDOS = 60 * 60 * 24 * 30; // 30 días
const DURACION_RESET_SEGUNDOS = 60 * 60; // 1 hora — el enlace de recuperación caduca pronto por seguridad

// Envía el email de recuperación con Resend (resend.com). Si no has configurado
// RESEND_API_KEY, esta función no falla: simplemente no hay envío real, y el mensaje
// que ve la persona en la web ya avisa de que revise si el correo no llega. Usa
// onboarding@resend.dev como remitente por defecto (funciona sin verificar dominio
// propio); puedes cambiarlo con la variable RESEND_FROM_EMAIL una vez verifiques tu dominio.
async function enviarEmailReset(email, enlace, codigo) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { enviado: false, motivo: 'RESEND_API_KEY no configurada' };
  const remitente = process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev';
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: `Recuperación Activa <${remitente}>`,
        to: email,
        subject: 'Recupera tu contraseña — Recuperación Activa',
        html: `
          <p>Has pedido restablecer tu contraseña en Recuperación Activa.</p>
          <p><a href="${enlace}" style="background:#E11F3D; color:#fff; padding:10px 18px; border-radius:8px; text-decoration:none; display:inline-block;">Elegir nueva contraseña</a></p>
          <p>O copia este enlace en tu navegador:<br>${enlace}</p>
          <p>Si el enlace no te funciona, entra en la web y pega este código manualmente: <b>${codigo}</b></p>
          <p style="color:#888; font-size:.85em;">Este enlace caduca en 1 hora. Si no has pedido esto, ignora el correo — tu contraseña sigue siendo la misma.</p>
        `
      })
    });
    if (!r.ok) { const t = await r.text().catch(()=> ''); return { enviado: false, motivo: 'Resend respondió con error: ' + t }; }
    return { enviado: true };
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

  if (!REDIS_URL || !REDIS_TOKEN) {
    return res.status(500).json({ error: 'El inicio de sesión no está disponible todavía: falta configurar la base de datos en el servidor.' });
  }

  const { accion, email, password, nombre, token, origen } = req.body || {};
  if (password && String(password).length > 200) return res.status(400).json({ error: 'La contraseña es demasiado larga.' });
  if (await seg.limitar('auth-ip:' + seg.ipDe(req), 300, 600)) return res.status(429).json({ error: 'Demasiadas peticiones. Espera unos minutos.' });

  try {
    if (accion === 'registro') {
      if (!emailValido(email)) return res.status(400).json({ error: 'Indica un email válido.' });
      if (!password || String(password).length < 8) return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres.' });
      const emailNorm = String(email).trim().toLowerCase();
      if (await seg.limitar('registro:' + emailNorm, 5, 3600) || await seg.limitar('registro-ip:' + seg.ipDe(req), 10, 3600)) return res.status(429).json({ error: 'Demasiados intentos. Espera unos minutos.' });

      const existente = await comandoRedis(['GET', `cuenta:${emailNorm}`]);
      if (existente) return res.status(409).json({ error: 'Ya existe una cuenta con ese email. Prueba a iniciar sesión en su lugar.' });

      const esEntrenador = req.body.rol === 'entrenador';
      const rolPedido = (req.body.rol === 'profesional' || esEntrenador) ? 'profesional' : 'paciente';
      const salt = crypto.randomBytes(16).toString('hex');
      const hash = hashPassword(password, salt);
      const cuenta = { email: emailNorm, nombre: (nombre ? String(nombre) : emailNorm).slice(0, 60), salt, hash, fechaRegistro: new Date().toISOString(), rol: rolPedido, consentimientoSalud: !!req.body.consentimientoSalud };

      if (esEntrenador) {
        // Entrenador/a: sin mutua ni colegiado. Se activa al momento y recibe su código/enlace de invitación.
        const pd = req.body.profesionalDatos || {};
        cuenta.profesionalDatos = { tipo: 'entrenador', mutua: 'Entrenador/a', centro: String(pd.centro || '').slice(0, 100), colegiado: '' };
        cuenta.profesionalEstado = 'verificado';
        let cod = codigoNuevo();
        for (let i = 0; i < 5 && await comandoRedis(['GET', `vinculo:${cod}`]); i++) cod = codigoNuevo();
        cuenta.codigoVinculacion = cod;
        await comandoRedis(['SET', `vinculo:${cod}`, emailNorm]);
      } else if (rolPedido === 'profesional') {
        const pd = req.body.profesionalDatos || {};
        if (!pd.mutua || !pd.centro || !pd.colegiado) {
          return res.status(400).json({ error: 'Para registrarte como profesional, indica la mutua, el centro y tu número de colegiado.' });
        }
        cuenta.profesionalDatos = { mutua: String(pd.mutua).slice(0, 100), centro: String(pd.centro).slice(0, 100), colegiado: String(pd.colegiado).slice(0, 60) };
        cuenta.profesionalEstado = 'pendiente';
        await comandoRedis(['SADD', 'indice:profesionales-pendientes', emailNorm]);
      }

      const avisosPedidos = req.body.avisos && req.body.avisosConsentimiento ? req.body.avisos : null;
      if (avisosPedidos) { try { await require('./recordatorios').aplicarAvisos(emailNorm, cuenta, avisosPedidos); } catch (e) { /* los avisos no bloquean el registro */ } }
      await comandoRedis(['SET', `cuenta:${emailNorm}`, JSON.stringify(cuenta)]);
      if (cuenta.avisos && (cuenta.avisos.eventos || cuenta.avisos.rutinas || cuenta.avisos.diario)) { try { await require('./recordatorios').bienvenida(emailNorm, cuenta); } catch (e) {} }

      const tok = generarToken();
      await comandoRedis(['SET', `sesion:${tok}`, emailNorm, 'EX', String(DURACION_SESION_SEGUNDOS)]);
      return res.status(200).json({ token: tok, nombre: cuenta.nombre, email: emailNorm, rol: cuenta.rol, profesionalEstado: cuenta.profesionalEstado || null, profesionalDatos: cuenta.profesionalDatos || null, codigoVinculacion: cuenta.codigoVinculacion || null, consentimientoSalud: !!cuenta.consentimientoSalud });
    }

    if (accion === 'login') {
      if (!emailValido(email) || !password) return res.status(400).json({ error: 'Indica tu email y contraseña.' });
      const emailNorm = String(email).trim().toLowerCase();
      if (await seg.limitar('login:' + emailNorm, 10, 600) || await seg.limitar('login-ip:' + seg.ipDe(req), 40, 600)) return res.status(429).json({ error: 'Demasiados intentos. Espera unos minutos antes de volver a probar.' });

      const raw = await comandoRedis(['GET', `cuenta:${emailNorm}`]);
      // Mensaje genérico a propósito: no decimos si el email existe o no, para no facilitar
      // que alguien compruebe qué emails están registrados.
      if (!raw) return res.status(401).json({ error: 'Email o contraseña incorrectos.' });
      const cuenta = JSON.parse(raw);
      const hashIntento = hashPassword(password, cuenta.salt);
      if (!seg.igual(hashIntento, cuenta.hash)) return res.status(401).json({ error: 'Email o contraseña incorrectos.' });

      const tok = generarToken();
      await comandoRedis(['SET', `sesion:${tok}`, emailNorm, 'EX', String(DURACION_SESION_SEGUNDOS)]);
      return res.status(200).json({ token: tok, nombre: cuenta.nombre, email: emailNorm, rol: cuenta.rol || 'paciente', profesionalEstado: cuenta.profesionalEstado || null, profesionalDatos: cuenta.profesionalDatos || null, codigoVinculacion: cuenta.codigoVinculacion || null, consentimientoSalud: !!cuenta.consentimientoSalud, profesionalVinculado: cuenta.profesionalVinculado || null });
    }

    if (accion === 'sesion') {
      // Comprueba si un token guardado en el navegador sigue siendo válido (para restaurar
      // la sesión al volver a cargar la página, sin pedir la contraseña otra vez).
      if (!token) return res.status(400).json({ error: 'Falta el token.' });
      const emailNorm = await comandoRedis(['GET', `sesion:${token}`]);
      if (!emailNorm) return res.status(401).json({ error: 'La sesión ha caducado.' });
      const raw = await comandoRedis(['GET', `cuenta:${emailNorm}`]);
      const cuenta = raw ? JSON.parse(raw) : null;
      return res.status(200).json({ email: emailNorm, nombre: cuenta ? cuenta.nombre : emailNorm, rol: cuenta ? (cuenta.rol || 'paciente') : 'paciente', profesionalEstado: cuenta ? (cuenta.profesionalEstado || null) : null, profesionalDatos: cuenta ? (cuenta.profesionalDatos || null) : null, codigoVinculacion: cuenta ? (cuenta.codigoVinculacion || null) : null, profesionalVinculado: cuenta ? (cuenta.profesionalVinculado || null) : null, consentimientoSalud: cuenta ? !!cuenta.consentimientoSalud : false });
    }

    if (accion === 'logout') {
      if (token) await comandoRedis(['DEL', `sesion:${token}`]);
      return res.status(200).json({ ok: true });
    }

    if (accion === 'solicitar-reset') {
      if (!emailValido(email)) return res.status(400).json({ error: 'Indica un email válido.' });
      const emailNorm = String(email).trim().toLowerCase();
      if (await seg.limitar('reset:' + emailNorm, 3, 3600) || await seg.limitar('reset-ip:' + seg.ipDe(req), 10, 3600)) {
        return res.status(200).json({ mensaje: 'Si ese email tiene una cuenta, te hemos enviado un enlace para recuperar la contraseña.' });
      }
      const raw = await comandoRedis(['GET', `cuenta:${emailNorm}`]);
      // Se responde con el MISMO mensaje exista o no la cuenta, siempre — así nadie puede
      // usar "olvidé mi contraseña" para averiguar qué emails están registrados.
      const mensajeGenerico = 'Si ese email tiene una cuenta, te hemos enviado un enlace para recuperar la contraseña. Revisa tu bandeja de entrada (y el spam).';
      if (!raw) return res.status(200).json({ mensaje: mensajeGenerico });

      const tok = generarToken();
      await comandoRedis(['SET', `reset:${tok}`, emailNorm, 'EX', String(DURACION_RESET_SEGUNDOS)]);
      const base = (typeof origen === 'string' && /^https?:\/\//.test(origen)) ? origen : (process.env.SITE_URL || '');
      const enlace = base ? `${base}/#restablecer/${tok}` : `(entra en la web y ve a "restablecer contraseña" con este código)`;
      const resultadoEnvio = await enviarEmailReset(emailNorm, enlace, tok);
      if (!resultadoEnvio.enviado) console.warn('No se pudo enviar el email de recuperación:', resultadoEnvio.motivo);
      return res.status(200).json({ mensaje: mensajeGenerico });
    }

    if (accion === 'restablecer') {
      if (!token) return res.status(400).json({ error: 'Falta el código de recuperación.' });
      if (!password || String(password).length < 8) return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres.' });
      const emailNorm = await comandoRedis(['GET', `reset:${token}`]);
      if (!emailNorm) return res.status(400).json({ error: 'El enlace no es válido o ha caducado. Pide uno nuevo.' });

      const raw = await comandoRedis(['GET', `cuenta:${emailNorm}`]);
      if (!raw) return res.status(400).json({ error: 'Esta cuenta ya no existe.' });
      const cuenta = JSON.parse(raw);

      const salt = crypto.randomBytes(16).toString('hex');
      cuenta.hash = hashPassword(password, salt);
      cuenta.salt = salt;
      await comandoRedis(['SET', `cuenta:${emailNorm}`, JSON.stringify(cuenta)]);
      await comandoRedis(['DEL', `reset:${token}`]); // el código solo se puede usar una vez

      // Para comodidad, se inicia sesión automáticamente tras cambiar la contraseña.
      const tokSesion = generarToken();
      await comandoRedis(['SET', `sesion:${tokSesion}`, emailNorm, 'EX', String(DURACION_SESION_SEGUNDOS)]);
      return res.status(200).json({ token: tokSesion, nombre: cuenta.nombre, email: emailNorm });
    }

    if (accion === 'invitacion-info') {
      // Público: permite mostrar "Tu entrenador X te invita" antes de registrarse. Solo devuelve nombre y club.
      if (await seg.limitar('invit-ip:' + seg.ipDe(req), 60, 600)) return res.status(429).json({ error: 'Demasiadas peticiones.' });
      const cod = String(req.body.codigo || '').trim().toUpperCase().slice(0, 12);
      const pe = cod ? await comandoRedis(['GET', `vinculo:${cod}`]) : null;
      if (!pe) return res.status(404).json({ error: 'Este enlace de invitación no es válido o ha caducado.' });
      const rp = await comandoRedis(['GET', `cuenta:${pe}`]);
      const cp = rp ? JSON.parse(rp) : null;
      return res.status(200).json({ nombre: cp ? cp.nombre : 'Tu entrenador/a', club: cp && cp.profesionalDatos ? cp.profesionalDatos.centro || '' : '' });
    }

    if (accion === 'desvincular') {
      // El jugador/paciente decide dejar de compartir sus datos con su entrenador o profesional.
      const em = token ? await comandoRedis(['GET', `sesion:${token}`]) : null;
      if (!em) return res.status(401).json({ error: 'La sesión ha caducado. Vuelve a iniciar sesión.' });
      const rw = await comandoRedis(['GET', `cuenta:${em}`]); const cu = rw ? JSON.parse(rw) : null;
      if (cu && cu.profesionalVinculado) {
        await comandoRedis(['SREM', `profesional:${cu.profesionalVinculado}:pacientes`, em]);
        delete cu.profesionalVinculado; await comandoRedis(['SET', `cuenta:${em}`, JSON.stringify(cu)]);
      }
      return res.status(200).json({ ok: true });
    }

    if (accion === 'vincular-codigo') {
      if (!token) return res.status(400).json({ error: 'Tienes que haber iniciado sesión para vincularte a un profesional.' });
      const emailNorm = await comandoRedis(['GET', `sesion:${token}`]);
      if (!emailNorm) return res.status(401).json({ error: 'La sesión ha caducado. Vuelve a iniciar sesión.' });
      const codigoNorm = String(req.body.codigo || '').trim().toUpperCase();
      if (!codigoNorm) return res.status(400).json({ error: 'Indica el código que te ha dado tu profesional.' });

      const profEmail = await comandoRedis(['GET', `vinculo:${codigoNorm}`]);
      if (!profEmail) return res.status(404).json({ error: 'Ese código no es válido. Compruébalo con tu profesional.' });

      const raw = await comandoRedis(['GET', `cuenta:${emailNorm}`]);
      if (!raw) return res.status(400).json({ error: 'Tu cuenta ya no existe.' });
      const cuenta = JSON.parse(raw);
      cuenta.profesionalVinculado = profEmail;
      await comandoRedis(['SET', `cuenta:${emailNorm}`, JSON.stringify(cuenta)]);
      await comandoRedis(['SADD', `profesional:${profEmail}:pacientes`, emailNorm]);

      const rawProf = await comandoRedis(['GET', `cuenta:${profEmail}`]);
      const cuentaProf = rawProf ? JSON.parse(rawProf) : null;
      return res.status(200).json({ ok: true, profesionalNombre: cuentaProf ? cuentaProf.nombre : profEmail });
    }

    if (accion === 'listar-pacientes') {
      if (!token) return res.status(400).json({ error: 'Tienes que haber iniciado sesión.' });
      const emailNorm = await comandoRedis(['GET', `sesion:${token}`]);
      if (!emailNorm) return res.status(401).json({ error: 'La sesión ha caducado. Vuelve a iniciar sesión.' });
      const raw = await comandoRedis(['GET', `cuenta:${emailNorm}`]);
      const cuenta = raw ? JSON.parse(raw) : null;
      if (!cuenta || cuenta.rol !== 'profesional') return res.status(403).json({ error: 'Esto solo está disponible para cuentas de profesional.' });
      if (cuenta.profesionalEstado !== 'verificado') return res.status(403).json({ error: 'Tu cuenta de profesional todavía no ha sido verificada.' });

      const emailsPacientes = (await comandoRedis(['SMEMBERS', `profesional:${emailNorm}:pacientes`])) || [];
      const pacientes = [];
      for (const emailPaciente of emailsPacientes) {
        const rawP = await comandoRedis(['GET', `cuenta:${emailPaciente}`]);
        const cp = rawP ? JSON.parse(rawP) : null;
        const rawHist = await comandoRedis(['GET', `historial:${emailPaciente}`]);
        const historial = rawHist ? JSON.parse(rawHist) : [];
        const rawPlan = await comandoRedis(['GET', `plan-pautado:${emailPaciente}`]);
        pacientes.push({ email: emailPaciente, nombre: cp ? cp.nombre : emailPaciente, ultimoHistorial: historial[0] || null, tienePlan: !!rawPlan });
      }
      return res.status(200).json({ codigoVinculacion: cuenta.codigoVinculacion || null, pacientes });
    }

    if (accion === 'guardar-historial') {
      if (!token) return res.status(400).json({ error: 'Tienes que haber iniciado sesión.' });
      const emailNorm = await comandoRedis(['GET', `sesion:${token}`]);
      if (!emailNorm) return res.status(401).json({ error: 'La sesión ha caducado. Vuelve a iniciar sesión.' });
      const raw = await comandoRedis(['GET', `cuenta:${emailNorm}`]);
      const cuenta = raw ? JSON.parse(raw) : null;
      if (!cuenta) return res.status(400).json({ error: 'Tu cuenta ya no existe.' });
      if (!cuenta.consentimientoSalud) return res.status(200).json({ ok: false, motivo: 'sin-consentimiento' }); // no es un error: la persona no dio permiso, se respeta en silencio

      const entrada = req.body.entrada || {};
      if (!entrada.zona) return res.status(400).json({ error: 'Falta la zona del historial.' });
      const rawHist = await comandoRedis(['GET', `historial:${emailNorm}`]);
      const historial = rawHist ? JSON.parse(rawHist) : [];
      const hoy = new Date().toISOString().slice(0, 10);
      const yaHoy = historial.find(h => h.zona === entrada.zona && h.fecha && h.fecha.slice(0, 10) === hoy);
      if (yaHoy) { yaHoy.patronPrincipal = entrada.patronPrincipal; yaHoy.edad = entrada.edad; }
      else { historial.unshift({ id: 'hist-' + Date.now(), fecha: new Date().toISOString(), zona: entrada.zona, lado: entrada.lado || null, patronPrincipal: entrada.patronPrincipal || '', edad: entrada.edad || null }); }
      await comandoRedis(['SET', `historial:${emailNorm}`, JSON.stringify(historial.slice(0, 20))]);
      return res.status(200).json({ ok: true });
    }

    if (accion === 'listar-historial') {
      if (!token) return res.status(400).json({ error: 'Tienes que haber iniciado sesión.' });
      const emailNorm = await comandoRedis(['GET', `sesion:${token}`]);
      if (!emailNorm) return res.status(401).json({ error: 'La sesión ha caducado. Vuelve a iniciar sesión.' });
      const rawHist = await comandoRedis(['GET', `historial:${emailNorm}`]);
      return res.status(200).json({ historial: rawHist ? JSON.parse(rawHist) : [] });
    }

    if (accion === 'historial-paciente') {
      // Un profesional consulta el historial de UN paciente concreto — solo si está vinculado a él.
      if (!token) return res.status(400).json({ error: 'Tienes que haber iniciado sesión.' });
      const emailProf = await comandoRedis(['GET', `sesion:${token}`]);
      if (!emailProf) return res.status(401).json({ error: 'La sesión ha caducado. Vuelve a iniciar sesión.' });
      const rawProf = await comandoRedis(['GET', `cuenta:${emailProf}`]);
      const cuentaProf = rawProf ? JSON.parse(rawProf) : null;
      if (!cuentaProf || cuentaProf.rol !== 'profesional' || cuentaProf.profesionalEstado !== 'verificado') return res.status(403).json({ error: 'Esto solo está disponible para profesionales verificados.' });
      const pacienteEmail = String(req.body.pacienteEmail || '').trim().toLowerCase();
      const esSuPaciente = await comandoRedis(['SMEMBERS', `profesional:${emailProf}:pacientes`]);
      if (!esSuPaciente || !esSuPaciente.includes(pacienteEmail)) return res.status(403).json({ error: 'Ese paciente no está vinculado a tu cuenta.' });
      const rawHist = await comandoRedis(['GET', `historial:${pacienteEmail}`]);
      return res.status(200).json({ historial: rawHist ? JSON.parse(rawHist) : [] });
    }

    if (accion === 'pautar-plan') {
      // Un profesional asigna un plan semanal (zona + días) a un paciente vinculado.
      if (!token) return res.status(400).json({ error: 'Tienes que haber iniciado sesión.' });
      const emailProf = await comandoRedis(['GET', `sesion:${token}`]);
      if (!emailProf) return res.status(401).json({ error: 'La sesión ha caducado. Vuelve a iniciar sesión.' });
      const rawProf = await comandoRedis(['GET', `cuenta:${emailProf}`]);
      const cuentaProf = rawProf ? JSON.parse(rawProf) : null;
      if (!cuentaProf || cuentaProf.rol !== 'profesional' || cuentaProf.profesionalEstado !== 'verificado') return res.status(403).json({ error: 'Esto solo está disponible para profesionales verificados.' });

      const pacienteEmail = String(req.body.pacienteEmail || '').trim().toLowerCase();
      const misPacientes = await comandoRedis(['SMEMBERS', `profesional:${emailProf}:pacientes`]);
      if (!misPacientes || !misPacientes.includes(pacienteEmail)) return res.status(403).json({ error: 'Ese paciente no está vinculado a tu cuenta.' });

      const { zona, dias, ejercicios } = req.body;
      const diasValidos = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo'];
      if (!zona) return res.status(400).json({ error: 'Falta la zona del plan.' });
      if (!Array.isArray(dias) || !dias.length || dias.some(d => !diasValidos.includes(d))) return res.status(400).json({ error: 'Elige al menos un día de la semana válido.' });
      if (!Array.isArray(ejercicios) || !ejercicios.length) return res.status(400).json({ error: 'El plan necesita al menos un ejercicio.' });

      const plan = { profesionalEmail: emailProf, profesionalNombre: cuentaProf.nombre, zona: String(zona).slice(0, 100), dias, ejercicios: ejercicios.slice(0, 12), asignadoEn: new Date().toISOString() };
      await comandoRedis(['SET', `plan-pautado:${pacienteEmail}`, JSON.stringify(plan)]);
      return res.status(200).json({ ok: true });
    }

    if (accion === 'mi-plan-pautado') {
      if (!token) return res.status(400).json({ error: 'Tienes que haber iniciado sesión.' });
      const emailNorm = await comandoRedis(['GET', `sesion:${token}`]);
      if (!emailNorm) return res.status(401).json({ error: 'La sesión ha caducado. Vuelve a iniciar sesión.' });
      const rawPlan = await comandoRedis(['GET', `plan-pautado:${emailNorm}`]);
      if (!rawPlan) return res.status(200).json({ plan: null });
      const plan = JSON.parse(rawPlan);
      const hoy = new Date().toISOString().slice(0, 10);
      const rawChecks = await comandoRedis(['SMEMBERS', `checks-plan:${emailNorm}:${hoy}`]);
      return res.status(200).json({ plan, checksHoy: rawChecks || [] });
    }

    if (accion === 'marcar-ejercicio-dia') {
      if (!token) return res.status(400).json({ error: 'Tienes que haber iniciado sesión.' });
      const emailNorm = await comandoRedis(['GET', `sesion:${token}`]);
      if (!emailNorm) return res.status(401).json({ error: 'La sesión ha caducado. Vuelve a iniciar sesión.' });
      const ejercicioId = String(req.body.ejercicioId || '');
      if (!ejercicioId) return res.status(400).json({ error: 'Falta el ejercicio.' });
      const hoy = new Date().toISOString().slice(0, 10);
      if (req.body.hecho === false) {
        await comandoRedis(['SREM', `checks-plan:${emailNorm}:${hoy}`, ejercicioId]);
      } else {
        await comandoRedis(['SADD', `checks-plan:${emailNorm}:${hoy}`, ejercicioId]);
      }
      return res.status(200).json({ ok: true });
    }

    if (accion === 'checks-paciente') {
      // Un profesional consulta cómo lleva un paciente vinculado el plan de hoy.
      if (!token) return res.status(400).json({ error: 'Tienes que haber iniciado sesión.' });
      const emailProf = await comandoRedis(['GET', `sesion:${token}`]);
      if (!emailProf) return res.status(401).json({ error: 'La sesión ha caducado.' });
      const pacienteEmail = String(req.body.pacienteEmail || '').trim().toLowerCase();
      const misPacientes = await comandoRedis(['SMEMBERS', `profesional:${emailProf}:pacientes`]);
      if (!misPacientes || !misPacientes.includes(pacienteEmail)) return res.status(403).json({ error: 'Ese paciente no está vinculado a tu cuenta.' });
      const hoy = new Date().toISOString().slice(0, 10);
      const checksHoy = await comandoRedis(['SMEMBERS', `checks-plan:${pacienteEmail}:${hoy}`]);
      return res.status(200).json({ checksHoy: checksHoy || [] });
    }

    if (accion === 'checks-semana-paciente') {
      // Cumplimiento real de los últimos 7 días — no solo el plan de hoy, para que el profesional
      // vea de un vistazo si el paciente está siguiendo el plan o llevaba varios días sin entrar.
      if (!token) return res.status(400).json({ error: 'Tienes que haber iniciado sesión.' });
      const emailProf = await comandoRedis(['GET', `sesion:${token}`]);
      if (!emailProf) return res.status(401).json({ error: 'La sesión ha caducado.' });
      const pacienteEmail = String(req.body.pacienteEmail || '').trim().toLowerCase();
      const misPacientes = await comandoRedis(['SMEMBERS', `profesional:${emailProf}:pacientes`]);
      if (!misPacientes || !misPacientes.includes(pacienteEmail)) return res.status(403).json({ error: 'Ese paciente no está vinculado a tu cuenta.' });
      const dias = [];
      for (let i = 6; i >= 0; i--) {
        const fecha = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
        const checks = await comandoRedis(['SMEMBERS', `checks-plan:${pacienteEmail}:${fecha}`]);
        dias.push({ fecha, cantidad: (checks || []).length });
      }
      return res.status(200).json({ dias });
    }

    if (accion === 'borrar-cuenta') {
      // Derecho al olvido (RGPD): borra la cuenta y todo lo asociado a ella.
      if (!token) return res.status(400).json({ error: 'Tienes que haber iniciado sesión.' });
      const emailNorm = await comandoRedis(['GET', `sesion:${token}`]);
      if (!emailNorm) return res.status(401).json({ error: 'La sesión ha caducado. Vuelve a iniciar sesión.' });
      const raw = await comandoRedis(['GET', `cuenta:${emailNorm}`]);
      const cuenta = raw ? JSON.parse(raw) : null;

      if (cuenta && cuenta.profesionalVinculado) {
        await comandoRedis(['SREM', `profesional:${cuenta.profesionalVinculado}:pacientes`, emailNorm]);
      }
      if (cuenta && cuenta.rol === 'profesional') {
        const misPacientes = (await comandoRedis(['SMEMBERS', `profesional:${emailNorm}:pacientes`])) || [];
        for (const p of misPacientes) {
          const rawP = await comandoRedis(['GET', `cuenta:${p}`]);
          if (rawP) { const cp = JSON.parse(rawP); delete cp.profesionalVinculado; await comandoRedis(['SET', `cuenta:${p}`, JSON.stringify(cp)]); }
        }
        await comandoRedis(['DEL', `profesional:${emailNorm}:pacientes`]);
        if (cuenta.codigoVinculacion) await comandoRedis(['DEL', `vinculo:${cuenta.codigoVinculacion}`]);
        await comandoRedis(['SREM', 'indice:profesionales-pendientes', emailNorm]);
      }
      // Derecho de supresión: se borra también el progreso, las técnicas con cámara y los entrenos
      for (const k of ['perfil', 'sesiones', 'tecnica', 'entrenos', 'rutina', 'diario', 'objetivos', 'mensajes']) await comandoRedis(['DEL', `usuario:${emailNorm}:${k}`]);
      for (const ind of ['indice:avisos-diario', 'indice:avisos-rutinas', 'indice:avisos-eventos']) await comandoRedis(['SREM', ind, emailNorm]);
      await comandoRedis(['SREM', 'indice:usuarios', emailNorm]);
      await comandoRedis(['DEL', `historial:${emailNorm}`]);
      await comandoRedis(['DEL', `plan-pautado:${emailNorm}`]);
      await comandoRedis(['DEL', `cuenta:${emailNorm}`]);
      await comandoRedis(['DEL', `sesion:${token}`]);
      return res.status(200).json({ ok: true });
    }

    if (accion === 'guardar-valoracion-chat') {
      // Guarda cada 👍/👎 que alguien pulsa en una respuesta del chat, para que el creador de la
      // web pueda ver qué está fallando de verdad (no solo en su propio dispositivo, que era como
      // estaba guardándose antes). No requiere sesión — es anónimo, solo un texto corto y un valor.
      if (await seg.limitar('valoracion-ip:' + seg.ipDe(req), 30, 3600)) return res.status(429).json({ error: 'Demasiadas valoraciones.' });
      const valor = req.body.valor === 'util' ? 'util' : 'no-util';
      const texto = String(req.body.texto || '').slice(0, 200);
      const entrada = JSON.stringify({ texto, valor, fecha: Date.now() });
      await comandoRedis(['LPUSH', 'valoraciones-chat', entrada]);
      await comandoRedis(['LTRIM', 'valoraciones-chat', '0', '499']); // no crece sin límite
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'Acción no reconocida.' });
  } catch (err) {
    console.error('Error en api/auth:', err);
    return res.status(502).json({ error: 'No se ha podido completar la operación ahora mismo. Inténtalo de nuevo en un momento.' });
  }
};

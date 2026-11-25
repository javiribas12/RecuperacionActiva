// api/preguntar.js
// Ruta backend privada para "Activa Responde" de Recuperación Activa.
// Se despliega en Vercel como función serverless. La clave de Gemini NUNCA
// llega al navegador: solo vive aquí, en el servidor, leída de la variable
// de entorno GEMINI_API_KEY.

// Modelos a probar en orden. Puedes fijar el principal con la variable de entorno GEMINI_MODEL en Vercel.
// Si uno devuelve 404 (nombre inexistente o retirado), se prueba automáticamente el siguiente.
const MODELOS_GEMINI = [process.env.GEMINI_MODEL, 'gemini-3.6-flash', 'gemini-3.5-flash-lite', 'gemini-2.5-flash'].filter((m, i, a) => m && a.indexOf(m) === i);
const urlModelo = (m) => `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`;

const LIMITE_CONSULTAS_POR_HORA = 20;
const ventanaConsultas = new Map();

function excedeLimite(usuarioId) {
  const ahora = Date.now();
  const unaHora = 60 * 60 * 1000;
  const historial = (ventanaConsultas.get(usuarioId) || []).filter(t => ahora - t < unaHora);
  if (historial.length >= LIMITE_CONSULTAS_POR_HORA) {
    ventanaConsultas.set(usuarioId, historial);
    return true;
  }
  historial.push(ahora);
  ventanaConsultas.set(usuarioId, historial);
  return false;
}

const FUENTES_APROBADAS = [
  'PubMed (pubmed.ncbi.nlm.nih.gov)',
  'PEDro (pedro.org.au)',
  'Cochrane Library (cochranelibrary.com)',
  'JOSPT Clinical Practice Guidelines (jospt.org)',
  'NICE (nice.org.uk)',
  'GuíaSalud (guiasalud.es)',
  'British Journal of Sports Medicine (bjsm.bmj.com)',
  'ACSM (acsm.org)',
  'NHS (nhs.uk)',
  'HSS (hss.edu)',
  'AAOS (orthoinfo.aaos.org)',
  'ChoosePT (choosept.com)',
  'American Cancer Society (cancer.org)',
  'ACSM Moving Through Cancer (acsm.org/moving-through-cancer)',
  'Alzheimer\'s Association / Alzheimer\'s Society (alz.org, alzheimers.org.uk)',
  'ALS Association / MDA (als.org, mda.org)',
 'Guía "Uso eficiente del ejercicio terapéutico en Fisioterapia" — Comisión de Ejercicio Terapéutico del Ilustre Colegio Profesional de Fisioterapeutas de la Comunidad de Madrid (ICPFCM)',
 'OMS — Directrices sobre actividad física y hábitos sedentarios 2020 (who.int)',
 'ACOG — Committee Opinion 804, actividad física en embarazo y posparto (acog.org)',
 'World Guidelines for Falls Prevention and Management for Older Adults, Age and Ageing 2022',
 'StatPearls / NCBI Bookshelf (ncbi.nlm.nih.gov/books)',
 'Ministerio de Sanidad de España — Recomendaciones de actividad física (sanidad.gob.es)',
 'Sociedades científicas: AEP (aeped.es), SEGG (segg.es), SEGO (sego.es), AEU (aeu.es), SEN (sen.es)'
];

function construirPromptSistema(contexto) {
  const {
    edad, objetivo, deporte, intensidad, fase, resultadoCuestionario, modoProfundo
  } = contexto || {};

  return `Eres el asistente de "Recuperación Activa", una web de fisioterapia y entrenamiento personal.

REGLAS OBLIGATORIAS:
- Responde SIEMPRE a lo que te pregunten: salud, lesiones, entrenamiento, Pilates, nutrición, la propia web, o cualquier otro tema (tiempo, precios, noticias, deporte, dudas generales). Nunca digas que algo "queda fuera de lo que puedes responder" ni te niegues por no ser de fisioterapia. Si es un tema ajeno, respóndelo igualmente de forma útil; si es de salud, añade la matización profesional que corresponda.
- Nunca afirmes un diagnóstico definitivo. Usa expresiones como "podría ser compatible con..." o "esto sugiere, sin confirmarlo...".
- Indica siempre cuándo hace falta una valoración profesional presencial.
- Puedes y debes responder preguntas sobre cualquier condición de salud que te planteen, no solo lesiones musculoesqueléticas: enfermedades crónicas (diabetes, cardiopatías), neurológicas o neurodegenerativas (Párkinson, Alzheimer, ELA, esclerosis múltiple), o cáncer y tumores (en tratamiento activo, supervivientes, con metástasis óseas u otras). Nunca rechaces la pregunta por tratarse de una enfermedad grave — la evidencia real en estas áreas (ACSM, Alzheimer's Association, ALS Association, American Cancer Society) respalda que el ejercicio adaptado suele ser seguro y beneficioso, y tu papel es explicarlo con la matización adecuada a cada caso.
- Cuanto más grave, progresiva o compleja sea la condición (ELA, Alzheimer avanzado, cáncer en tratamiento activo, metástasis óseas...), más debes insistir en que el ejercicio concreto lo paute y supervise el especialista de esa persona (neurólogo, oncólogo, fisioterapeuta especializado) — no ofrezcas un plan autónomo detallado para estos casos, limítate a principios generales seguros y a explicar qué dice la evidencia.
- Responde con detalle y rigor a preguntas de neurología (ictus, párkinson, esclerosis múltiple, ELA, neuropatías), urología y suelo pélvico (incontinencia, prolapso, dolor pélvico, próstata), ginecología (embarazo, posparto, menopausia, dismenorrea), pediatría (lesiones de crecimiento como Osgood-Schlatter o Sever, dolores de crecimiento, actividad física infantil) y geriatría (caídas, sarcopenia, fragilidad). Ofrece siempre: una hipótesis redactada como «podría ser compatible con…», las señales de alarma que obligan a consultar, ejercicios o pautas generales, consejos prácticos y una fuente aprobada.
- En estas especialidades, nunca des dosis de medicamentos (menos aún a menores), no sustituyas la valoración médica y pon primero las urgencias: ictus (cara, brazo, habla: 112), dolor lumbar con problemas urinarios o adormecimiento genital (posible síndrome de cauda equina), sangrado o contracciones en el embarazo, fiebre con cojera o dolor óseo en un niño, caída con golpe en la cabeza en una persona mayor. Con menores, dirige el consejo a madres, padres o tutores.
- Para preguntas de fisioterapia, salud o entrenamiento, basa tus respuestas en evidencia de estas fuentes aprobadas: ${FUENTES_APROBADAS.join(', ')}.
- Tienes acceso a búsqueda en Google en tiempo real (grounding). Úsala sin dudarlo para cualquier pregunta que dependa de datos actuales o cambiantes — el tiempo que hace, precios, noticias del día, resultados deportivos, fechas de eventos, o cualquier otra cosa que tu conocimiento de entrenamiento no pueda saber por sí solo. No te niegues a responder este tipo de preguntas: son perfectamente válidas aunque no sean de fisioterapia.
- Para preguntas que sí sean de fisioterapia o salud, Google solo sirve para localizar información, nunca como fuente final citada — cita la fuente médica aprobada correspondiente.
- No repitas literalmente el contenido de respuestas anteriores de esta conversación; si el usuario pide "más información", aporta algo nuevo (otro ejemplo, otra progresión, otra fuente).
- Responde en español, de forma directa y breve primero, y desarrolla solo si aporta valor.
- Si te faltan datos para responder con seguridad, dilo y haz una única pregunta concreta para afinar.
${modoProfundo ? `
MODO ANÁLISIS A FONDO ACTIVADO — la persona ha pedido expresamente una respuesta más completa esta vez:
- No te limites a lo breve: desarrolla el razonamiento fisiológico o mecánico de por qué ocurre lo que describe, no solo qué hacer.
- Considera y menciona explícitamente diagnósticos diferenciales o causas alternativas plausibles, no solo la más probable.
- Si aplica, distingue cómo cambiaría tu respuesta según variables como la edad, el nivel de actividad o la cronicidad del problema.
- Cita más de una fuente de la lista aprobada cuando el tema lo permita, no solo una.
- Aun así, sigue siendo preciso y evita relleno: cada frase debe aportar algo, no alargues por alargar.` : ''}

CONTEXTO DE ESTA PERSONA (úsalo para personalizar cuando la pregunta sea de fisioterapia o entrenamiento; ignóralo si la pregunta no tiene relación, como el tiempo o precios):
- Edad: ${edad || 'no indicada'}
- Objetivo: ${objetivo || 'no indicado'}
- Deporte: ${deporte || 'no indicado'}
- Intensidad habitual: ${intensidad || 'no indicada'}
- Fase actual (entrenamiento o readaptación): ${fase || 'no indicada'}
- Resultado de su cuestionario inicial: ${resultadoCuestionario ? JSON.stringify(resultadoCuestionario) : 'no ha completado el cuestionario todavía'}

Al final de tu respuesta, en una línea aparte, indica qué fuentes de la lista aprobada respaldan lo que has dicho, en este formato exacto:
FUENTES_USADAS: fuente 1; fuente 2`;
}

// Llama a Gemini una vez. Devuelve { texto } si va bien, o { error, reintentable } si falla.
async function llamarGeminiUnaVez(apiKey, promptSistema, contents, maxTokens, modelo) {
 try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000); // más margen: analizar una foto tarda más que solo texto

    const r = await fetch(`${urlModelo(modelo)}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        system_instruction: { parts: [{ text: promptSistema }] },
        contents,
        tools: [{ google_search: {} }],
        // Preguntas de salud y lesiones pueden activar filtros por error: se relajan para que el asistente responda.
        safetySettings: ['HARM_CATEGORY_HARASSMENT','HARM_CATEGORY_HATE_SPEECH','HARM_CATEGORY_SEXUALLY_EXPLICIT','HARM_CATEGORY_DANGEROUS_CONTENT']
          .map(category => ({ category, threshold: 'BLOCK_ONLY_HIGH' })),
        generationConfig: {
          temperature: 0.4,
          maxOutputTokens: maxTokens || 700
        }
      })
    });
    clearTimeout(timeout);

    if (!r.ok) {
      const textoError = await r.text().catch(() => '');
      console.error('Error de la API de Gemini:', r.status, textoError);
      // 429 (límite) y errores 5xx de Google son los únicos casos donde reintentar tiene sentido;
      // un 400/404 (mala petición o modelo mal escrito) fallará igual la segunda vez, así que no se reintenta.
      const reintentable = r.status === 429 || r.status >= 500;
      return { error: `Gemini respondió con estado ${r.status}`, reintentable, modeloNoExiste: r.status === 404 };
    }

    const data = await r.json();
    const texto = (data?.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('') || '';
    if (!texto) {
      return { error: 'Respuesta vacía de Gemini', reintentable: true };
    }
    return { texto };
  } catch (err) {
    const esTimeout = err.name === 'AbortError';
    console.error('Fallo llamando a Gemini:', err);
    // Un timeout o un fallo de red sí merece un segundo intento.
    return { error: esTimeout ? 'Timeout' : 'Error de red', reintentable: true };
  }
}

const seg = require('./_seguridad');

module.exports = async function handler(req, res) {
  const origenOk = seg.cors(req, res, 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(origenOk ? 204 : 403).end();
  if (!origenOk) return res.status(403).json({ error: 'Origen no permitido.' });

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido. Usa POST.' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('Falta la variable de entorno GEMINI_API_KEY en el servidor.');
    return res.status(500).json({
      error: 'El asistente no está disponible ahora mismo. Inténtalo de nuevo más tarde.',
      detalle: 'Configuración del servidor incompleta.'
    });
  }

  const {
    pregunta,
    historial,
    edad,
    objetivo,
    deporte,
    intensidad,
    fase,
    resultadoCuestionario,
    usuarioId,
    modoProfundo,
    imagen // { base64, mimeType } opcional — foto adjunta desde el chat
  } = req.body || {};

  if (!pregunta || typeof pregunta !== 'string' || !pregunta.trim()) {
    return res.status(400).json({ error: 'Falta el campo "pregunta".' });
  }

  // Validación básica de la imagen, si viene una: solo tipos de imagen reales y un tamaño razonable
  // (Gemini tiene su propio límite, pero rechazamos aquí lo evidentemente mal formado o excesivo).
  let imagenValida = null;
  if (imagen && imagen.base64 && imagen.mimeType) {
    const tiposPermitidos = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];
    const tamanoAproxBytes = imagen.base64.length * 0.75;
    if (tiposPermitidos.includes(imagen.mimeType) && tamanoAproxBytes < 10 * 1024 * 1024) {
      imagenValida = imagen;
    } else {
      console.warn('Imagen adjunta rechazada por tipo o tamaño:', imagen.mimeType, tamanoAproxBytes);
    }
  }

  // --- Cuota diaria de mensajes (como ChatGPT/Gemini): gratis 5/día, Premium 60/día ---
  const CUOTA_GRATIS = 5, CUOTA_PREMIUM = 60;
  let emailCuota = null, esPremium = false;
  const tokenSesion = (req.body || {}).token;
  try {
    if (tokenSesion) {
      emailCuota = await seg.redisCmd(['GET', 'sesion:' + tokenSesion]);
      if (emailCuota) {
        const hasta = await seg.redisCmd(['GET', 'premium:' + emailCuota]);
        esPremium = !!hasta && Date.parse(hasta) > Date.now();
      }
    }
  } catch (e) { /* sin Redis: se trata como gratis */ }
  const limiteDia = esPremium ? CUOTA_PREMIUM : CUOTA_GRATIS;
  const hoy = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Madrid' });
  const claveCuota = 'iaq:' + (emailCuota || ('ip:' + seg.ipDe(req))) + ':' + hoy;
  let usados = 0;
  try {
    usados = await seg.redisCmd(['INCR', claveCuota]);
    if (usados === 1) await seg.redisCmd(['EXPIRE', claveCuota, '90000']);
  } catch (e) { usados = 1; }
  const uso = () => ({ plan: esPremium ? 'premium' : 'gratis', usados: Math.min(usados, limiteDia), limite: limiteDia, quedan: Math.max(0, limiteDia - usados) });
  if (usados > limiteDia) {
    return res.status(429).json({
      cuota: true, uso: uso(),
      error: esPremium
        ? `Has llegado a tus ${CUOTA_PREMIUM} mensajes de hoy. Se renuevan mañana a las 00:00 (hora de España).`
        : `Has usado tus ${CUOTA_GRATIS} mensajes gratis de hoy. Con Premium (3,99 €/mes) tienes ${CUOTA_PREMIUM} al día. Si no, se renuevan mañana.`
    });
  }

  const idParaLimite = usuarioId || req.headers['x-forwarded-for'] || 'anonimo';
  if (await seg.limitar('ia-ip:' + seg.ipDe(req), 40, 3600) || await seg.limitar('ia-dia:' + seg.ipDe(req), 150, 86400)) {
    return res.status(429).json({
      error: `Has hecho demasiadas preguntas en poco tiempo (límite: ${LIMITE_CONSULTAS_POR_HORA} por hora). Espera un poco antes de volver a preguntar.`
    });
  }

  // Estadísticas anónimas para el panel del fundador (llamadas de IA por día y últimas preguntas, sin datos personales).
  try {
    const dia = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Madrid' });
    await seg.redisCmd(['INCR', 'stat:ia:' + dia]);
    await seg.redisCmd(['EXPIRE', 'stat:ia:' + dia, '10368000']);
    await seg.redisCmd(['LPUSH', 'stat:preg', JSON.stringify({ q: String(pregunta).replace(/[\u0000-\u001f<>]/g, ' ').trim().slice(0, 120), t: new Date().toISOString(), p: esPremium ? 1 : 0 })]);
    await seg.redisCmd(['LTRIM', 'stat:preg', '0', '99']);
  } catch (e) { /* las estadísticas nunca bloquean la respuesta */ }

  const contents = [];
  if (Array.isArray(historial)) {
    historial.slice(-10).forEach(turno => {
      contents.push({
        role: turno.rol === 'asistente' ? 'model' : 'user',
        parts: [{ text: turno.texto || '' }]
      });
    });
  }
  const partesUltimoMensaje = [{ text: pregunta }];
  if (imagenValida) {
    partesUltimoMensaje.push({
      inline_data: { mime_type: imagenValida.mimeType, data: imagenValida.base64 }
    });
  }
  contents.push({ role: 'user', parts: partesUltimoMensaje });

  const notaImagen = imagenValida
    ? '\n\nLa persona ha adjuntado una foto junto a su pregunta. Descríbela brevemente y da tu orientación general basándote en lo que se ve (por ejemplo, hinchazón, color de la piel, alineación, postura), pero deja muy claro que una foto nunca sustituye una valoración presencial y que tu análisis tiene limitaciones importantes al no poder explorar ni tocar la zona.'
    : '';
  const promptSistema = construirPromptSistema({ edad, objetivo, deporte, intensidad, fase, resultadoCuestionario, modoProfundo }) + notaImagen;
  const maxTokens = modoProfundo ? 1400 : 700;

  // Prueba cada modelo de la lista; si el nombre no existe (404) pasa al siguiente.
  // Si el fallo es pasajero (429/5xx/timeout/vacío) reintenta UNA vez con el mismo modelo.
  let resultado = { error: 'Sin modelos' };
  for (const modelo of MODELOS_GEMINI) {
    resultado = await llamarGeminiUnaVez(apiKey, promptSistema, contents, maxTokens, modelo);
    if (resultado.error && resultado.reintentable) {
      console.log(`Fallo reintentable con ${modelo}, segundo intento...`);
      await new Promise(resolve => setTimeout(resolve, 800));
      resultado = await llamarGeminiUnaVez(apiKey, promptSistema, contents, maxTokens, modelo);
    }
    if (!resultado.error) break;
    if (!resultado.modeloNoExiste) break; // otro tipo de fallo: cambiar de modelo no ayuda
    console.warn(`El modelo ${modelo} no existe o no está disponible, probando el siguiente.`);
  }

  if (resultado.error) {
    try { await seg.redisCmd(['DECR', claveCuota]); usados--; } catch (e) {} // un fallo nuestro no gasta tu cuota
    return res.status(502).json({
      error: 'El asistente no ha podido responder ahora mismo, ni siquiera tras reintentarlo. Prueba de nuevo en unos segundos, o usa el chat con base de conocimiento propia mientras tanto.'
    });
  }

  const respuestaGemini = resultado.texto;
  let fuentesUsadas = [];
  let textoFinal = respuestaGemini;
  const matchFuentes = respuestaGemini.match(/FUENTES_USADAS:\s*(.+)$/im);
  if (matchFuentes) {
    fuentesUsadas = matchFuentes[1].split(';').map(f => f.trim()).filter(Boolean);
    textoFinal = respuestaGemini.replace(/FUENTES_USADAS:.+$/im, '').trim();
  }

  return res.status(200).json({
    respuesta: textoFinal,
    fuentes: fuentesUsadas,
    fechaRespuesta: new Date().toISOString(),
    uso: uso(),
    aviso: 'Esta respuesta es una orientación basada en la información disponible y no sustituye una valoración profesional.'
  });
};

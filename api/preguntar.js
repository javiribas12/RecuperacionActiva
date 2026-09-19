// api/preguntar.js
// Ruta backend privada para "Pregunta y respuesta" de Recuperación Activa.
// Se despliega en Vercel como función serverless. La clave de Gemini NUNCA
// llega al navegador: solo vive aquí, en el servidor, leída de la variable
// de entorno GEMINI_API_KEY.

const GEMINI_MODEL = 'gemini-3.5-flash-lite';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

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
  'ChoosePT (choosept.com)'
];

function construirPromptSistema(contexto) {
  const {
    edad, objetivo, deporte, intensidad, fase, resultadoCuestionario
  } = contexto || {};

  return `Eres el asistente de "Recuperación Activa", una web de fisioterapia y entrenamiento personal.

REGLAS OBLIGATORIAS:
- Nunca afirmes un diagnóstico definitivo. Usa expresiones como "podría ser compatible con..." o "esto sugiere, sin confirmarlo...".
- Indica siempre cuándo hace falta una valoración profesional presencial.
- Para preguntas de fisioterapia, salud o entrenamiento, basa tus respuestas en evidencia de estas fuentes aprobadas: ${FUENTES_APROBADAS.join(', ')}.
- Tienes acceso a búsqueda en Google en tiempo real (grounding). Úsala sin dudarlo para cualquier pregunta que dependa de datos actuales o cambiantes — el tiempo que hace, precios, noticias del día, resultados deportivos, fechas de eventos, o cualquier otra cosa que tu conocimiento de entrenamiento no pueda saber por sí solo. No te niegues a responder este tipo de preguntas: son perfectamente válidas aunque no sean de fisioterapia.
- Para preguntas que sí sean de fisioterapia o salud, Google solo sirve para localizar información, nunca como fuente final citada — cita la fuente médica aprobada correspondiente.
- No repitas literalmente el contenido de respuestas anteriores de esta conversación; si el usuario pide "más información", aporta algo nuevo (otro ejemplo, otra progresión, otra fuente).
- Responde en español, de forma directa y breve primero, y desarrolla solo si aporta valor.
- Si te faltan datos para responder con seguridad, dilo y haz una única pregunta concreta para afinar.

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

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

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
    usuarioId
  } = req.body || {};

  if (!pregunta || typeof pregunta !== 'string' || !pregunta.trim()) {
    return res.status(400).json({ error: 'Falta el campo "pregunta".' });
  }

  const idParaLimite = usuarioId || req.headers['x-forwarded-for'] || 'anonimo';
  if (excedeLimite(idParaLimite)) {
    return res.status(429).json({
      error: `Has hecho demasiadas preguntas en poco tiempo (límite: ${LIMITE_CONSULTAS_POR_HORA} por hora). Espera un poco antes de volver a preguntar.`
    });
  }

  const contents = [];
  if (Array.isArray(historial)) {
    historial.slice(-10).forEach(turno => {
      contents.push({
        role: turno.rol === 'asistente' ? 'model' : 'user',
        parts: [{ text: turno.texto || '' }]
      });
    });
  }
  contents.push({ role: 'user', parts: [{ text: pregunta }] });

  const promptSistema = construirPromptSistema({ edad, objetivo, deporte, intensidad, fase, resultadoCuestionario });

  let respuestaGemini;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const r = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        system_instruction: { parts: [{ text: promptSistema }] },
        contents,
        tools: [{ google_search: {} }],
        generationConfig: {
          temperature: 0.4,
          maxOutputTokens: 700
        }
      })
    });
    clearTimeout(timeout);

    if (!r.ok) {
      const textoError = await r.text().catch(() => '');
      console.error('Error de la API de Gemini:', r.status, textoError);
      return res.status(502).json({
        error: 'El asistente no ha podido responder ahora mismo. Prueba de nuevo en unos segundos, o usa el chat con base de conocimiento propia mientras tanto.'
      });
    }

    const data = await r.json();
    respuestaGemini = data?.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
    if (!respuestaGemini) {
      throw new Error('Respuesta vacía de Gemini');
    }
  } catch (err) {
    const esTimeout = err.name === 'AbortError';
    console.error('Fallo llamando a Gemini:', err);
    return res.status(502).json({
      error: esTimeout
        ? 'El asistente ha tardado demasiado en responder. Inténtalo de nuevo.'
        : 'El asistente no está disponible ahora mismo. Inténtalo de nuevo en un momento.'
    });
  }

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
    aviso: 'Esta respuesta es una orientación basada en la información disponible y no sustituye una valoración profesional.'
  });
};

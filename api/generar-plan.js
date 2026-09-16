// api/generar-plan.js
// Ruta backend privada que genera con Gemini el resultado de los cuestionarios
// de fisioterapia, entrenamiento personal, readaptación, consejos generales
// y la propuesta de entreno por deporte. Comparte las mismas reglas de
// seguridad que api/preguntar.js: la clave vive solo en GEMINI_API_KEY,
// nunca en el navegador.

const GEMINI_MODEL = 'gemini-2.0-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const FUENTES_APROBADAS = [
  'PubMed (pubmed.ncbi.nlm.nih.gov)', 'PEDro (pedro.org.au)', 'Cochrane Library (cochranelibrary.com)',
  'JOSPT Clinical Practice Guidelines (jospt.org)', 'NICE (nice.org.uk)', 'GuíaSalud (guiasalud.es)',
  'British Journal of Sports Medicine (bjsm.bmj.com)', 'ACSM (acsm.org)', 'World Physiotherapy (world.physio)'
];

const LIMITE_POR_HORA = 15;
const ventana = new Map();
function excedeLimite(id) {
  const ahora = Date.now(), hora = 60 * 60 * 1000;
  const h = (ventana.get(id) || []).filter(t => ahora - t < hora);
  if (h.length >= LIMITE_POR_HORA) { ventana.set(id, h); return true; }
  h.push(ahora); ventana.set(id, h); return false;
}

const ESQUEMAS = {
  fisioterapia: `{
  "orientacionInicial": "string",
  "hipotesisPrincipal": "string",
  "hipotesisAlternativas": ["string", "string"],
  "porQueEncaja": "string",
  "nivelPrioridad": "autocuidado inicial | valoración profesional recomendable | atención prioritaria",
  "senalesAlarma": ["string"],
  "consejosInmediatos": ["string"],
  "solucionInicial": "string",
  "siguientePaso": "string"
}`,
  entrenamiento: `{
  "objetivoDetectado": "string",
  "nivel": "string",
  "deporteEIntensidad": "string",
  "espacioDeEntreno": "string",
  "material": "string",
  "diasDisponibles": "string",
  "dificultadRecomendada": "Inicial | Intermedia | Avanzada",
  "planPersonalizado": "string describiendo la sesión",
  "porQueCadaEjercicio": "string",
  "progresionSemanal": "string"
}`,
  readaptacion: `{
  "faseActual": "string",
  "objetivoDeLaFase": "string",
  "ejerciciosAdaptados": ["string"],
  "queSeTrabaja": "string",
  "criteriosParaProgresar": ["string"],
  "alternativasSiDolorOFatiga": "string"
}`,
  consejos: `{
  "recomendaciones": ["string", "string", "string"],
  "fuerza": "string",
  "movilidad": "string",
  "rendimiento": "string",
  "calentamiento": "string",
  "estiramientos": "string",
  "descanso": "string",
  "prevencion": "string",
  "recuperacion": "string"
}`,
  deporte: `{
  "deporte": "string",
  "objetivoDeportivo": "string",
  "nivelEIntensidad": "string",
  "diaDeLaSemana": "string",
  "faseDeEntrenamiento": "string",
  "capacidadDeHoy": "string",
  "calentamientoExplicado": "string",
  "bloques": [{"nombre":"string","detalle":"string","porQue":"string"}],
  "progresionSemanal": "string",
  "consejoRecuperacion": "string"
}`
};

function construirPrompt(tipo, respuestas) {
  const esquema = ESQUEMAS[tipo];
  return `Eres el motor de análisis de "Recuperación Activa" (fisioterapia y entrenamiento personal).
Vas a generar el resultado de tipo "${tipo}" a partir de las respuestas de un cuestionario.

REGLAS OBLIGATORIAS:
- Nunca afirmes un diagnóstico definitivo. Usa "podría ser compatible con...", nunca "tienes...".
- Basa el contenido en evidencia de: ${FUENTES_APROBADAS.join(', ')}. Google/Google Scholar solo para localizar, nunca como fuente final.
- Si faltan datos relevantes en las respuestas, dilo dentro del campo correspondiente en vez de inventar.
- Responde en español.
- Indica siempre cuándo hace falta valoración profesional presencial si el tipo es "fisioterapia" o "readaptacion".

RESPUESTAS DEL CUESTIONARIO (JSON):
${JSON.stringify(respuestas)}

Devuelve ÚNICAMENTE un JSON válido, sin texto antes ni después, con esta forma exacta:
${esquema}`;
}

async function llamarGemini(apiKey, promptTexto) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 20000);
  try {
    const r = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: promptTexto }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 1200, responseMimeType: 'application/json' },
        tools: [{ google_search: {} }]
      })
    });
    clearTimeout(timeoutId);
    if (!r.ok) return { error: `Gemini respondió con estado ${r.status}` };
    const data = await r.json();
    const texto = data?.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
    if (!texto) return { error: 'Respuesta vacía de Gemini' };
    let json;
    try { json = JSON.parse(texto); }
    catch (e) { return { error: 'Gemini no devolvió un JSON válido' }; }
    return { json };
  } catch (err) {
    clearTimeout(timeoutId);
    return { error: err.name === 'AbortError' ? 'Gemini tardó demasiado en responder' : 'No se pudo contactar con Gemini' };
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido. Usa POST.' });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('Falta GEMINI_API_KEY en el servidor.');
    return res.status(500).json({ error: 'El generador con IA no está disponible ahora mismo.' });
  }

  const { tipo, respuestas, usuarioId } = req.body || {};
  if (!tipo || !ESQUEMAS[tipo]) {
    return res.status(400).json({ error: `Campo "tipo" inválido. Debe ser uno de: ${Object.keys(ESQUEMAS).join(', ')}` });
  }
  if (!respuestas || typeof respuestas !== 'object') {
    return res.status(400).json({ error: 'Falta el campo "respuestas" con los datos del cuestionario.' });
  }

  const idLimite = usuarioId || req.headers['x-forwarded-for'] || 'anonimo';
  if (excedeLimite(idLimite)) {
    return res.status(429).json({ error: 'Demasiadas generaciones en poco tiempo. Espera unos minutos.' });
  }

  const prompt = construirPrompt(tipo, respuestas);
  const { json, error } = await llamarGemini(apiKey, prompt);
  if (error) {
    console.error('Error generando plan con Gemini:', tipo, error);
    return res.status(502).json({ error });
  }

  return res.status(200).json({
    tipo,
    resultado: json,
    fuentes: FUENTES_APROBADAS,
    fechaGeneracion: new Date().toISOString(),
    aviso: 'Esta orientación se basa en tus respuestas y no sustituye una valoración profesional.'
  });
}

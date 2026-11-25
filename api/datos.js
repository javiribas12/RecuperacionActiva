// api/datos.js — un solo punto de entrada que reparte a varios módulos (límite de 12 funciones de Vercel Hobby).
const rutas = {
  'progreso': require('../lib/progreso'),
  'entrenos': require('../lib/entrenos'),
};
module.exports = async function handler(req, res) {
  const k = String((req.query && req.query.m) || '');
  const h = Object.prototype.hasOwnProperty.call(rutas, k) ? rutas[k] : null;
  if (!h) return res.status(404).json({ error: 'No encontrado' });
  return h(req, res);
};

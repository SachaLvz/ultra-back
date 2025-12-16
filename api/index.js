// Handler Vercel Serverless Function
// Importe et exporte l'application Express

import app from '../server.js'

// Vercel Serverless Functions
// Express app est déjà configuré pour gérer les requêtes
// Le middleware d'erreur dans server.js capture les erreurs non gérées
export default app

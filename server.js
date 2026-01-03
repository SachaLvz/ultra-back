import express from 'express'
import cors from 'cors'
import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'

// Charger dotenv seulement si on n'est pas sur Vercel
// Render et autres plateformes nécessitent dotenv
if (!process.env.VERCEL && !process.env.VERCEL_ENV) {
  dotenv.config()
}

const app = express()

// Configuration Supabase
const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

// Sur Vercel, on ne peut pas utiliser process.exit(), donc on vérifie lors de la première requête
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('⚠️  SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY doivent être configurés dans .env')
  // Ne pas faire process.exit() sur Vercel, l'erreur sera retournée lors de la première requête
  if (!process.env.VERCEL && !process.env.VERCEL_ENV) {
    process.exit(1)
  }
}

// Configuration Email (Resend)
const RESEND_API_KEY = process.env.RESEND_API_KEY
const APP_URL = process.env.APP_URL || 'https://ultra-copy.vercel.app'
const FROM_EMAIL = process.env.FROM_EMAIL || 'onboarding@app-ultra.com'
const RESEND_TEST_EMAIL = process.env.RESEND_TEST_EMAIL

// Configuration OpenAI
const OPENAI_API_KEY = process.env.OPENAI_API_KEY

// Créer le client Supabase seulement si les variables sont définies
let supabase = null
if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  })

  // Vérifier la configuration Supabase au démarrage
  if (SUPABASE_SERVICE_ROLE_KEY) {
    // Vérifier que ce n'est pas l'anon key (qui commence généralement par "eyJ")
    if (SUPABASE_SERVICE_ROLE_KEY.startsWith('eyJ') && SUPABASE_SERVICE_ROLE_KEY.length < 200) {
      console.warn('⚠️  ATTENTION: La clé fournie semble être une clé anon, pas une service_role key')
      console.warn('⚠️  La service_role key est beaucoup plus longue et commence généralement par "eyJ" mais fait plus de 200 caractères')
    }
    
    // Vérifier la longueur minimale (les service_role keys sont généralement très longues)
    if (SUPABASE_SERVICE_ROLE_KEY.length < 100) {
      console.warn('⚠️  ATTENTION: La clé semble trop courte pour être une service_role key valide')
    }
  }
}

app.use(cors())
app.use(express.json({ limit: '50mb' }))

// Gestionnaire d'erreur global pour éviter les crashes
app.use((err, req, res, next) => {
  console.error('❌ Erreur non gérée:', err)
  res.status(500).json({
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'production' ? 'An error occurred' : err.message
  })
})

// Gestionnaire pour les promesses non gérées
process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason)
})

process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error)
  // Ne pas faire process.exit() sur Vercel
  if (!process.env.VERCEL && !process.env.VERCEL_ENV) {
    process.exit(1)
  }
})

// 🔐 AUTH MIDDLEWARE
app.use((req, res, next) => {
  // Autoriser le healthcheck
  if (req.method === 'GET' && req.path === '/') {
    return next()
  }

  // Nettoyer la valeur de l'en-tête pour éviter les caractères invalides
  const apiKey = req.headers['x-api-key']?.trim()

  if (!apiKey) {
    return res.status(401).json({
      error: 'Missing X-API-KEY header'
    })
  }

  // Essayer X_API_KEY puis API_KEY (supporter les deux formats)
  const expectedApiKey = (process.env.X_API_KEY || process.env.API_KEY)?.trim()

  if (!expectedApiKey) {
    console.error('⚠️  X_API_KEY or API_KEY not configured in environment variables')
    return res.status(500).json({
      error: 'Server configuration error: X_API_KEY or API_KEY must be set in .env file'
    })
  }

  if (apiKey !== expectedApiKey) {
    return res.status(403).json({
      error: 'Invalid API key'
    })
  }

  next()
})

// Health check
app.get('/', (_req, res) => {
  res.send('API OK')
})

// Interfaces pour les données roadmap
const isRoadmapDataNew = (data) => {
  return 'data' in data && 'plan' in data
}

const isRoadmapDataOld = (data) => {
  return 'validation' in data && '' in data
}

// Fonction pour générer un mot de passe
const generatePassword = () => {
  return Math.random().toString(36).slice(-12) +
         Math.random().toString(36).slice(-12).toUpperCase() +
         '!@#'
}

// Fonction pour parser les valeurs monétaires
const parseCurrency = (value) => {
  if (!value) return null
  const cleaned = value.replace(/[€\s,]/g, '').trim()
  return cleaned ? parseFloat(cleaned) : null
}

// Fonction pour parser les pourcentages
const parsePercentage = (value) => {
  if (!value) return null
  const cleaned = value.replace(/[%\s]/g, '').trim()
  return cleaned ? parseFloat(cleaned) : null
}

// Fonction pour identifier l'action la plus importante et générer un titre très court
const generateWeekTitleWithChatGPT = async (weekActions, weekNumber) => {
  if (!OPENAI_API_KEY) {
    return `Semaine ${weekNumber}`
  }

  try {
    // Extraire toutes les actions de la semaine
    const allActions = weekActions
      .split('\n')
      .filter(a => a.trim() && a.trim().startsWith('-'))
      .map(a => a.replace(/^-\s*/, '').trim())
      .filter(a => a.length > 0)

    if (!allActions || allActions.length === 0) {
      return `Semaine ${weekNumber}`
    }

    const actionsList = allActions.map((action, index) => `${index + 1}. ${action}`).join('\n')

    const prompt = `Parmi les actions suivantes de la semaine ${weekNumber}, identifie l'action LA PLUS IMPORTANTE et crée un titre TRÈS COURT (2-3 mots maximum) qui la résume.

ACTIONS DE LA SEMAINE:
${actionsList}

INSTRUCTIONS:
1. Identifie l'action la plus importante/prioritaire parmi toutes les actions
2. Crée un titre TRÈS COURT (2-3 mots maximum) basé uniquement sur cette action la plus importante
3. Le titre doit être simple, direct et actionnable
4. En français

Exemples de bons titres (2-3 mots):
- "Structurer l'organisation"
- "Lancer le marketing"
- "Recruter l'équipe"
- "Finaliser le tunnel"
- "Optimiser les processus"
- "Développer l'acquisition"

Réponds UNIQUEMENT avec le titre (2-3 mots max), sans guillemets, sans explication, sans numéro.`;

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: 'Tu es un assistant expert qui identifie l\'action la plus importante d\'une semaine et crée un titre court (2-3 mots) basé uniquement sur cette action. Tu réponds UNIQUEMENT avec le titre, sans guillemets, sans explication.',
          },
          {
            role: 'user',
            content: prompt,
          },
        ],
        temperature: 0.3,
        max_tokens: 15,
      }),
    })

    if (!response.ok) {
      return `Semaine ${weekNumber}`
    }

    const data = await response.json()
    let title = data.choices[0]?.message?.content?.trim() || null
    
    if (title) {
      title = title.replace(/^["']|["']$/g, '').trim()
      title = title.substring(0, 80).trim()
    }

    return title || `Semaine ${weekNumber}`
  } catch (error) {
    console.error('⚠️  Erreur lors de la génération du titre de semaine:', error)
    return `Semaine ${weekNumber}`
  }
}

// Fonction pour générer un titre court et clair avec ChatGPT
const generateTaskTitleWithChatGPT = async (actionText) => {
  if (!OPENAI_API_KEY) {
    console.warn('⚠️  OPENAI_API_KEY non configurée, utilisation du titre par défaut')
    return null
  }

  try {
    const prompt = `Tu es un assistant expert en gestion de projet. Ton rôle est de créer un titre court, clair et actionnable à partir d'une action détaillée.

ACTION À RÉSUMER:
${actionText}

RÈGLES STRICTES:
- Le titre DOIT être UNE SEULE PHRASE COURTE (maximum 10-12 mots)
- Le titre DOIT être simple, clair et direct
- Le titre DOIT être actionnable (commence par un verbe d'action)
- JAMAIS de listes à puces dans le titre
- JAMAIS de phrases multiples séparées par des virgules ou "et"
- JAMAIS de titres trop longs ou complexes
- Le titre doit être en français

Exemples de BONS titres:
- "Lancer les campagnes Facebook Ads"
- "Recruter des étudiants pour la salle"
- "Finaliser le tunnel de vente"
- "Mettre en place l'offre lunch"
- "Organiser une réunion d'équipe"

Exemples de MAUVAIS titres:
- "Lancer les campagnes Facebook Ads et Google Ads avec un budget test ciblé localement" (trop long)
- "Recruter des étudiants - salle, bar, runner, plonge" (liste)
- "Finaliser avec Lucas la mise en place du tunnel de vente et lancer les premières campagnes" (plusieurs actions)

Réponds UNIQUEMENT avec le titre, sans guillemets, sans explication, sans texte supplémentaire.`;

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: 'Tu es un assistant expert qui crée des titres courts et clairs pour des tâches. Tu réponds UNIQUEMENT avec le titre, sans guillemets, sans explication.',
          },
          {
            role: 'user',
            content: prompt,
          },
        ],
        temperature: 0.3,
        max_tokens: 50,
      }),
    })

    if (!response.ok) {
      const error = await response.text()
      console.error('⚠️  Erreur OpenAI API pour génération de titre:', error)
      return null
    }

    const data = await response.json()
    let title = data.choices[0]?.message?.content?.trim() || null
    
    // Nettoyer le titre (enlever les guillemets si présents)
    if (title) {
      title = title.replace(/^["']|["']$/g, '').trim()
      // Limiter à 100 caractères pour sécurité
      title = title.substring(0, 100).trim()
    }

    return title
  } catch (error) {
    console.error('⚠️  Erreur lors de la génération du titre avec ChatGPT:', error)
    return null
  }
}

// Fonction pour envoyer un email au client avec ses identifiants
const sendWelcomeEmail = async (clientData, clientPassword, isNewClient, roadmapContent) => {
  if (!RESEND_API_KEY || !clientData.client_email || !clientPassword) {
    if (!RESEND_API_KEY) {
      console.warn('⚠️ RESEND_API_KEY non configurée, email non envoyé au client')
    }
    return
  }

  try {
    // Obtenir l'URL du logo depuis Supabase Storage
    let logoUrl = `${APP_URL}/65edfa277de25bed4baf2e61_LOGO-ULTRA-p-500.png` // Fallback
    
    const possibleConfigs = [
      { bucket: 'public', path: 'logo-ultra.png' },
      { bucket: 'logos', path: 'logo-ultra.png' },
      { bucket: 'assets', path: 'logo-ultra.png' },
      { bucket: 'images', path: 'logo-ultra.png' },
      { bucket: 'public', path: '65edfa277de25bed4baf2e61_LOGO-ULTRA-p-500.png' },
    ]
    
    for (const config of possibleConfigs) {
      try {
        const { data: { publicUrl } } = supabase.storage
          .from(config.bucket)
          .getPublicUrl(config.path)
        
        if (publicUrl) {
          const supabaseDomain = SUPABASE_URL.replace('https://', '').replace('http://', '').split('/')[0]
          if (publicUrl.includes(supabaseDomain) || publicUrl.includes('supabase.co')) {
            try {
              const testResponse = await fetch(publicUrl, { method: 'HEAD' })
              if (testResponse.ok || testResponse.status === 200 || testResponse.status === 304) {
                logoUrl = publicUrl
                break
              }
            } catch {
              logoUrl = publicUrl
              break
            }
          }
        }
      } catch (e) {
        continue
      }
    }

    const emailSubject = 'Bienvenue sur Ultra !'
    
    const emailHtml = `
<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Ultra – Accès à votre espace</title>
</head>
<body style="margin:0;padding:0;background-color:#f5f5f5;">
  <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="padding:40px 0;">
    <tr>
      <td align="center">
        <table width="100%" cellpadding="0" cellspacing="0" role="presentation"
          style="max-width:600px;background:#ffffff;border-radius:20px;
                 box-shadow:0 20px 40px rgba(0,0,0,0.08);overflow:hidden;">
          <tr>
            <td style="padding:24px 24px 16px;text-align:center;">
              <img
                src="${logoUrl}"
                alt="Ultra"
                width="96"
                style="display:block;margin:0 auto;border:0;"
              />
            </td>
          </tr>
          <tr>
            <td style="padding:42px 40px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;color:#111827;">
              <p style="font-size:17px;margin:0 0 18px;">
                Bonjour <strong>${clientData.client_name}</strong>,
              </p>
              ${
                isNewClient
                  ? `<p style="font-size:15px;color:#4b5563;margin:0 0 22px;">
                      Bienvenue sur <strong>Ultra</strong>.  
                      Votre compte a été créé et votre roadmap est prête.
                    </p>`
                  : `<p style="font-size:15px;color:#4b5563;margin:0 0 22px;">
                      Votre roadmap a été importée sur <strong>Ultra</strong>.  
                      Un nouveau mot de passe a été généré.
                    </p>`
              }
              <table width="100%" cellpadding="0" cellspacing="0" role="presentation"
                style="background:#fafafa;border-radius:14px;
                       border:1px solid #eee;margin:28px 0;">
                <tr>
                  <td style="padding:26px 28px;">
                    <div style="font-size:12px;text-transform:uppercase;
                                letter-spacing:.08em;color:#9ca3af;margin-bottom:6px;">
                      Email
                    </div>
                    <div style="font-size:16px;font-weight:600;color:#111827;margin-bottom:16px;">
                      ${clientData.client_email}
                    </div>
                    <div style="font-size:12px;text-transform:uppercase;
                                letter-spacing:.08em;color:#9ca3af;margin-bottom:6px;">
                      Mot de passe
                    </div>
                    <div style="font-size:16px;font-weight:600;color:#111827;word-break:break-all;">
                      ${clientPassword}
                    </div>
                  </td>
                </tr>
              </table>
              <p style="font-size:15px;color:#4b5563;margin:0 0 26px;">
                Connectez-vous pour découvrir votre feuille de route et commencer.
              </p>
              <table width="100%" cellpadding="0" cellspacing="0" role="presentation">
                <tr>
                  <td align="center">
                    <a href="https://www.app-ultra.com/signin"
                       style="display:inline-block;
                              background:linear-gradient(135deg,#ff9502,#ff7a00);
                              color:#ffffff;text-decoration:none;
                              padding:15px 42px;
                              border-radius:999px;
                              font-size:16px;
                              font-weight:600;">
                      Accéder à mon espace
                    </a>
                  </td>
                </tr>
              </table>
              <div style="margin-top:34px;
                          padding:18px 20px;
                          border-radius:12px;
                          background:#fff7ed;
                          color:#7c2d12;
                          font-size:14px;">
                🔐 <strong>Sécurité :</strong>  
                Nous vous recommandons de modifier votre mot de passe lors de votre première connexion.
              </div>
            </td>
          </tr>
          <tr>
            <td style="padding:26px 24px;text-align:center;
                       font-size:12px;color:#9ca3af;
                       border-top:1px solid #eee;">
              Email automatique • Merci de ne pas répondre
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
`

    const emailText = `
Bonjour ${clientData.client_name},

${isNewClient ? 'Bienvenue sur Ultra ! Votre compte a été créé avec succès et votre roadmap a été importée. Voici vos identifiants de connexion :' : 'Votre roadmap a été importée avec succès sur Ultra. Un nouveau mot de passe a été généré pour votre compte. Voici vos identifiants de connexion :'}

Email : ${clientData.client_email}
Mot de passe : ${clientPassword}

Vous pouvez maintenant vous connecter à votre compte en utilisant ces identifiants.
Lien de connexion : ${APP_URL}/login

⚠️ Important : Pour des raisons de sécurité, nous vous recommandons de changer votre mot de passe après votre première connexion.

Cet email a été envoyé automatiquement. Merci de ne pas y répondre.
    `

    let recipientEmail = clientData.client_email
    let useTestEmail = false

    // Essayer d'envoyer à l'email réel
    let resendResponse = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${RESEND_API_KEY}`
      },
      body: JSON.stringify({
        from: FROM_EMAIL,
        to: [clientData.client_email],
        subject: emailSubject,
        html: emailHtml,
        text: emailText,
      })
    })

    // Si l'envoi échoue avec une erreur de domaine non vérifié et qu'on a un email de test, utiliser le fallback
    if (!resendResponse.ok) {
      const resendErrorText = await resendResponse.text()
      let resendError
      try {
        resendError = JSON.parse(resendErrorText)
      } catch {
        resendError = { message: resendErrorText }
      }
      
      const isDomainError = resendError.message?.includes('verify a domain') || 
                           resendError.statusCode === 403 ||
                           resendError.message?.includes('testing emails')
      
      if (isDomainError && RESEND_TEST_EMAIL) {
        console.warn(`⚠️ Impossible d'envoyer à ${clientData.client_email} (domaine non vérifié). Utilisation de l'email de test: ${RESEND_TEST_EMAIL}`)
        
        const testNoteHtml = `<p style="background-color: #fef3c7; padding: 10px; border-radius: 4px; margin: 10px 0;"><strong>⚠️ MODE TEST:</strong> Cet email devrait être envoyé à ${clientData.client_email}</p>`
        const modifiedEmailHtml = emailHtml.replace(
          '<p>Bonjour',
          `<p>Bonjour${testNoteHtml}`
        )
        const modifiedEmailText = `⚠️ MODE TEST: Cet email devrait être envoyé à ${clientData.client_email}\n\n${emailText}`
        
        recipientEmail = RESEND_TEST_EMAIL
        useTestEmail = true
        
        resendResponse = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${RESEND_API_KEY}`
          },
          body: JSON.stringify({
            from: FROM_EMAIL,
            to: [RESEND_TEST_EMAIL],
            subject: emailSubject,
            html: modifiedEmailHtml,
            text: modifiedEmailText,
          })
        })
      } else {
        console.error('⚠️ Erreur lors de l\'envoi de l\'email via Resend:', resendError)
      }
    }

    if (resendResponse.ok) {
      if (useTestEmail) {
        console.warn(`⚠️ Email envoyé en mode test à ${RESEND_TEST_EMAIL} au lieu de ${clientData.client_email}.`)
      } else {
        console.log(`✅ Email envoyé avec succès à ${clientData.client_email}`)
      }
    } else {
      const resendErrorText = await resendResponse.text()
      let resendError
      try {
        resendError = JSON.parse(resendErrorText)
      } catch {
        resendError = { message: resendErrorText }
      }
      console.error('⚠️ Erreur lors de l\'envoi de l\'email via Resend:', resendError)
    }
  } catch (emailError) {
    console.error('⚠️ Erreur lors de l\'envoi de l\'email:', emailError)
    // Ne pas faire échouer l'import si l'email échoue
  }
}

// Endpoint pour ajouter une roadmap
app.post('/add-roadmap', async (req, res) => {
  try {
    // Vérifier la configuration Supabase au début de la requête (pour Vercel)
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !supabase) {
      return res.status(500).json({
        error: 'Server configuration error',
        details: 'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be configured in environment variables'
      })
    }

    console.log('📨 Requête reçue:', req.method, req.url)
    console.log('📋 Body reçu:', JSON.stringify(req.body).substring(0, 200))

    // Parser le body - peut être un tableau ou un objet
    const body = req.body
    let data
    
    // Support des deux formats : nouveau format (objet unique) ou ancien format (tableau)
    if (Array.isArray(body)) {
      data = body[0]
    } else if (body.data && body.plan) {
      // Nouveau format avec data et plan
      data = body
    } else if (body.roadmap_data) {
      data = body.roadmap_data
    } else {
      data = body
    }

    // Détecter le format et normaliser les données
    const isNewFormat = isRoadmapDataNew(data)
    const isOldFormat = isRoadmapDataOld(data)

    if (!isNewFormat && !isOldFormat) {
      return res.status(400).json({
        error: 'Invalid data format. Expected format with data/plan or validation/""'
      })
    }

    // Normaliser les données selon le format
    let roadmapContent
    let clientData = {
      client_id: null,
      client_name: '',
      client_email: '',
      client_phone: null
    }
    let coachInfo = {
      coach_name: null,
      coach_email: null,
      coach_phone: null
    }

    if (isNewFormat) {
      // Nouveau format : data.plan
      roadmapContent = data.plan
      clientData = {
        client_id: data.data.client_id || null,
        client_name: data.data.client_name || '',
        client_email: data.data.client_email || '',
        client_phone: data.data.client_phone || null
      }
      coachInfo = {
        coach_name: data.data.coach_name || null,
        coach_email: data.data.coach_email || null,
        coach_phone: data.data.coach_phone || null
      }
    } else {
      // Ancien format : validation et ''
      roadmapContent = data['']
      clientData = {
        client_id: data.validation?.client_id || null,
        client_name: roadmapContent?.header?.client_name || roadmapContent?.header?.company_name || '',
        client_email: roadmapContent?.header?.email || '',
        client_phone: null
      }
    }

    // Utiliser les données du header si les données client ne sont pas dans data
    if (!clientData.client_name && roadmapContent?.header) {
      clientData.client_name = roadmapContent.header.client_name || roadmapContent.header.company_name
    }
    if (!clientData.client_email && roadmapContent?.header?.email) {
      clientData.client_email = roadmapContent.header.email
    }
    
    // Générer un email si manquant
    if (!clientData.client_email && clientData.client_name) {
      clientData.client_email = `${clientData.client_name.toLowerCase().replace(/\s+/g, '.')}@client.temp`
    }

    // Chercher l'email du coach dans plusieurs endroits possibles
    let coachEmail = coachInfo.coach_email || 
                     body.coach_email || 
                     body.data?.coach_email || 
                     data.data?.coach_email ||
                     roadmapContent?.header?.coach_email ||
                     null

    // Log pour déboguer l'extraction de l'email du coach
    console.log('📧 Extraction email coach:', {
      'coachInfo.coach_email': coachInfo.coach_email,
      'body.coach_email': body.coach_email,
      'body.data?.coach_email': body.data?.coach_email,
      'data.data?.coach_email': data.data?.coach_email,
      'roadmapContent?.header?.coach_email': roadmapContent?.header?.coach_email,
      'coachEmail final': coachEmail
    })

    // Utiliser aussi le nom du coach depuis plusieurs sources
    if (!coachInfo.coach_name) {
      coachInfo.coach_name = body.coach_name || 
                            body.data?.coach_name || 
                            data.data?.coach_name ||
                            roadmapContent?.header?.coach_name ||
                            null
    }

    if (!clientData.client_name) {
      return res.status(400).json({
        error: 'client_name or company_name is required'
      })
    }

    if (!clientData.client_email) {
      return res.status(400).json({
        error: 'client_email is required'
      })
    }

    // Trouver le coach (optionnel)
    let coachId = null

    // Chercher d'abord par email si un coach_email est fourni
    if (coachEmail) {
      console.log(`🔍 Recherche du coach par email: ${coachEmail}`)
      
      // D'abord chercher avec le filtre de rôle 'coach'
      let { data: existingCoach, error: coachError } = await supabase
        .from('profiles')
        .select('id, email, role')
        .eq('email', coachEmail)
        .eq('role', 'coach')
        .maybeSingle()

      if (coachError) {
        console.log(`⚠️  Erreur lors de la recherche du coach par email:`, coachError.message)
      }

      if (existingCoach && existingCoach.role === 'coach') {
        coachId = existingCoach.id
        console.log(`✅ Coach trouvé par email: ${coachId}`)
      } else {
        // Si aucun coach trouvé, vérifier si l'utilisateur existe avec un autre rôle
        const { data: userExists } = await supabase
          .from('profiles')
          .select('id, email, role')
          .eq('email', coachEmail)
          .maybeSingle()
        
        if (userExists) {
          console.log(`⚠️  Utilisateur trouvé avec l'email ${coachEmail} mais le rôle est '${userExists.role}' au lieu de 'coach'`)
        } else {
          console.log(`⚠️  Aucun utilisateur trouvé avec l'email: ${coachEmail}`)
        }
      }
    } else {
      console.log('ℹ️  Aucun email de coach fourni dans les données')
    }

    // Si aucun coach n'a été trouvé par email, chercher par ID comme fallback
    if (!coachId) {
      const providedCoachId = body.coach_id || null
      if (providedCoachId) {
        console.log(`🔍 Recherche du coach par ID: ${providedCoachId}`)
        const { data: coachProfile, error: coachIdError } = await supabase
          .from('profiles')
          .select('id, email, role')
          .eq('id', providedCoachId)
          .maybeSingle()
        
        if (coachIdError) {
          console.log(`⚠️  Erreur lors de la recherche du coach par ID:`, coachIdError.message)
        }

        if (coachProfile) {
          // Vérifier que le profil a bien le rôle 'coach'
          if (coachProfile.role === 'coach') {
            coachId = providedCoachId
            console.log(`✅ Coach trouvé par ID: ${coachId}`)
          } else {
            console.log(`⚠️  Utilisateur trouvé avec l'ID ${providedCoachId} mais le rôle est '${coachProfile.role}' au lieu de 'coach'`)
          }
        } else {
          console.log(`⚠️  Aucun utilisateur trouvé avec l'ID: ${providedCoachId}`)
        }
      }
    }

    // Si aucun coach n'est trouvé, on continue sans coach (coachId reste null)
    if (!coachId && coachEmail) {
      console.log(`⚠️  Email de coach fourni (${coachEmail}) mais aucun coach trouvé dans la base de données`)
    }

    // Vérifier si le client existe déjà
    let clientProfileId = null
    
    if (clientData.client_id) {
      const { data: existingClient } = await supabase
        .from('profiles')
        .select('id')
        .eq('id', clientData.client_id)
        .single()
      
      if (existingClient) {
        clientProfileId = existingClient.id
      }
    }

    // Si le client_id n'existe pas, chercher par email
    if (!clientProfileId) {
      const { data: existingClientByEmail } = await supabase
        .from('profiles')
        .select('id')
        .eq('email', clientData.client_email)
        .single()

      if (existingClientByEmail) {
        clientProfileId = existingClientByEmail.id
      }
    }

    let clientPassword = null
    let isNewClient = false

    if (!clientProfileId) {
      // Créer un nouveau client
      isNewClient = true
      clientPassword = generatePassword()

      // Vérifier que la service role key est bien configurée
      if (!SUPABASE_SERVICE_ROLE_KEY || SUPABASE_SERVICE_ROLE_KEY.length < 20) {
        console.error('⚠️  SUPABASE_SERVICE_ROLE_KEY semble invalide ou manquante')
        return res.status(500).json({
          error: 'Server configuration error: SUPABASE_SERVICE_ROLE_KEY is invalid or missing',
          hint: 'Make sure you are using the service_role key (not the anon key) from your Supabase project settings'
        })
      }

      console.log(`📝 Tentative de création d'utilisateur pour: ${clientData.client_email}`)
      
      // Créer l'utilisateur dans auth
      const { data: authData, error: createUserError } = await supabase.auth.admin.createUser({
        email: clientData.client_email,
        password: clientPassword,
        email_confirm: true
      })

      if (createUserError) {
        console.error('❌ Erreur lors de la création de l\'utilisateur:', {
          message: createUserError.message,
          status: createUserError.status,
          name: createUserError.name
        })
        
        // Vérifier si c'est une erreur d'authentification
        if (createUserError.status === 401) {
          return res.status(500).json({
            error: 'Authentication error with Supabase',
            details: 'The SUPABASE_SERVICE_ROLE_KEY is invalid or does not have admin permissions',
            hint: 'Please verify that you are using the service_role key (not anon key) from Supabase Project Settings > API'
          })
        }
        
        return res.status(500).json({
          error: 'Failed to create user',
          details: {
            message: createUserError.message,
            status: createUserError.status,
            name: createUserError.name
          }
        })
      }

      if (!authData || !authData.user) {
        console.error('❌ Aucun utilisateur retourné après création')
        return res.status(500).json({
          error: 'Failed to create user: no user data returned'
        })
      }

      console.log(`✅ Utilisateur créé avec succès: ${authData.user.id}`)

      // Attendre un peu pour que le trigger de la base de données crée le profil
      await new Promise(resolve => setTimeout(resolve, 1000))

      // Créer le profil
      const { data: newProfile, error: profileError } = await supabase
        .from('profiles')
        .upsert({
          user_id: authData.user.id,
          email: clientData.client_email,
          full_name: clientData.client_name,
          phone: clientData.client_phone || null,
          company: roadmapContent?.header?.company_name || null,
          location: roadmapContent?.header?.address || null,
          role: 'user',
          category: 1
        }, { onConflict: 'user_id' })
        .select('id')
        .single()

      if (profileError || !newProfile) {
        return res.status(500).json({
          error: 'Failed to create profile',
          details: profileError
        })
      }

      clientProfileId = newProfile.id
    } else {
      // Client existant : générer un nouveau mot de passe et le mettre à jour
      clientPassword = generatePassword()
      
      const { data: existingProfile } = await supabase
        .from('profiles')
        .select('user_id')
        .eq('id', clientProfileId)
        .single()

      if (existingProfile?.user_id) {
        const { error: updatePasswordError } = await supabase.auth.admin.updateUserById(
          existingProfile.user_id,
          { password: clientPassword }
        )

        if (updatePasswordError) {
          console.error('⚠️ Erreur lors de la mise à jour du mot de passe:', updatePasswordError)
        } else {
          console.log('✅ Mot de passe mis à jour pour le client existant')
        }
      }

      // Mettre à jour le profil existant
      const updateData = {}
      if (clientData.client_name) updateData.full_name = clientData.client_name
      if (clientData.client_phone) updateData.phone = clientData.client_phone
      if (roadmapContent?.header?.company_name) updateData.company = roadmapContent.header.company_name
      if (roadmapContent?.header?.address) updateData.location = roadmapContent.header.address

      if (Object.keys(updateData).length > 0) {
        await supabase
          .from('profiles')
          .update(updateData)
          .eq('id', clientProfileId)
      }
    }

    // Créer la relation coach-client uniquement si un coach est fourni
    let coachClientId = null
    
    // Extraire company_presentation depuis le JSON
    const companyPresentation = roadmapContent?.header?.company_presentation || null
    
    if (coachId) {
      const { data: existingRelations } = await supabase
        .from('coach_clients')
        .select('id')
        .eq('coach_id', coachId)
        .eq('client_id', clientProfileId)
        .eq('status', 'active')
        .limit(1)

      if (existingRelations && existingRelations.length > 0) {
        coachClientId = existingRelations[0].id
        
        // Mettre à jour company_presentation si la relation existe déjà
        if (companyPresentation) {
          const { error: updateError } = await supabase
            .from('coach_clients')
            .update({ company_presentation: companyPresentation })
            .eq('id', coachClientId)
          
          if (updateError) {
            console.error('⚠️ Erreur lors de la mise à jour de company_presentation:', updateError)
          } else {
            console.log('✅ company_presentation mis à jour pour la relation coach-client existante')
          }
        }
      } else {
        // Créer la relation coach-client
        const relationData = {
          coach_id: coachId,
          client_id: clientProfileId,
          status: 'active',
          program_start_date: new Date().toISOString().split('T')[0],
          total_weeks: 16,
          current_week: 1
        }
        
        // Ajouter company_presentation si présent
        if (companyPresentation) {
          relationData.company_presentation = companyPresentation
        }
        
        const { data: newRelation, error: relationError } = await supabase
          .from('coach_clients')
          .insert(relationData)
          .select('id')
          .single()

        if (relationError || !newRelation) {
          return res.status(500).json({
            error: 'Failed to create coach-client relation',
            details: relationError
          })
        }

        coachClientId = newRelation.id
      }
    } else {
      if (coachEmail) {
        console.log(`⚠️  Email de coach fourni (${coachEmail}) mais aucun coach trouvé dans la base de données. La relation coach-client ne sera pas créée.`)
      } else {
        console.log('⚠️  Aucun coach fourni, la relation coach-client ne sera pas créée')
      }
    }

    // 1. Créer/Mettre à jour les piliers stratégiques (uniquement si coachClientId existe)
    if (coachClientId && roadmapContent?.vision) {
      // Fonction helper pour nettoyer et formater les actions en tableau JSONB
      const formatActions = (actionsString) => {
        if (!actionsString) return []
        return actionsString
          .split('\n')
          .map(a => a.trim())
          .filter(a => a.length > 0)
          .map(a => a.startsWith('-') ? a.substring(1).trim() : a)
          .filter(a => a.length > 0)
      }

      const pillars = [
        {
          pillar_type: 'operations',
          title: 'Structure & Opérations',
          problem: roadmapContent.vision.structure?.current_situation || '',
          actions: formatActions(roadmapContent.vision.structure?.actions),
          expert_tip: roadmapContent.vision.structure?.expert_suggestion || 'Aucune suggestion'
        },
        {
          pillar_type: 'acquisition',
          title: 'Acquisition & Vente',
          problem: roadmapContent.vision.acquisition?.current_situation || '',
          actions: formatActions(roadmapContent.vision.acquisition?.actions),
          expert_tip: roadmapContent.vision.acquisition?.expert_suggestion || 'Aucune suggestion'
        },
        {
          pillar_type: 'vision',
          title: 'Vision & Pilotage',
          problem: roadmapContent.vision.vision_pilotage?.current_situation || '',
          actions: formatActions(roadmapContent.vision.vision_pilotage?.actions),
          expert_tip: roadmapContent.vision.vision_pilotage?.expert_suggestion || 'Aucune suggestion'
        }
      ]

      for (const pillar of pillars) {
        // S'assurer que les valeurs ne sont pas null pour les champs requis
        const pillarData = {
          coach_client_id: coachClientId,
          pillar_type: pillar.pillar_type,
          title: pillar.title || 'Pilier stratégique',
          problem: pillar.problem || '',
          actions: Array.isArray(pillar.actions) ? pillar.actions : [],
          expert_tip: pillar.expert_tip || 'Aucune suggestion',
          updated_at: new Date().toISOString()
        }

        const { error: pillarError } = await supabase
          .from('roadmap_strategic_pillars')
          .upsert(pillarData, {
            onConflict: 'coach_client_id,pillar_type'
          })

        if (pillarError) {
          console.error(`Error upserting pillar ${pillar.pillar_type}:`, pillarError)
        } else {
          console.log(`✅ Pilier stratégique créé/mis à jour: ${pillar.pillar_type} (${pillar.actions.length} actions)`)
        }

        // Créer des tâches à partir des actions du pilier (uniquement si coachId existe)
        if (coachId && pillar.actions && pillar.actions.length > 0) {
          // Répartir les actions sur les 16 semaines de manière équilibrée
          const actionsPerWeek = Math.ceil(pillar.actions.length / 16)
          
          for (let i = 0; i < pillar.actions.length; i++) {
            const action = pillar.actions[i]
            if (!action || typeof action !== 'string') continue
            
            let actionText = action.trim()
            if (!actionText) continue
            
            // Calculer la semaine (1-16) en répartissant équitablement
            const weekNumber = Math.min(16, Math.max(1, Math.floor(i / actionsPerWeek) + 1))
            
            // Générer un titre avec ChatGPT
            let taskTitle = await generateTaskTitleWithChatGPT(actionText)
            
            // Fallback si ChatGPT échoue : utiliser la première phrase ou limiter
            if (!taskTitle) {
              taskTitle = actionText
              // Si l'action contient plusieurs phrases, prendre seulement la première
              const firstSentence = actionText.split(/[.!?]\s+/)[0].trim()
              if (firstSentence.length > 0 && firstSentence.length < actionText.length * 0.8) {
                taskTitle = firstSentence
              }
              
              // Limiter à 12 mots maximum
              const words = taskTitle.split(/\s+/)
              if (words.length > 12) {
                taskTitle = words.slice(0, 12).join(' ')
              }
              
              // Limiter à 100 caractères pour le titre
              taskTitle = taskTitle.substring(0, 100).trim()
            }
            
            // La description contient l'action complète
            const taskDescription = actionText
            
            // Mapper le pillar_type au format attendu
            let pillarType = 'structure'
            if (pillar.pillar_type === 'acquisition') {
              pillarType = 'acquisition'
            } else if (pillar.pillar_type === 'vision') {
              pillarType = 'vision'
            }
            
            // Vérifier si la tâche existe déjà
            const { data: existingTasks } = await supabase
              .from('coaching_tasks')
              .select('id')
              .eq('client_id', clientProfileId)
              .eq('week_number', weekNumber)
              .ilike('title', `%${taskTitle.substring(0, 50)}%`)
              .limit(1)

            if (!existingTasks || existingTasks.length === 0) {
              const { error: taskError } = await supabase
                .from('coaching_tasks')
                .insert({
                  coach_id: coachId,
                  client_id: clientProfileId,
                  title: taskTitle,
                  description: taskDescription,
                  week_number: weekNumber,
                  status: 'pending',
                  priority: 'medium'
                })

              if (taskError) {
                console.error(`Error creating task from pillar ${pillar.pillar_type} for week ${weekNumber}:`, taskError)
              } else {
                console.log(`✅ Tâche créée depuis pilier: "${taskTitle}" (semaine ${weekNumber})`)
              }
            }
          }
        }
      }
    }

    // 2. Créer les notes de semaine avec les objectifs et actions (uniquement si coachClientId existe)
    if (coachClientId && roadmapContent?.monthly_plan) {
      const months = [
        roadmapContent.monthly_plan.month_1,
        roadmapContent.monthly_plan.month_2,
        roadmapContent.monthly_plan.month_3,
        roadmapContent.monthly_plan.month_4
      ]

      for (let monthIndex = 0; monthIndex < months.length; monthIndex++) {
        const month = months[monthIndex]
        if (!month) continue

        const baseWeek = monthIndex * 4 + 1
        const weekActions = [
          month.week_1,
          month.week_2,
          month.week_3,
          month.week_4
        ]

        for (let weekOffset = 0; weekOffset < 4; weekOffset++) {
          const weekNumber = baseWeek + weekOffset
          const weekAction = weekActions[weekOffset] || ''

          // Générer un titre très court basé sur les actions de la semaine (2-3 mots max)
          let weekTitle = `Semaine ${weekNumber}`
          if (weekAction && weekAction.trim().length > 0) {
            const generatedTitle = await generateWeekTitleWithChatGPT(weekAction, weekNumber)
            if (generatedTitle) {
              // Limiter à 3 mots maximum pour un titre vraiment court
              const words = generatedTitle.split(/\s+/)
              weekTitle = words.slice(0, 3).join(' ')
            }
          }

          // Le comment contient uniquement le titre court (ce que le client doit faire cette semaine)
          const { error: weekNoteError } = await supabase
            .from('coach_client_week_notes')
            .upsert({
              coach_client_id: coachClientId,
              week_number: weekNumber,
              comment: weekTitle,
              updated_at: new Date().toISOString()
            }, {
              onConflict: 'coach_client_id,week_number'
            })

          if (weekNoteError) {
            console.error(`Error upserting week note for week ${weekNumber}:`, weekNoteError)
          }

          // Créer des tâches à partir des actions de la semaine (uniquement si coachId existe)
          if (coachId) {
            const actions = weekAction.split('\n').filter(a => a.trim() && a.trim().startsWith('-'))
            for (const action of actions) {
              let actionText = action.replace(/^-\s*/, '').trim()
              if (actionText) {
                // Générer un titre avec ChatGPT
                let taskTitle = await generateTaskTitleWithChatGPT(actionText)
                
                // Fallback si ChatGPT échoue : utiliser la première phrase ou limiter
                if (!taskTitle) {
                  taskTitle = actionText
                  // Si l'action contient plusieurs phrases, prendre seulement la première
                  const firstSentence = actionText.split(/[.!?]\s+/)[0].trim()
                  if (firstSentence.length > 0 && firstSentence.length < actionText.length * 0.8) {
                    taskTitle = firstSentence
                  }
                  
                  // Limiter à 12 mots maximum
                  const words = taskTitle.split(/\s+/)
                  if (words.length > 12) {
                    taskTitle = words.slice(0, 12).join(' ')
                  }
                  
                  // Limiter à 100 caractères pour le titre
                  taskTitle = taskTitle.substring(0, 100).trim()
                }
                
                // La description contient l'action complète
                const taskDescription = actionText
                
                // Déterminer le pilier selon le contexte
                let pillar = 'structure' // par défaut
                if (weekAction.toLowerCase().includes('marketing') || 
                    weekAction.toLowerCase().includes('ads') || 
                    weekAction.toLowerCase().includes('acquisition') ||
                    weekAction.toLowerCase().includes('influenceur') ||
                    weekAction.toLowerCase().includes('instagram') ||
                    weekAction.toLowerCase().includes('prospection')) {
                  pillar = 'acquisition'
                } else if (weekAction.toLowerCase().includes('pilotage') ||
                           weekAction.toLowerCase().includes('kpi') ||
                           weekAction.toLowerCase().includes('tableau de bord') ||
                           weekAction.toLowerCase().includes('objectif')) {
                  pillar = 'vision'
                }
                
                // Vérifier si la tâche existe déjà
                const { data: existingTasks } = await supabase
                  .from('coaching_tasks')
                  .select('id')
                  .eq('client_id', clientProfileId)
                  .eq('week_number', weekNumber)
                  .ilike('title', `%${taskTitle.substring(0, 50)}%`)
                  .limit(1)

                if (!existingTasks || existingTasks.length === 0) {
                  const { error: taskError } = await supabase
                    .from('coaching_tasks')
                    .insert({
                      coach_id: coachId,
                      client_id: clientProfileId,
                      title: taskTitle,
                      description: taskDescription,
                      week_number: weekNumber,
                      status: 'pending',
                      priority: 'medium'
                    })

                  if (taskError) {
                    console.error(`Error creating task for week ${weekNumber}:`, taskError)
                  } else {
                    console.log(`✅ Tâche créée: "${taskTitle}" (semaine ${weekNumber})`)
                  }
                }
              }
            }
          }
        }
      }
    }

    // 3. Les objectifs stratégiques ne sont plus stockés dans les notes de semaine
    // Le comment contient uniquement le titre court de la semaine

    // 4. Stocker les métriques financières (uniquement si coachClientId et coachId existent)
    if (coachClientId && coachId && roadmapContent?.header?.financials) {
      const financials = roadmapContent.header.financials
      
      const revenue = parseCurrency(financials.ca)
      const cashFlow = parseCurrency(financials.treasury)
      const clientsCount = parseInt(financials.collaborators) || null
      const conversionRate = parsePercentage(financials.margin)

      if (revenue !== null || cashFlow !== null || clientsCount !== null) {
        // Essayer différentes structures de table
        const metricsData = {
          coach_client_id: coachClientId,
          coach_id: coachId, // Champ requis
          client_id: clientProfileId,
          week_number: 1,
          metric_type: 'financial', // Type de métrique (financial, operational, etc.)
          revenue: revenue,
          cash_in_bank: cashFlow,
          clients_count: clientsCount,
          conversion_rate: conversionRate,
          metric_date: new Date().toISOString().split('T')[0],
          updated_at: new Date().toISOString()
        }

        // Nettoyer les valeurs null
        Object.keys(metricsData).forEach(key => {
          if (metricsData[key] === null || metricsData[key] === undefined) {
            delete metricsData[key]
          }
        })

        // Essayer d'insérer avec upsert
        let { error: metricsError } = await supabase
          .from('client_metrics')
          .upsert(metricsData, {
            onConflict: 'coach_client_id,week_number'
          })

        // Si erreur de contrainte, essayer insert simple
        if (metricsError && metricsError.code === '42P10') {
          const { data: existing } = await supabase
            .from('client_metrics')
            .select('id')
            .eq('coach_client_id', coachClientId)
            .eq('week_number', 1)
            .maybeSingle()
          
          if (existing) {
            const { error: updateError } = await supabase
              .from('client_metrics')
              .update(metricsData)
              .eq('id', existing.id)
            metricsError = updateError
          } else {
            const { error: insertError } = await supabase
              .from('client_metrics')
              .insert(metricsData)
            metricsError = insertError
          }
        }

        if (metricsError) {
          console.error('Error upserting client metrics:', metricsError)
        }
      }
    }

    // Envoyer un email au client avec ses identifiants
    await sendWelcomeEmail(clientData, clientPassword, isNewClient, roadmapContent)

    return res.status(200).json({
      success: true,
      message: 'Roadmap data imported successfully',
      coach_client_id: coachClientId,
      client_profile_id: clientProfileId,
      client_id: clientProfileId,
      coach_id: coachId,
      client_email: clientData.client_email,
      client_name: clientData.client_name,
      coach_email: coachEmail || null,
      coach_name: coachInfo.coach_name || null
    })

  } catch (error) {
    console.error('Error importing roadmap data:', error)
    return res.status(500).json({
      error: 'Internal server error',
      details: error instanceof Error ? error.message : String(error)
    })
  }
})

// Export pour Vercel Serverless Functions
export default app

// Démarrer le serveur seulement si on n'est pas sur Vercel
// Vercel utilise les variables VERCEL ou VERCEL_ENV
if (!process.env.VERCEL && !process.env.VERCEL_ENV) {
  const PORT = process.env.PORT || 3000
  app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`)
  })
}

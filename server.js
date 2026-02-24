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

// Fallback : titre court algorithmique (5 mots max)
const getWeekShortTitle = (weekAction) => {
  const firstLine = weekAction.split('\n').find(l => l.trim().startsWith('-'))
  const actionText = firstLine?.replace(/^-\s*/, '').trim() || ''
  if (!actionText) return ''
  const words = actionText.split(/\s+/)
  return words.slice(0, 5).join(' ') + (words.length > 5 ? '...' : '')
}

// Génère 16 titres courts via OpenAI (1 seul appel batch), fallback algorithmique
const generateWeekTitlesOpenAI = async (monthlyPlan) => {
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY
  if (!OPENAI_API_KEY || !monthlyPlan) return null

  const months = [monthlyPlan.month_1, monthlyPlan.month_2, monthlyPlan.month_3, monthlyPlan.month_4]
  const allWeeks = []
  for (const month of months) {
    allWeeks.push(month?.week_1 || '', month?.week_2 || '', month?.week_3 || '', month?.week_4 || '')
  }

  const actionsText = allWeeks.map((actions, i) => {
    const lines = actions.split('\n').filter(a => a.trim().startsWith('-')).join(', ')
    return `S${i + 1}: ${lines || 'vide'}`
  }).join('\n')

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        max_tokens: 600,
        response_format: { type: 'json_object' },
        messages: [{
          role: 'user',
          content: `Tu es un assistant de coaching business. Pour chaque semaine ci-dessous, génère un titre très court (3-5 mots en français) qui résume l'ensemble des tâches de la semaine. Réponds UNIQUEMENT avec un JSON objet {"titles": ["titre S1", "titre S2", ...]}, exactement 16 titres.\n\n${actionsText}`
        }]
      })
    })

    if (response.ok) {
      const data = await response.json()
      const text = data.choices?.[0]?.message?.content?.trim()
      const parsed = JSON.parse(text)
      const titles = parsed?.titles
      if (Array.isArray(titles) && titles.length > 0) {
        console.log('✅ Titres OpenAI générés:', titles)
        return titles
      }
    } else {
      const err = await response.text()
      console.error('⚠️ Erreur OpenAI HTTP:', response.status, err)
    }
  } catch (e) {
    console.error('⚠️ Erreur génération titres OpenAI:', e)
  }
  return null
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
                    <a href="${APP_URL}/login"
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
        client_name: '',
        client_email: roadmapContent?.header?.email || '',
        client_phone: null
      }
    }

    if (!clientData.client_email && roadmapContent?.header?.email) {
      clientData.client_email = roadmapContent.header.email
    }

    // Générer un email si manquant
    if (!clientData.client_email && clientData.client_name) {
      clientData.client_email = `${clientData.client_name.toLowerCase().replace(/\s+/g, '.')}@client.temp`
    }

    // Date de début du programme (format YYYY-MM-DD)
    const rawStartDate = body.start_date || data.data?.start_date || roadmapContent?.header?.start_date || null
    const programStartDate = rawStartDate && /^\d{4}-\d{2}-\d{2}$/.test(rawStartDate)
      ? rawStartDate
      : new Date().toISOString().split('T')[0]

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

    // Recherche coach + client en parallèle
    const [coachResult, clientResult] = await Promise.all([
      coachEmail
        ? supabase.from('profiles').select('id, role').eq('email', coachEmail).maybeSingle()
        : Promise.resolve({ data: null }),
      clientData.client_id
        ? supabase.from('profiles').select('id').eq('id', clientData.client_id).maybeSingle()
        : supabase.from('profiles').select('id').eq('email', clientData.client_email).maybeSingle()
    ])

    let coachId = null
    if (coachResult.data?.role === 'coach') {
      coachId = coachResult.data.id
      console.log(`✅ Coach trouvé: ${coachId}`)
    } else if (coachResult.data) {
      console.log(`⚠️  ${coachEmail} trouvé mais rôle '${coachResult.data.role}' ≠ 'coach'`)
    } else if (coachEmail) {
      console.log(`⚠️  Aucun utilisateur trouvé avec l'email: ${coachEmail}`)
    }

    // Fallback par coach_id si pas trouvé par email
    if (!coachId && body.coach_id) {
      const { data: coachById } = await supabase
        .from('profiles').select('id, role').eq('id', body.coach_id).maybeSingle()
      if (coachById?.role === 'coach') {
        coachId = body.coach_id
        console.log(`✅ Coach trouvé par ID: ${coachId}`)
      }
    }

    let clientProfileId = clientResult.data?.id || null

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

      // Attendre que le trigger de la base de données crée le profil
      await new Promise(resolve => setTimeout(resolve, 500))

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

      const updateData = {}
      if (clientData.client_name) updateData.full_name = clientData.client_name
      if (clientData.client_phone) updateData.phone = clientData.client_phone
      if (roadmapContent?.header?.company_name) updateData.company = roadmapContent.header.company_name
      if (roadmapContent?.header?.address) updateData.location = roadmapContent.header.address

      const { data: existingProfile } = await supabase
        .from('profiles').select('user_id').eq('id', clientProfileId).single()

      // Mise à jour auth + profil en parallèle
      const [pwResult] = await Promise.all([
        existingProfile?.user_id
          ? supabase.auth.admin.updateUserById(existingProfile.user_id, { password: clientPassword })
          : Promise.resolve({ error: null }),
        Object.keys(updateData).length > 0
          ? supabase.from('profiles').update(updateData).eq('id', clientProfileId)
          : Promise.resolve()
      ])

      if (pwResult?.error) {
        console.error('⚠️ Erreur lors de la mise à jour du mot de passe:', pwResult.error)
      }
    }

    // Créer la relation coach-client uniquement si un coach est fourni
    let coachClientId = null
    
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
      } else {
        // Créer la relation coach-client
        const { data: newRelation, error: relationError } = await supabase
          .from('coach_clients')
          .insert({
            coach_id: coachId,
            client_id: clientProfileId,
            status: 'active',
            program_start_date: programStartDate,
            total_weeks: 16,
            current_week: 1
          })
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

    if (coachClientId) {
      const now = new Date().toISOString()

      // Préparer le préfixe des objectifs stratégiques pour la semaine 1
      const strategicGoalsPrefix = roadmapContent?.strategic_goals
        ? `OBJECTIFS STRATÉGIQUES\n\nObjectifs 4 mois:\n${roadmapContent.strategic_goals.goals_4_months || ''}\n\nObjectifs 12 mois:\n${roadmapContent.strategic_goals.goals_12_months || ''}\n\n---\n\n`
        : ''

      // 1. Batch upsert des piliers stratégiques (1 requête au lieu de 3)
      const pillarUpsert = roadmapContent?.vision ? supabase
        .from('roadmap_strategic_pillars')
        .upsert([
          {
            coach_client_id: coachClientId,
            pillar_type: 'operations',
            title: 'Structure & Opérations',
            problem: roadmapContent.vision.structure?.current_situation || '',
            actions: roadmapContent.vision.structure?.actions?.split('\n').filter(a => a.trim()) || [],
            expert_tip: roadmapContent.vision.structure?.expert_suggestion || 'Aucune suggestion',
            updated_at: now
          },
          {
            coach_client_id: coachClientId,
            pillar_type: 'acquisition',
            title: 'Acquisition & Vente',
            problem: roadmapContent.vision.acquisition?.current_situation || '',
            actions: roadmapContent.vision.acquisition?.actions?.split('\n').filter(a => a.trim()) || [],
            expert_tip: roadmapContent.vision.acquisition?.expert_suggestion || 'Aucune suggestion',
            updated_at: now
          },
          {
            coach_client_id: coachClientId,
            pillar_type: 'vision',
            title: 'Vision & Pilotage',
            problem: roadmapContent.vision.vision_pilotage?.current_situation || '',
            actions: roadmapContent.vision.vision_pilotage?.actions?.split('\n').filter(a => a.trim()) || [],
            expert_tip: roadmapContent.vision.vision_pilotage?.expert_suggestion || 'Aucune suggestion',
            updated_at: now
          }
        ], { onConflict: 'coach_client_id,pillar_type' }) : Promise.resolve()

      // 2. Construire toutes les notes de semaine + tâches en mémoire
      const weekNoteRows = []
      const taskRows = []

      if (roadmapContent?.monthly_plan) {
        const aiTitles = await generateWeekTitlesOpenAI(roadmapContent.monthly_plan)

        const months = [
          roadmapContent.monthly_plan.month_1,
          roadmapContent.monthly_plan.month_2,
          roadmapContent.monthly_plan.month_3,
          roadmapContent.monthly_plan.month_4
        ]

        for (let monthIndex = 0; monthIndex < months.length; monthIndex++) {
          const month = months[monthIndex]
          if (!month) continue

          const weekActions = [month.week_1, month.week_2, month.week_3, month.week_4]

          for (let weekOffset = 0; weekOffset < 4; weekOffset++) {
            const weekNumber = monthIndex * 4 + weekOffset + 1
            const weekAction = weekActions[weekOffset] || ''
            const shortWeekTitle = aiTitles?.[weekNumber - 1] || getWeekShortTitle(weekAction)

            weekNoteRows.push({ coach_client_id: coachClientId, week_number: weekNumber, comment: shortWeekTitle, updated_at: now })

            // Collecter les tâches
            if (coachId) {
              weekAction.split('\n')
                .filter(a => a.trim().startsWith('-'))
                .forEach(action => {
                  const actionText = action.replace(/^-\s*/, '').trim()
                  if (actionText) {
                    const shortTitle = actionText.length > 80
                      ? actionText.substring(0, 80).replace(/\s+\S*$/, '') + '...'
                      : actionText
                    taskRows.push({
                      coach_id: coachId,
                      client_id: clientProfileId,
                      title: shortTitle,
                      week_number: weekNumber,
                      status: 'pending',
                      priority: 'medium'
                    })
                  }
                })
            }
          }
        }
      }

      // 3. Lancer piliers + notes de semaine + tâches en parallèle (3 requêtes au lieu de ~200)
      const weekNotesUpsert = weekNoteRows.length > 0
        ? supabase.from('coach_client_week_notes').upsert(weekNoteRows, { onConflict: 'coach_client_id,week_number' })
        : Promise.resolve()

      const tasksInsert = taskRows.length > 0
        ? supabase.from('coaching_tasks').insert(taskRows)
        : Promise.resolve()

      const [pillarResult, notesResult, tasksResult] = await Promise.all([pillarUpsert, weekNotesUpsert, tasksInsert])

      if (pillarResult?.error) console.error('Error upserting pillars:', pillarResult.error)
      if (notesResult?.error) console.error('Error upserting week notes:', notesResult.error)
      if (tasksResult?.error) console.error('Error inserting tasks:', tasksResult.error)
    }

    // 4. Stocker les métriques financières (uniquement si coachClientId existe)
    if (coachClientId && roadmapContent?.header?.financials) {
      const financials = roadmapContent.header.financials
      
      const revenue = parseCurrency(financials.ca)
      const cashFlow = parseCurrency(financials.treasury)
      const clientsCount = parseInt(financials.collaborators) || null
      const conversionRate = parsePercentage(financials.margin)

      if (revenue !== null || cashFlow !== null || clientsCount !== null) {
        // Essayer différentes structures de table
        const metricsData = {
          coach_client_id: coachClientId,
          client_id: clientProfileId,
          week_number: 1,
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

    return res.status(200).json({
      success: true,
      message: 'Roadmap data imported successfully',
      coach_client_id: coachClientId,
      client_profile_id: clientProfileId,
      client_id: clientProfileId,
      coach_id: coachId,
      client_email: clientData.client_email,
      client_name: clientData.client_name,
      client_password: clientPassword,
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

// Endpoint pour mettre à jour une roadmap existante
app.put('/update-roadmap', async (req, res) => {
  try {
    // Vérifier la configuration Supabase au début de la requête (pour Vercel)
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !supabase) {
      return res.status(500).json({
        error: 'Server configuration error'
      })
    }

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

    if (isNewFormat) {
      // Nouveau format : data.plan
      roadmapContent = data.plan
      clientData = {
        client_id: data.data.client_id || null,
        client_name: data.data.client_name || '',
        client_email: data.data.client_email || '',
        client_phone: data.data.client_phone || null
      }
    } else {
      // Ancien format : validation et ''
      roadmapContent = data['']
      clientData = {
        client_id: data.validation?.client_id || null,
        client_name: '',
        client_email: roadmapContent?.header?.email || '',
        client_phone: null
      }
    }

    if (!clientData.client_email && roadmapContent?.header?.email) {
      clientData.client_email = roadmapContent.header.email
    }

    // Requis : client_id ou client_email pour identifier le client
    let clientProfileId = null

    // Si le client_id n'existe pas, chercher par email
    if (!clientProfileId && clientData.client_email) {
      const { data: existingClientByEmail } = await supabase
        .from('profiles')
        .select('id')
        .eq('email', clientData.client_email)
        .maybeSingle()

      if (existingClientByEmail) {
        clientProfileId = existingClientByEmail.id
      }
    }

    // Vérifier qu'un client existe
    if (!clientProfileId) {
      return res.status(404).json({
        error: 'Client not found',
        details: 'Aucun client trouvé avec le client_id ou client_email fourni. Utilisez /add-roadmap pour créer un nouveau client.'
      })
    }

    // Trouver la relation coach-client existante
    const { data: coachClientRelation } = await supabase
      .from('coach_clients')
      .select('id, coach_id')
      .eq('client_id', clientProfileId)
      .eq('status', 'active')
      .maybeSingle()

    const coachClientId = coachClientRelation?.id || null
    const coachId = coachClientRelation?.coach_id || null

    if (!coachClientId) {
      return res.status(404).json({
        error: 'Coach-client relation not found',
        details: 'Aucune relation coach-client active trouvée pour ce client. Utilisez /add-roadmap pour créer une nouvelle relation.'
      })
    }

    // Mettre à jour le profil client si des informations sont fournies
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

    // 1. Mettre à jour les piliers stratégiques
    if (roadmapContent?.vision) {
      const pillars = [
        {
          pillar_type: 'operations',
          title: 'Structure & Opérations',
          problem: roadmapContent.vision.structure?.current_situation || '',
          actions: roadmapContent.vision.structure?.actions?.split('\n').filter(a => a.trim()) || [],
          expert_tip: roadmapContent.vision.structure?.expert_suggestion || 'Aucune suggestion'
        },
        {
          pillar_type: 'acquisition',
          title: 'Acquisition & Vente',
          problem: roadmapContent.vision.acquisition?.current_situation || '',
          actions: roadmapContent.vision.acquisition?.actions?.split('\n').filter(a => a.trim()) || [],
          expert_tip: roadmapContent.vision.acquisition?.expert_suggestion || 'Aucune suggestion'
        },
        {
          pillar_type: 'vision',
          title: 'Vision & Pilotage',
          problem: roadmapContent.vision.vision_pilotage?.current_situation || '',
          actions: roadmapContent.vision.vision_pilotage?.actions?.split('\n').filter(a => a.trim()) || [],
          expert_tip: roadmapContent.vision.vision_pilotage?.expert_suggestion || 'Aucune suggestion'
        }
      ]

      for (const pillar of pillars) {
        const { error: pillarError } = await supabase
          .from('roadmap_strategic_pillars')
          .upsert({
            coach_client_id: coachClientId,
            pillar_type: pillar.pillar_type,
            title: pillar.title,
            problem: pillar.problem,
            actions: pillar.actions,
            expert_tip: pillar.expert_tip,
            updated_at: new Date().toISOString()
          }, {
            onConflict: 'coach_client_id,pillar_type'
          })

        if (pillarError) {
          console.error(`Error upserting pillar ${pillar.pillar_type}:`, pillarError)
        }
      }
    }

    // 2. Mettre à jour les notes de semaine avec les objectifs et actions
    if (roadmapContent?.monthly_plan) {
      const aiTitles = await generateWeekTitlesOpenAI(roadmapContent.monthly_plan)

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
          const shortWeekTitle = aiTitles?.[weekNumber - 1] || getWeekShortTitle(weekAction)

          const { error: weekNoteError } = await supabase
            .from('coach_client_week_notes')
            .upsert({
              coach_client_id: coachClientId,
              week_number: weekNumber,
              comment: shortWeekTitle,
              updated_at: new Date().toISOString()
            }, {
              onConflict: 'coach_client_id,week_number'
            })

          if (weekNoteError) {
            console.error(`Error upserting week note for week ${weekNumber}:`, weekNoteError)
          }

          // Mettre à jour les tâches à partir des actions de la semaine
          if (coachId) {
            const actions = weekAction.split('\n').filter(a => a.trim() && a.trim().startsWith('-'))
            for (const action of actions) {
              const actionText = action.replace(/^-\s*/, '').trim()
              if (actionText) {
                // Vérifier si la tâche existe déjà
                const { data: existingTasks } = await supabase
                  .from('coaching_tasks')
                  .select('id')
                  .eq('client_id', clientProfileId)
                  .eq('week_number', weekNumber)
                  .ilike('title', `%${actionText.substring(0, 50)}%`)
                  .limit(1)

                if (!existingTasks || existingTasks.length === 0) {
                  const shortTitle = actionText.length > 80
                    ? actionText.substring(0, 80).replace(/\s+\S*$/, '') + '...'
                    : actionText
                  const { error: taskError } = await supabase
                    .from('coaching_tasks')
                    .insert({
                      coach_id: coachId,
                      client_id: clientProfileId,
                      title: shortTitle,
                      week_number: weekNumber,
                      status: 'pending',
                      priority: 'medium'
                    })

                  if (taskError) {
                    console.error(`Error creating task for week ${weekNumber}:`, taskError)
                  }
                }
              }
            }
          }
        }
      }
    }

    // 4. Mettre à jour les métriques financières
    if (roadmapContent?.header?.financials) {
      const financials = roadmapContent.header.financials
      
      const revenue = parseCurrency(financials.ca)
      const cashFlow = parseCurrency(financials.treasury)
      const clientsCount = parseInt(financials.collaborators) || null
      const conversionRate = parsePercentage(financials.margin)

      if (revenue !== null || cashFlow !== null || clientsCount !== null) {
        const metricsData = {
          coach_client_id: coachClientId,
          client_id: clientProfileId,
          week_number: 1,
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

    return res.status(200).json({
      success: true,
      message: 'Roadmap updated successfully',
      coach_client_id: coachClientId,
      client_profile_id: clientProfileId,
      client_id: clientProfileId,
      coach_id: coachId
    })

  } catch (error) {
    console.error('Error updating roadmap data:', error)
    return res.status(500).json({
      error: 'Internal server error',
      details: error instanceof Error ? error.message : String(error)
    })
  }
})

// Endpoint pour créer une nouvelle roadmap pour un nouveau cycle
app.post('/new-cycle-roadmap', async (req, res) => {
  try {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !supabase) {
      return res.status(500).json({ error: 'Server configuration error' })
    }

    console.log('📨 Requête reçue:', req.method, req.url)
    console.log('📋 Body reçu:', JSON.stringify(req.body).substring(0, 200))

    // Parser le body - mêmes formats supportés que /add-roadmap
    const body = req.body
    let data

    if (Array.isArray(body)) {
      data = body[0]
    } else if (body.data && body.plan) {
      data = body
    } else if (body.roadmap_data) {
      data = body.roadmap_data
    } else {
      data = body
    }

    const isNewFormat = isRoadmapDataNew(data)
    const isOldFormat = isRoadmapDataOld(data)

    if (!isNewFormat && !isOldFormat) {
      return res.status(400).json({
        error: 'Invalid data format. Expected format with data/plan or validation/""'
      })
    }

    // Normaliser les données
    let roadmapContent
    let clientData = { client_id: null, client_name: '', client_email: '', client_phone: null }
    let coachInfo = { coach_name: null, coach_email: null }

    if (isNewFormat) {
      roadmapContent = data.plan
      clientData = {
        client_id: data.data.client_id || null,
        client_name: data.data.client_name || '',
        client_email: data.data.client_email || '',
        client_phone: data.data.client_phone || null
      }
      coachInfo = {
        coach_name: data.data.coach_name || null,
        coach_email: data.data.coach_email || null
      }
    } else {
      roadmapContent = data['']
      clientData = {
        client_id: data.validation?.client_id || null,
        client_name: '',
        client_email: roadmapContent?.header?.email || '',
        client_phone: null
      }
    }

    if (!clientData.client_email && roadmapContent?.header?.email) {
      clientData.client_email = roadmapContent.header.email
    }

    if (!clientData.client_email) {
      return res.status(400).json({ error: 'client_email is required' })
    }

    // Numéro de cycle fourni ou auto-détecté
    const requestedCycleNumber = body.cycle_number || data.data?.cycle_number || null

    // Date de début du programme (format YYYY-MM-DD)
    const rawStartDate = body.start_date || data.data?.start_date || roadmapContent?.header?.start_date || null
    const programStartDate = rawStartDate && /^\d{4}-\d{2}-\d{2}$/.test(rawStartDate)
      ? rawStartDate
      : new Date().toISOString().split('T')[0]

    // Trouver le coach
    let coachEmail = coachInfo.coach_email ||
                     body.coach_email ||
                     body.data?.coach_email ||
                     data.data?.coach_email ||
                     roadmapContent?.header?.coach_email ||
                     null

    if (!coachInfo.coach_name) {
      coachInfo.coach_name = body.coach_name ||
                             body.data?.coach_name ||
                             data.data?.coach_name ||
                             roadmapContent?.header?.coach_name ||
                             null
    }

    let coachId = null

    if (coachEmail) {
      const { data: existingCoach } = await supabase
        .from('profiles')
        .select('id, role')
        .eq('email', coachEmail)
        .eq('role', 'coach')
        .maybeSingle()

      if (existingCoach) {
        coachId = existingCoach.id
        console.log(`✅ Coach trouvé par email: ${coachId}`)
      } else {
        console.log(`⚠️  Aucun coach trouvé avec l'email: ${coachEmail}`)
      }
    }

    if (!coachId) {
      const providedCoachId = body.coach_id || null
      if (providedCoachId) {
        const { data: coachProfile } = await supabase
          .from('profiles')
          .select('id, role')
          .eq('id', providedCoachId)
          .maybeSingle()

        if (coachProfile?.role === 'coach') {
          coachId = providedCoachId
          console.log(`✅ Coach trouvé par ID: ${coachId}`)
        }
      }
    }

    if (!coachId) {
      return res.status(400).json({
        error: 'coach_email or coach_id is required to create a new cycle'
      })
    }

    // Trouver le client existant (obligatoire — pas de création ici)
    let clientProfileId = null

    if (clientData.client_id) {
      const { data: existingClient } = await supabase
        .from('profiles')
        .select('id')
        .eq('id', clientData.client_id)
        .single()

      if (existingClient) clientProfileId = existingClient.id
    }

    if (!clientProfileId) {
      const { data: existingClientByEmail } = await supabase
        .from('profiles')
        .select('id')
        .eq('email', clientData.client_email)
        .single()

      if (existingClientByEmail) clientProfileId = existingClientByEmail.id
    }

    if (!clientProfileId) {
      return res.status(404).json({
        error: 'Client not found. Use /add-roadmap to create a new client first.'
      })
    }

    // Déterminer le numéro de cycle
    let cycleNumber = requestedCycleNumber

    if (!cycleNumber) {
      let cycleQuery = supabase
        .from('coach_clients')
        .select('cycle_number')
        .eq('coach_id', coachId)
        .eq('client_id', clientProfileId)

      const { data: existingCycles } = await cycleQuery
        .order('cycle_number', { ascending: false })
        .limit(1)

      if (existingCycles && existingCycles.length > 0 && existingCycles[0].cycle_number) {
        cycleNumber = existingCycles[0].cycle_number + 1
      } else {
        cycleNumber = 2 // cycle 1 est créé par /add-roadmap
      }
    }

    console.log(`🔄 Création du cycle ${cycleNumber} pour le client ${clientData.client_email}`)

    // Créer un nouveau coach_clients pour ce cycle
    const { data: newRelation, error: relationError } = await supabase
      .from('coach_clients')
      .insert({
        coach_id: coachId,
        client_id: clientProfileId,
        status: 'active',
        program_start_date: programStartDate,
        total_weeks: 16,
        current_week: 1,
        cycle_number: cycleNumber
      })
      .select('id')
      .single()

    if (relationError || !newRelation) {
      console.error('Erreur lors de la création de la relation coach-client:', relationError)
      return res.status(500).json({
        error: 'Failed to create coach-client relation for new cycle',
        details: relationError
      })
    }

    const coachClientId = newRelation.id
    console.log(`✅ Nouveau cycle ${cycleNumber} créé: coach_client_id=${coachClientId}`)

    // 1. Piliers stratégiques
    if (roadmapContent?.vision) {
      const pillars = [
        {
          pillar_type: 'operations',
          title: 'Structure & Opérations',
          problem: roadmapContent.vision.structure?.current_situation || '',
          actions: roadmapContent.vision.structure?.actions?.split('\n').filter(a => a.trim()) || [],
          expert_tip: roadmapContent.vision.structure?.expert_suggestion || 'Aucune suggestion'
        },
        {
          pillar_type: 'acquisition',
          title: 'Acquisition & Vente',
          problem: roadmapContent.vision.acquisition?.current_situation || '',
          actions: roadmapContent.vision.acquisition?.actions?.split('\n').filter(a => a.trim()) || [],
          expert_tip: roadmapContent.vision.acquisition?.expert_suggestion || 'Aucune suggestion'
        },
        {
          pillar_type: 'vision',
          title: 'Vision & Pilotage',
          problem: roadmapContent.vision.vision_pilotage?.current_situation || '',
          actions: roadmapContent.vision.vision_pilotage?.actions?.split('\n').filter(a => a.trim()) || [],
          expert_tip: roadmapContent.vision.vision_pilotage?.expert_suggestion || 'Aucune suggestion'
        }
      ]

      for (const pillar of pillars) {
        const { error: pillarError } = await supabase
          .from('roadmap_strategic_pillars')
          .upsert({
            coach_client_id: coachClientId,
            pillar_type: pillar.pillar_type,
            title: pillar.title,
            problem: pillar.problem,
            actions: pillar.actions,
            expert_tip: pillar.expert_tip,
            updated_at: new Date().toISOString()
          }, {
            onConflict: 'coach_client_id,pillar_type'
          })

        if (pillarError) {
          console.error(`Error upserting pillar ${pillar.pillar_type}:`, pillarError)
        }
      }
    }

    // 2. Notes de semaine (plan mensuel)
    if (roadmapContent?.monthly_plan) {
      const aiTitles = await generateWeekTitlesOpenAI(roadmapContent.monthly_plan)

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
        const weekActions = [month.week_1, month.week_2, month.week_3, month.week_4]

        for (let weekOffset = 0; weekOffset < 4; weekOffset++) {
          const weekNumber = baseWeek + weekOffset
          const weekAction = weekActions[weekOffset] || ''
          const shortWeekTitle = aiTitles?.[weekNumber - 1] || getWeekShortTitle(weekAction)

          const { error: weekNoteError } = await supabase
            .from('coach_client_week_notes')
            .upsert({
              coach_client_id: coachClientId,
              week_number: weekNumber,
              comment: shortWeekTitle,
              updated_at: new Date().toISOString()
            }, {
              onConflict: 'coach_client_id,week_number'
            })

          if (weekNoteError) {
            console.error(`Error upserting week note for week ${weekNumber}:`, weekNoteError)
          }

          // Créer les tâches à partir des actions
          const actions = weekAction.split('\n').filter(a => a.trim() && a.trim().startsWith('-'))
          for (const action of actions) {
            const actionText = action.replace(/^-\s*/, '').trim()
            if (actionText) {
              const { data: existingTasks } = await supabase
                .from('coaching_tasks')
                .select('id')
                .eq('client_id', clientProfileId)
                .eq('week_number', weekNumber)
                .ilike('title', `%${actionText.substring(0, 50)}%`)
                .limit(1)

              if (!existingTasks || existingTasks.length === 0) {
                const shortTitle = actionText.length > 80
                  ? actionText.substring(0, 80).replace(/\s+\S*$/, '') + '...'
                  : actionText
                await supabase.from('coaching_tasks').insert({
                  coach_id: coachId,
                  client_id: clientProfileId,
                  title: shortTitle,
                  week_number: weekNumber,
                  status: 'pending',
                  priority: 'medium'
                })
              }
            }
          }
        }
      }
    }

    // 4. Métriques financières
    if (roadmapContent?.header?.financials) {
      const financials = roadmapContent.header.financials
      const revenue = parseCurrency(financials.ca)
      const cashFlow = parseCurrency(financials.treasury)
      const clientsCount = parseInt(financials.collaborators) || null
      const conversionRate = parsePercentage(financials.margin)

      if (revenue !== null || cashFlow !== null || clientsCount !== null) {
        const metricsData = {
          coach_client_id: coachClientId,
          client_id: clientProfileId,
          week_number: 1,
          revenue,
          cash_in_bank: cashFlow,
          clients_count: clientsCount,
          conversion_rate: conversionRate,
          metric_date: new Date().toISOString().split('T')[0],
          updated_at: new Date().toISOString()
        }

        Object.keys(metricsData).forEach(key => {
          if (metricsData[key] === null || metricsData[key] === undefined) {
            delete metricsData[key]
          }
        })

        let { error: metricsError } = await supabase
          .from('client_metrics')
          .upsert(metricsData, { onConflict: 'coach_client_id,week_number' })

        if (metricsError && metricsError.code === '42P10') {
          const { data: existing } = await supabase
            .from('client_metrics')
            .select('id')
            .eq('coach_client_id', coachClientId)
            .eq('week_number', 1)
            .maybeSingle()

          if (existing) {
            await supabase.from('client_metrics').update(metricsData).eq('id', existing.id)
          } else {
            await supabase.from('client_metrics').insert(metricsData)
          }
        }
      }
    }

    console.log(`✅ Cycle ${cycleNumber} importé pour le client ${clientData.client_email}`)

    return res.status(200).json({
      success: true,
      message: `Cycle ${cycleNumber} roadmap created successfully`,
      coach_client_id: coachClientId,
      client_profile_id: clientProfileId,
      client_id: clientProfileId,
      coach_id: coachId,
      client_email: clientData.client_email,
      client_name: clientData.client_name,
      cycle_number: cycleNumber
    })

  } catch (error) {
    console.error('Error creating new cycle roadmap:', error)
    return res.status(500).json({
      error: 'Internal server error',
      details: error instanceof Error ? error.message : String(error)
    })
  }
})

// Endpoint pour bloquer/débloquer un utilisateur
app.post('/block-user', async (req, res) => {
  try {
    // Vérifier la configuration Supabase
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !supabase) {
      return res.status(500).json({
        error: 'Server configuration error'
      })
    }

    const { email, blocked } = req.body

    // Vérifier que l'email est fourni
    if (!email) {
      return res.status(400).json({
        error: 'email requis'
      })
    }

    // Le paramètre blocked est optionnel, par défaut on bloque
    const shouldBlock = blocked !== false

    // Trouver l'utilisateur par email
    const { data: profileData, error: searchError } = await supabase
      .from('profiles')
      .select('id, user_id, email, full_name, role')
      .eq('email', email)
      .maybeSingle()

    if (searchError) {
      console.error('Erreur lors de la recherche par email:', searchError)
    }

    if (!profileData) {
      return res.status(404).json({
        error: 'Utilisateur non trouvé'
      })
    }

    // Mettre à jour le statut dans la table profiles
    const { error: updateProfileError } = await supabase
      .from('profiles')
      .update({
        is_blocked: shouldBlock,
        blocked_at: shouldBlock ? new Date().toISOString() : null,
        updated_at: new Date().toISOString()
      })
      .eq('id', profileData.id)

    if (updateProfileError) {
      console.error('Erreur lors de la mise à jour du profil:', updateProfileError)
      // On continue même si cette mise à jour échoue (le champ peut ne pas exister)
    }

    // Bannir/débannir l'utilisateur au niveau de Supabase Auth
    if (profileData.user_id) {
      const { error: authError } = await supabase.auth.admin.updateUserById(
        profileData.user_id,
        {
          // ban_duration: 'none' pour débannir, ou une durée très longue pour bannir
          ban_duration: shouldBlock ? '876000h' : 'none' // ~100 ans si bloqué
        }
      )

      if (authError) {
        console.error('Erreur lors du bannissement Auth:', authError)
        return res.status(500).json({
          error: 'Erreur lors du blocage de l\'utilisateur',
          details: authError.message
        })
      }
    }

    console.log(`✅ Utilisateur ${profileData.email} ${shouldBlock ? 'bloqué' : 'débloqué'}`)

    return res.status(200).json({
      success: true,
      message: shouldBlock ? 'Utilisateur bloqué avec succès' : 'Utilisateur débloqué avec succès',
      user_id: profileData.id,
      email: profileData.email,
      blocked: shouldBlock
    })

  } catch (error) {
    console.error('Error blocking user:', error)
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

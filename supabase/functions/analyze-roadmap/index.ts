import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const OPENAI_API_KEY = Deno.env.get('OPENAI_API_KEY')!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

interface AnalyzeRoadmapPayload {
  file_url?: string;
  file_name?: string;
  roadmap_content?: string; // Nouveau: contenu JSON de la roadmap
  content_type?: 'json' | 'file'; // Type de contenu fourni
  client_id?: string;
  coach_id?: string;
}

interface RoadmapExtraction {
  tasks: Array<{
    title: string;
    description?: string;
    week_number?: number;
    priority?: 'low' | 'medium' | 'high';
    status?: 'pending' | 'in_progress' | 'completed';
    pillar?: 'structure' | 'acquisition' | 'vision';
  }>;
  notes?: Array<{
    week_number: number;
    comment: string;
  }>;
  summary?: string;
}

/**
 * Extrait le texte d'un fichier DOCX
 * Les fichiers DOCX sont des archives ZIP contenant des fichiers XML
 */
async function extractTextFromDOCX(arrayBuffer: ArrayBuffer): Promise<string> {
  try {
    // Les fichiers DOCX sont des archives ZIP
    // On va chercher le fichier word/document.xml qui contient le texte
    
    const uint8Array = new Uint8Array(arrayBuffer);
    const decoder = new TextDecoder('utf-8', { fatal: false });
    const text = decoder.decode(uint8Array);
    
    console.log('📄 Extraction du texte du DOCX...');
    
    // Chercher le contenu XML du document
    // Le fichier word/document.xml contient le texte entre des balises <w:t>
    const textMatches: string[] = [];
    
    // Méthode 1: Chercher les balises <w:t> qui contiennent le texte
    const wtPattern = /<w:t[^>]*>([^<]*)<\/w:t>/g;
    let match;
    
    while ((match = wtPattern.exec(text)) !== null) {
      const textContent = match[1];
      if (textContent && textContent.trim().length > 0) {
        // Décoder les entités HTML
        const decoded = textContent
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&amp;/g, '&')
          .replace(/&quot;/g, '"')
          .replace(/&apos;/g, "'")
          .trim();
        if (decoded.length > 0) {
          textMatches.push(decoded);
        }
      }
    }
    
    // Méthode 2: Si peu de texte trouvé, chercher du texte directement dans le XML
    if (textMatches.length < 5) {
      // Chercher du texte entre balises XML
      const xmlTextPattern = />([^<]{10,})</g;
      while ((match = xmlTextPattern.exec(text)) !== null) {
        const textContent = match[1].trim();
        // Filtrer les textes qui semblent être du vrai contenu (pas du code XML)
        if (textContent.length > 10 && 
            /[a-zA-ZÀ-ÿ]/.test(textContent) && 
            textContent.match(/[a-zA-ZÀ-ÿ]/g)!.length > textContent.length * 0.3) {
          textMatches.push(textContent);
        }
      }
    }
    
    if (textMatches.length === 0) {
      throw new Error('Aucun texte trouvé dans le fichier DOCX. Le fichier pourrait être vide ou corrompu.');
    }
    
    // Joindre le texte et nettoyer
    let extractedText = textMatches
      .join(' ')
      .replace(/\s+/g, ' ')
      .replace(/\n\s*\n/g, '\n')
      .trim();
    
    // Limiter à 50k caractères
    if (extractedText.length > 50000) {
      extractedText = extractedText.substring(0, 50000);
    }
    
    console.log(`✅ ${extractedText.length} caractères extraits du DOCX`);
    console.log('📄 Aperçu du texte extrait:', extractedText.substring(0, 500));
    
    if (extractedText.length < 50) {
      throw new Error('Très peu de texte extrait du DOCX. Le fichier pourrait être vide ou ne contenir que des images.');
    }
    
    return extractedText;
  } catch (error) {
    console.error('Erreur extraction texte DOCX:', error);
    throw new Error(`Impossible d'extraire le texte du DOCX: ${error instanceof Error ? error.message : 'Erreur inconnue'}. Veuillez convertir le DOCX en TXT manuellement.`);
  }
}

/**
 * Extrait le texte d'un PDF de manière améliorée
 * Utilise plusieurs méthodes pour extraire le texte
 */
async function extractTextFromPDF(arrayBuffer: ArrayBuffer): Promise<string> {
  try {
    const uint8Array = new Uint8Array(arrayBuffer);
    const decoder = new TextDecoder('latin1', { fatal: false }); // Utiliser latin1 pour mieux gérer les caractères
    const text = decoder.decode(uint8Array);
    
    console.log('📄 Taille du PDF:', arrayBuffer.byteLength, 'bytes');
    console.log('📄 Premiers caractères:', text.substring(0, 200));
    
    const textMatches: string[] = [];
    
    // Méthode 1: Extraire le texte entre BT (Begin Text) et ET (End Text)
    const btPattern = /BT[\s\S]*?ET/g;
    let match;
    let btCount = 0;
    
    while ((match = btPattern.exec(text)) !== null) {
      btCount++;
      const textBlock = match[0];
      
      // Extraire le texte entre parenthèses (format de texte PDF standard)
      const textInParens = textBlock.match(/\((.*?)\)/g);
      if (textInParens) {
        for (const textMatch of textInParens) {
          let cleanText = textMatch
            .replace(/[()]/g, '')
            .replace(/\\([nrtbf])/g, (_, char) => {
              switch (char) {
                case 'n': return '\n';
                case 'r': return '\r';
                case 't': return '\t';
                case 'b': return '\b';
                case 'f': return '\f';
                default: return char;
              }
            })
            .replace(/\\(\d{1,3})/g, (_, num) => String.fromCharCode(parseInt(num, 8)))
            .trim();
          
          if (cleanText.length > 2) { // Ignorer les très courts fragments
            textMatches.push(cleanText);
          }
        }
      }
      
      // Extraire aussi le texte entre crochets (format alternatif)
      const textInBrackets = textBlock.match(/\[(.*?)\]/g);
      if (textInBrackets) {
        for (const textMatch of textInBrackets) {
          let cleanText = textMatch
            .replace(/[\[\]]/g, '')
            .trim();
          if (cleanText.length > 2) {
            textMatches.push(cleanText);
          }
        }
      }
    }
    
    console.log(`📊 ${btCount} blocs BT/ET trouvés, ${textMatches.length} fragments de texte extraits`);
    
    // Méthode 2: Si peu de texte trouvé, chercher du texte lisible directement dans le PDF
    if (textMatches.length < 10) {
      console.log('⚠️ Peu de texte trouvé avec BT/ET, recherche alternative...');
      
      // Chercher des séquences de caractères alphanumériques et espaces
      const readablePattern = /[a-zA-ZÀ-ÿ0-9\s.,;:!?()\-'"]{20,}/g;
      const readableMatches = text.match(readablePattern);
      
      if (readableMatches && readableMatches.length > 0) {
        console.log(`📊 ${readableMatches.length} séquences de texte lisible trouvées`);
        // Filtrer les séquences qui semblent être du vrai texte (pas du code PDF)
        const filteredMatches = readableMatches.filter(match => {
          // Vérifier qu'il y a au moins quelques lettres
          const letterCount = (match.match(/[a-zA-ZÀ-ÿ]/g) || []).length;
          return letterCount > match.length * 0.3; // Au moins 30% de lettres
        });
        
        if (filteredMatches.length > 0) {
          textMatches.push(...filteredMatches);
        }
      }
    }
    
    if (textMatches.length === 0) {
      console.error('❌ Aucun texte trouvé dans le PDF');
      throw new Error('Impossible d\'extraire le texte du PDF. Le PDF pourrait être une image scannée, protégé, ou le format n\'est pas supporté. Veuillez convertir le PDF en TXT manuellement.');
    }
    
    // Nettoyer et joindre le texte
    let extractedText = textMatches
      .join(' ')
      .replace(/\s+/g, ' ') // Remplacer les espaces multiples
      .replace(/\n\s*\n/g, '\n') // Remplacer les lignes vides multiples
      .trim();
    
    // Limiter à 50k caractères
    if (extractedText.length > 50000) {
      extractedText = extractedText.substring(0, 50000);
    }
    
    console.log(`✅ ${extractedText.length} caractères extraits du PDF`);
    console.log('📄 Aperçu du texte extrait:', extractedText.substring(0, 500));
    
    if (extractedText.length < 50) {
      throw new Error('Très peu de texte extrait du PDF. Le PDF pourrait être une image scannée ou ne contenir que des images.');
    }
    
    return extractedText;
  } catch (error) {
    console.error('❌ Erreur extraction texte PDF:', error);
    throw error;
  }
}

/**
 * Télécharge et lit le contenu d'un fichier depuis Supabase Storage
 */
async function readFileContent(fileUrl: string): Promise<string> {
  try {
    console.log('📥 Téléchargement du fichier depuis l\'URL:', fileUrl);
    
    // Télécharger directement depuis l'URL publique (plus simple et plus fiable)
    const response = await fetch(fileUrl);
    
    if (!response.ok) {
      throw new Error(`Erreur lors du téléchargement: ${response.status} ${response.statusText}`);
    }
    
    // Extraire l'extension du fichier depuis l'URL
    const url = new URL(fileUrl);
    const pathParts = url.pathname.split('/').filter(part => part.length > 0);
    const fileName = pathParts[pathParts.length - 1] || '';
    const fileExtension = fileName.split('.').pop()?.toLowerCase() || '';
    
    console.log('📄 Type de fichier détecté:', fileExtension);
    
    const arrayBuffer = await response.arrayBuffer();
    
    // Lire le contenu selon le type de fichier
    if (fileExtension === 'txt' || fileExtension === 'md') {
      return new TextDecoder('utf-8').decode(arrayBuffer);
    } else if (fileExtension === 'pdf') {
      // Extraire le texte du PDF
      console.log('📄 Extraction du texte du PDF...');
      try {
        const extractedText = await extractTextFromPDF(arrayBuffer);
        if (!extractedText || extractedText.trim().length === 0) {
          throw new Error('Aucun texte extrait du PDF');
        }
        return extractedText;
      } catch (error) {
        console.error('Erreur extraction PDF:', error);
        throw new Error(`Impossible d'extraire le texte du PDF: ${error instanceof Error ? error.message : 'Erreur inconnue'}. Veuillez convertir le PDF en TXT manuellement.`);
      }
    } else if (fileExtension === 'docx') {
      // Extraire le texte du DOCX
      console.log('📄 Extraction du texte du DOCX...');
      try {
        const extractedText = await extractTextFromDOCX(arrayBuffer);
        if (!extractedText || extractedText.trim().length === 0) {
          throw new Error('Aucun texte extrait du DOCX');
        }
        return extractedText;
      } catch (error) {
        console.error('Erreur extraction DOCX:', error);
        throw new Error(`Impossible d'extraire le texte du DOCX: ${error instanceof Error ? error.message : 'Erreur inconnue'}. Veuillez convertir le DOCX en TXT manuellement.`);
      }
    } else {
      // Essayer de lire comme texte
      return new TextDecoder('utf-8').decode(arrayBuffer);
    }
  } catch (error) {
    console.error('❌ Erreur lecture fichier:', error);
    throw error;
  }
}

/**
 * Convertit le contenu JSON de la roadmap en texte pour l'analyse
 */
function convertRoadmapJSONToText(roadmapContent: any): string {
  try {
    // Si c'est déjà une string JSON, parser d'abord
    let roadmap: any;
    if (typeof roadmapContent === 'string') {
      roadmap = JSON.parse(roadmapContent);
    } else {
      roadmap = roadmapContent;
    }

    const textParts: string[] = [];

    // Extraire les informations du header
    if (roadmap.header) {
      if (roadmap.header.client_name) textParts.push(`Client: ${roadmap.header.client_name}`);
      if (roadmap.header.company_name) textParts.push(`Entreprise: ${roadmap.header.company_name}`);
      if (roadmap.header.address) textParts.push(`Adresse: ${roadmap.header.address}`);
      if (roadmap.header.financials) {
        textParts.push('Métriques financières:');
        Object.entries(roadmap.header.financials).forEach(([key, value]) => {
          textParts.push(`  ${key}: ${value}`);
        });
      }
    }

    // Extraire la vision et les piliers stratégiques
    if (roadmap.vision) {
      textParts.push('\n=== VISION ET PILIERS STRATÉGIQUES ===\n');
      
      if (roadmap.vision.structure) {
        textParts.push('STRUCTURE & OPÉRATIONS:');
        if (roadmap.vision.structure.current_situation) {
          textParts.push(`Situation actuelle: ${roadmap.vision.structure.current_situation}`);
        }
        if (roadmap.vision.structure.actions) {
          textParts.push(`Actions: ${roadmap.vision.structure.actions}`);
        }
        if (roadmap.vision.structure.expert_suggestion) {
          textParts.push(`Suggestion expert: ${roadmap.vision.structure.expert_suggestion}`);
        }
      }

      if (roadmap.vision.acquisition) {
        textParts.push('\nACQUISITION & VENTE:');
        if (roadmap.vision.acquisition.current_situation) {
          textParts.push(`Situation actuelle: ${roadmap.vision.acquisition.current_situation}`);
        }
        if (roadmap.vision.acquisition.actions) {
          textParts.push(`Actions: ${roadmap.vision.acquisition.actions}`);
        }
        if (roadmap.vision.acquisition.expert_suggestion) {
          textParts.push(`Suggestion expert: ${roadmap.vision.acquisition.expert_suggestion}`);
        }
      }

      if (roadmap.vision.vision_pilotage) {
        textParts.push('\nVISION & PILOTAGE:');
        if (roadmap.vision.vision_pilotage.current_situation) {
          textParts.push(`Situation actuelle: ${roadmap.vision.vision_pilotage.current_situation}`);
        }
        if (roadmap.vision.vision_pilotage.actions) {
          textParts.push(`Actions: ${roadmap.vision.vision_pilotage.actions}`);
        }
        if (roadmap.vision.vision_pilotage.expert_suggestion) {
          textParts.push(`Suggestion expert: ${roadmap.vision.vision_pilotage.expert_suggestion}`);
        }
      }
    }

    // Extraire le plan mensuel
    if (roadmap.monthly_plan) {
      textParts.push('\n=== PLAN MENSUEL ===\n');
      
      for (let month = 1; month <= 4; month++) {
        const monthKey = `month_${month}`;
        const monthData = roadmap.monthly_plan[monthKey];
        
        if (monthData) {
          textParts.push(`\nMOIS ${month}:`);
          if (monthData.objective) {
            textParts.push(`Objectif: ${monthData.objective}`);
          }
          if (monthData.kpi) {
            textParts.push(`KPIs: ${monthData.kpi}`);
          }
          
          for (let week = 1; week <= 4; week++) {
            const weekKey = `week_${week}`;
            const weekNumber = (month - 1) * 4 + week;
            if (monthData[weekKey]) {
              textParts.push(`\nSemaine ${weekNumber}: ${monthData[weekKey]}`);
            }
          }
        }
      }
    }

    // Extraire les objectifs stratégiques
    if (roadmap.strategic_goals) {
      textParts.push('\n=== OBJECTIFS STRATÉGIQUES ===\n');
      if (roadmap.strategic_goals.goals_4_months) {
        textParts.push(`Objectifs 4 mois: ${roadmap.strategic_goals.goals_4_months}`);
      }
      if (roadmap.strategic_goals.goals_12_months) {
        textParts.push(`Objectifs 12 mois: ${roadmap.strategic_goals.goals_12_months}`);
      }
    }

    const fullText = textParts.join('\n');
    console.log(`✅ Roadmap JSON convertie en texte: ${fullText.length} caractères`);
    return fullText;
  } catch (error) {
    console.error('❌ Erreur conversion roadmap JSON:', error);
    throw new Error(`Impossible de convertir la roadmap JSON en texte: ${error instanceof Error ? error.message : 'Erreur inconnue'}`);
  }
}

/**
 * Analyse un PDF directement avec l'API d'OpenAI
 * Pour les PDFs, on extrait d'abord le texte puis on l'analyse
 */
async function analyzePDFWithChatGPT(fileUrl: string): Promise<RoadmapExtraction> {
  // Pour les PDFs, on extrait le texte d'abord puis on l'analyse normalement
  const fileContent = await readFileContent(fileUrl);
  return await analyzeWithChatGPT(fileContent);
}

/**
 * Analyse le contenu avec ChatGPT pour extraire les informations de roadmap
 */
async function analyzeWithChatGPT(content: string): Promise<RoadmapExtraction> {
  // Vérifier que le contenu n'est pas vide
  if (!content || content.trim().length === 0) {
    throw new Error('Le contenu du document est vide. Impossible d\'analyser.');
  }
  
  console.log(`📊 Longueur du contenu à analyser: ${content.length} caractères`);
  console.log(`📄 Aperçu du contenu (premiers 500 caractères): ${content.substring(0, 500)}`);
  
  const contentToAnalyze = content.substring(0, 20000);
  const isTruncated = content.length > 20000;
  
  const prompt = `Tu es un assistant expert en coaching et gestion de projet. Ton rôle est d'analyser un document et d'extraire TOUTES les informations pertinentes pour créer une roadmap de coaching sur 16 semaines.

DOCUMENT À ANALYSER:
${contentToAnalyze}${isTruncated ? '\n\n... (document tronqué, mais analyse quand même le contenu disponible)' : ''}

INSTRUCTIONS CRITIQUES:
1. Analyse TOUT le contenu du document de manière exhaustive, ligne par ligne
2. Extrais TOUTES les tâches, actions, objectifs, étapes, milestones, activités mentionnés - MÊME ceux qui semblent mineurs
3. Identifie TOUTES les semaines mentionnées (1 à 16) - ne manque AUCUNE semaine, y compris la semaine 8
4. Si une semaine est mentionnée (ex: "semaine 8", "S8", "week 8", "mois 2 semaine 4"), assigne la tâche à cette semaine
5. Si aucune semaine n'est mentionnée, répartis les tâches de manière logique et équilibrée sur les 16 semaines en respectant l'ordre chronologique et les dépendances
6. Chaque tâche DOIT avoir un titre SIMPLE, CLAIR et CONCIS - UNE SEULE PHRASE COURTE (maximum 10-12 mots, jamais de liste à puces, jamais de phrases multiples)
7. Le titre doit être actionnable et direct (ex: "Lancer les campagnes Facebook Ads" et NON "Lancer les campagnes Facebook Ads et Google Ads avec un budget test ciblé localement")
8. Identifie le pilier stratégique pour chaque tâche (voir ci-dessous)
9. Extrais aussi les notes, commentaires, observations importantes pour chaque semaine

LES 3 PILIERS STRATÉGIQUES:
- "structure" : Structure & Opérations (organisation, processus, productivité, procédures, opérations, efficacité)
- "acquisition" : Acquisition & Vente (marketing, vente, acquisition clients, tunnel de vente, conversion, prospects)
- "vision" : Vision & Pilotage (vision, stratégie, KPIs, métriques, pilotage, décision, direction)

FORMAT DE RÉPONSE (JSON uniquement, sans texte avant ou après):
{
  "tasks": [
    {
      "title": "Titre SIMPLE et COURT en UNE SEULE PHRASE (maximum 10-12 mots, jamais de liste, jamais de phrases multiples) - OBLIGATOIRE, jamais vide",
      "description": "Description détaillée si disponible (peut contenir les détails supplémentaires)",
      "week_number": 1-16 (OBLIGATOIRE - si mentionné dans le document, utilise cette valeur exacte, sinon répartis logiquement),
      "priority": "low" | "medium" | "high" (déduis de l'importance dans le document),
      "status": "pending" (par défaut),
      "pillar": "structure" | "acquisition" | "vision" (OBLIGATOIRE - identifie le pilier pour chaque tâche)
    }
  ],
  "notes": [
    {
      "week_number": 1-16,
      "comment": "Note, observation ou commentaire important pour cette semaine"
    }
  ],
  "summary": "Résumé concis des objectifs principaux et de la vision du document"
}

RÈGLES STRICTES POUR LES TITRES:
- Chaque titre DOIT être UNE SEULE PHRASE COURTE (maximum 10-12 mots)
- Chaque titre DOIT être simple, clair et direct
- JAMAIS de listes à puces dans le titre (utilise la description pour les détails)
- JAMAIS de phrases multiples séparées par des virgules ou "et"
- JAMAIS de titres trop longs ou complexes
- Exemples de BONS titres: "Lancer les campagnes Facebook Ads", "Recruter des étudiants", "Finaliser le tunnel de vente"
- Exemples de MAUVAIS titres: "Lancer les campagnes Facebook Ads et Google Ads avec un budget test ciblé localement", "Recruter des étudiants - salle, bar, runner, plonge", "Finaliser avec Lucas la mise en place du tunnel de vente et lancer les premières campagnes"

RÈGLES STRICTES GÉNÉRALES:
- Chaque tâche DOIT avoir un "title" non vide, simple et court (UNE SEULE PHRASE)
- Chaque tâche DOIT avoir un "week_number" entre 1 et 16
- Chaque tâche DOIT avoir un "pillar" (structure, acquisition, ou vision)
- Si le document mentionne explicitement une semaine (ex: "semaine 8", "S8", "week 8"), utilise cette valeur exacte
- Répartis les tâches sur TOUTES les semaines (1-16) de manière équilibrée si aucune semaine n'est mentionnée
- Ne regroupe pas toutes les tâches sur les mêmes semaines - répartis-les sur les 16 semaines
- Extrais TOUTES les tâches, même celles qui semblent mineures ou secondaires
- Si une section du document parle de "semaine 8" ou "mois 2 semaine 4", extrais TOUTES les tâches de cette section avec week_number = 8
- Si une action contient plusieurs sous-actions, crée UNE tâche par sous-action avec un titre simple pour chacune

EXEMPLES DE CE QUI DOIT ÊTRE EXTRAIT:
- Objectifs, buts, cibles
- Tâches, actions, étapes, activités
- Dates, deadlines, échéances
- Semaines mentionnées explicitement (semaine 1, S2, week 3, mois 1 semaine 2, etc.)
- Priorités, urgences
- Notes, commentaires, observations
- KPIs, métriques, indicateurs
- Blocages, risques, challenges
- Actions concrètes, livrables, résultats attendus

IMPORTANT: 
- Analyse le document de manière exhaustive - ne manque AUCUNE tâche
- Si le document mentionne la semaine 8, extrais TOUTES les tâches de cette semaine
- Chaque tâche doit avoir un titre unique et spécifique
- Répartis les tâches sur les 16 semaines de manière logique et équilibrée
- Ne retourne jamais un tableau vide sans avoir vraiment analysé TOUT le contenu`;

  try {
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
            content: 'Tu es un assistant expert qui extrait des informations structurées de documents pour créer des roadmaps de coaching. Tu DOIS extraire toutes les informations pertinentes, même si elles ne sont pas explicitement mentionnées comme "tâches". CRITIQUE: Chaque titre de tâche DOIT être UNE SEULE PHRASE COURTE et SIMPLE (maximum 10-12 mots). JAMAIS de listes, JAMAIS de phrases multiples. Si une action contient plusieurs sous-actions, crée une tâche séparée pour chacune avec un titre simple. Tu réponds UNIQUEMENT avec du JSON valide, sans texte supplémentaire. Ne retourne jamais un tableau vide sans avoir vraiment analysé le contenu.',
          },
          {
            role: 'user',
            content: prompt,
          },
        ],
        temperature: 0.5,
        max_tokens: 4000,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Erreur OpenAI API: ${error}`);
    }

    const data = await response.json();
    let content = data.choices[0]?.message?.content || '{}';
    
    console.log('Réponse brute de ChatGPT:', content.substring(0, 500));
    
    // Nettoyer le contenu pour extraire uniquement le JSON
    let jsonContent = content.trim();
    // Enlever les markdown code blocks si présents
    if (jsonContent.startsWith('```')) {
      jsonContent = jsonContent.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '');
    }
    
    // Essayer de trouver le JSON même s'il y a du texte avant/après
    const jsonMatch = jsonContent.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      jsonContent = jsonMatch[0];
    }
    
    let extraction: RoadmapExtraction;
    try {
      extraction = JSON.parse(jsonContent);
    } catch (parseError) {
      console.error('Erreur parsing JSON:', parseError);
      console.error('Contenu à parser:', jsonContent);
      throw new Error('Impossible de parser la réponse de ChatGPT. Le format JSON est invalide.');
    }
    
    // Vérifier que l'extraction contient au moins quelques informations
    if ((!extraction.tasks || extraction.tasks.length === 0) && 
        (!extraction.notes || extraction.notes.length === 0) && 
        !extraction.summary) {
      console.warn('Aucune information extraite, le document pourrait être vide ou non pertinent');
      // Retourner quand même une structure vide plutôt que de lancer une erreur
      return {
        tasks: [],
        notes: [],
        summary: 'Aucune information pertinente pour une roadmap de coaching n\'a été extraite du document. Veuillez vérifier que le document contient des informations actionnables.',
      };
    }
    
    return extraction;
  } catch (error) {
    console.error('Erreur analyse ChatGPT:', error);
    throw error;
  }
}

serve(async (req) => {
  // CORS headers
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  };

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method === 'POST') {
    try {
      const payload: AnalyzeRoadmapPayload = await req.json();

      if (!OPENAI_API_KEY) {
        return new Response(
          JSON.stringify({ error: 'OPENAI_API_KEY non configurée' }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      let fileContent: string;

      // Nouveau: Si roadmap_content est fourni, utiliser ce contenu JSON
      if (payload.roadmap_content && payload.content_type === 'json') {
        console.log('📄 Analyse d\'une roadmap JSON fournie directement');
        fileContent = convertRoadmapJSONToText(payload.roadmap_content);
      } else if (payload.file_url) {
        // Ancien comportement: lire depuis un fichier
        console.log('📄 Lecture du fichier:', payload.file_url);
        fileContent = await readFileContent(payload.file_url);
      } else {
        return new Response(
          JSON.stringify({ error: 'file_url ou roadmap_content requis' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
      
      // Vérifier que le contenu a bien été extrait
      if (!fileContent || fileContent.trim().length === 0) {
        throw new Error('Le fichier est vide ou aucun contenu n\'a pu être extrait. Vérifiez que le fichier contient du texte.');
      }
      
      console.log(`✅ Contenu extrait: ${fileContent.length} caractères`);
      console.log(`📄 Aperçu: ${fileContent.substring(0, 300)}...`);
      
      // Analyser avec ChatGPT
      console.log('🤖 Analyse avec ChatGPT...');
      const extraction = await analyzeWithChatGPT(fileContent);

      return new Response(
        JSON.stringify({
          success: true,
          extraction,
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    } catch (error) {
      console.error('❌ Erreur:', error);
      return new Response(
        JSON.stringify({
          error: error instanceof Error ? error.message : 'Erreur inconnue',
        }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
  }

  return new Response(
    JSON.stringify({ error: 'Méthode non autorisée' }),
    { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  );
});

# Dossier de soumission du plugin « EOR Scope »

Rien n'est soumis ni publié par ce dossier. Règles lues à la source le 09/10/2026 :
`developers.openai.com/apps-sdk/deploy/submission`, `/plugins/plugin-guidelines`, `/plugins/deploy/submission-errors`.

## Contenu

| Fichier | Rôle |
|---|---|
| `plugin/plugin.json` | Manifeste Agent Plugins : fiche (`extensions.com.openai.interface`), 5 cas positifs + 3 négatifs (`review.test_cases`), `publication.countries: []` (= aucune restriction de pays, tous les pays autorisés), notes de version |
| `plugin/mcp.json` | Un seul serveur : `eorscope`, streamable-http, `https://mcp.eorscope.com/mcp` |
| `plugin/assets/logo.png` | Icône 128 × 128 (`research/brand/eorscope-icon-128.png`), sert de `logo` et de `composerIcon` |
| `../public/privacy.html`, `terms.html`, `support.html` | Pages publiques exigées, servies par `mcp.eorscope.com` (noindex) |
| `../scripts/package-submission.mjs` | `npm run package:submission` : valide les règles de soumission finale + fait-vérification (76 pays = `data/snapshot.json`, URL MCP = `server.json` → `remotes`), écrit `submission/dist/eorscope-1.0.0.zip` et le relit |

Catégorie retenue : **Finance** (liste officielle : Productivity, Creativity, Developer Tools, Business & Operations, Data & Analytics, Communication, Education & Research, Security, Finance, Healthcare, Travel, Entertainment, Other). Alternative défendable : « Business & Operations ».

## À trancher par l'owner avant l'envoi

1. **developerName / author.name** = « Les Créavores » (nom commercial de la page légale : Trésor Kaya, EI, SIREN 521 464 644). L'annuaire affiche de toute façon le nom de l'identité vérifiée choisie au dépôt ; il doit correspondre à l'éditeur nommé sur les pages privacy/terms (« Public URLs must … identify the same publisher »).
2. **Vidéo** : `review.demo_recording_url` est vide. Le script l'omet du ZIP (une chaîne vide effacerait la valeur saisie dans le tableau de bord). Soit la renseigner dans `plugin.json` puis relancer `npm run package:submission`, soit la saisir dans **Review details**. Elle doit montrer les 5 cas positifs et les deux widgets.

## Étapes côté owner (dans l'ordre)

0. **Déployer d'abord** (fait par la session, pas par ce dossier) : les 3 pages, le `Content-Type: text/plain` de `/.well-known/openai-apps-challenge` (vercel.json) et le nouveau `MCP_PUBLIC_ORIGIN` par défaut (`https://mcp.eorscope.com`) ne sont pas encore en ligne. Vérifier que `https://mcp.eorscope.com/privacy.html`, `/terms.html`, `/support.html` répondent 200.
1. **Identité** : platform.openai.com → Settings → Organization → General → vérification individuelle (ou entreprise). Sans elle, pas de dépôt. Le rôle « Apps Management Write » suffit si quelqu'un d'autre que le propriétaire de l'organisation dépose.
2. **Upload** : platform.openai.com/plugins → *Upload new or existing plugin* → choisir l'identité vérifiée → *Upload plugin* → `submission/dist/eorscope-1.0.0.zip`.
3. **Metadata & Skills** : attendre les contrôles, *Copy issues* s'il y en a, me les transmettre ; corriger, reconditionner, re-téléverser.
4. **MCPs → Connect** : URL `https://mcp.eorscope.com/mcp`, authentification « aucune ». Le portail affiche un **jeton de vérification de domaine** : **me le transmettre tel quel**. Je l'écris seul (texte brut, sans JSON) dans `public/.well-known/openai-apps-challenge` et je déploie ; le portail le lira sur `https://mcp.eorscope.com/.well-known/openai-apps-challenge`. Puis *Connect*, attendre le scan des 14 outils, lire *Issues*.
5. **Justification des annotations** (demandée pour chaque outil) : les 14 outils ont `readOnlyHint: true` (ils calculent à partir du jeu de données embarqué, n'écrivent rien), `destructiveHint: false` (aucune suppression, aucun envoi, aucune transaction), `openWorldHint: false` (aucun appel à un service tiers ; les liens rendus pointent vers des pages informatives d'eorscope.com).
6. **Review details** : vérifier les cas importés (lecture seule), la vidéo ; pas d'identifiants de test (pas de connexion).
7. **Submit for review** : cocher les attestations de politique (à lire par l'owner, je ne les coche pas). Retours par e-mail ; puis **Publish plugin** quand l'owner le décide.

## Annuaire de connecteurs Claude (équivalences)

Le formulaire d'Anthropic n'a pas pu être relu le 09/10 (page rendue en JavaScript) : **champs à confirmer sur le formulaire au moment du dépôt**. Correspondances à reprendre depuis `plugin.json` :

| Champ probable côté Claude | Valeur |
|---|---|
| Nom | EOR Scope |
| URL du serveur MCP distant | `https://mcp.eorscope.com/mcp` (streamable HTTP, sans authentification) — aussi dans `server.json` → `remotes` (registre MCP officiel, non publié) |
| Accroche / description courte | `shortDescription` (« Employer cost by country ») |
| Description | `longDescription` |
| Catégorie | celle du formulaire la plus proche de Finance |
| Politique de confidentialité / CGU / support | `https://mcp.eorscope.com/privacy.html` / `terms.html` / `support.html` |
| Contact | research@eorscope.com |
| Exemples de requêtes | `defaultPrompt` (3) + les 5 cas positifs |
| Logo | `plugin/assets/logo.png` |
| Annotations d'outils | déjà exposées par le serveur (titre + `readOnlyHint` / `destructiveHint` / `openWorldHint` explicites) |
| Compte de test | aucun (pas de connexion) |

## Commandes

```bash
export PATH="/c/tmp/node-v22.23.2-win-x64:$PATH"
npm run build && npm test && npm run package:submission
```

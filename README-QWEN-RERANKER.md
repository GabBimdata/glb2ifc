# Qwen IFC Reranker — setup fluide, sans Ollama

Cette V5 garde le principe : tu lances le projet avec une seule commande.

```bash
bun dev
```

Le serveur glb2ifc démarre sur `http://localhost:3737` et tente de démarrer automatiquement `llama-server` sur `http://127.0.0.1:8081` si un modèle GGUF est présent.

Le modèle ne modifie jamais l'IFC tout seul. Il score des candidats, puis tu valides dans le viewer.

## Installation rapide sur Linux

### CPU

```bash
bun run qwen:setup
bun dev
```

### NVIDIA / CUDA

```bash
bun run qwen:setup:cuda
bun dev
```

Le script clone/build `llama.cpp` dans :

```txt
.tools/llama.cpp
```

Puis il écrit automatiquement :

```txt
.env.local
```

avec le chemin de `llama-server`. Tu n'as donc plus besoin d'exporter `QWEN_LLAMA_SERVER_BIN` à la main.

### Vulkan

```bash
bun run qwen:setup:vulkan
bun dev
```

## Modèle GGUF

Le modèle n'est pas inclus dans le zip. Place ton GGUF dans :

```txt
models/
```

La V5 détecte maintenant automatiquement les noms courants, par exemple :

```txt
models/Qwen3-Reranker-0.6B-Q4_K_M.gguf
models/qwen3-reranker-0.6b-q4_k_m.gguf
models/mon-qwen3-reranker.gguf
```

S'il y a un seul `.gguf` dans `models/`, il est utilisé automatiquement.

## Utilisation

```txt
Viewer IFC
  → Mode édition
  → sélectionner un élément
  → bouton "✨ Suggérer avec Qwen"
  → top 3 classes IFC candidates
  → clic "Appliquer"
```

## Vérifier l'état

Pendant que le projet tourne :

```bash
bun run qwen:status
```

Ou directement :

```txt
http://localhost:3737/api/qwen-status
```

Le JSON indique notamment :

```txt
status            ready / starting / missing_model / failed / disabled
llamaServerBin    chemin détecté vers llama-server
gpuLayers         auto / 99 / null
modelPath         modèle GGUF détecté
lastError         dernier problème éventuel
lastLog           dernières lignes de llama-server
```

## Variables utiles

Tu peux les mettre dans `.env.local` ou les passer avant `bun dev`.

```bash
# Désactiver Qwen et garder seulement le fallback heuristique
QWEN_AUTO_START=0 bun dev

# Forcer un modèle précis
QWEN_MODEL_PATH=./models/mon-modele.gguf bun dev

# Forcer le binaire llama-server
QWEN_LLAMA_SERVER_BIN=/chemin/vers/llama-server bun dev

# GPU offload
QWEN_GPU_LAYERS=auto bun dev
QWEN_GPU_LAYERS=99 bun dev

# Laisser plus de temps à un vieux laptop
QWEN_RERANK_TIMEOUT_MS=180000 bun dev
QWEN_STARTUP_TIMEOUT_MS=180000 bun dev

# Utiliser un llama-server externe déjà lancé ailleurs
QWEN_RERANKER_URL=http://127.0.0.1:8081/v1/rerank bun dev
```

## Ce qui est automatisé en V5

```txt
- lecture automatique de .env et .env.local
- auto-détection de llama-server dans :
  .tools/llama.cpp/build/bin/llama-server
  ../llama.cpp/build/bin/llama-server
  $PATH
- auto-détection du modèle dans ./models
- timeouts plus longs par défaut pour les machines lentes
- attente du /health de llama-server avant la première requête
- option QWEN_GPU_LAYERS=auto
```

## Fallback

Si le modèle manque, si `llama-server` n'est pas compilé, ou si Qwen met trop longtemps à répondre, le viewer reste utilisable : il renvoie des suggestions heuristiques locales.

## Changement V6 — ne plus proposer `IFCBUILDINGELEMENTPROXY`

Par défaut, le reranker n'utilise plus `IFCBUILDINGELEMENTPROXY` comme classe cible.

Le type courant peut toujours être `IFCBUILDINGELEMENTPROXY` dans le JSON envoyé au reranker, parce que c'est un signal utile : cela signifie que l'objet est encore non résolu. En revanche, `IFCBUILDINGELEMENTPROXY` est retiré de la liste des candidats et des suggestions finales.

Objectif : quand tu sélectionnes un proxy, Qwen doit proposer une vraie famille IFC (`IFCWALL`, `IFCSLAB`, `IFCDOOR`, `IFCWINDOW`, etc.), pas te répondre de rester en proxy.

Si tu veux réactiver l'ancien comportement pour debug :

```bash
QWEN_ALLOW_PROXY_TARGET=1 bun dev
```


## V7 — pool de candidats complet

Le viewer demande maintenant jusqu’à 80 candidats IFC au reranker au lieu de 32.

Pourquoi 80 et pas 150 ? Le catalogue actuel contient 84 entrées :

- 79 types `standard` réécrivables par remplacement d’entité + `PredefinedType` ;
- 2 types `opening` (`IFCDOOR`, `IFCWINDOW`) qui nécessitent largeur/hauteur ;
- 3 types `unsupported` (`IFCSPACE`, `IFCZONE`, `IFCBUILDINGSTOREY`) ;
- `IFCBUILDINGELEMENTPROXY` est exclu par défaut comme cible Qwen.

Donc, en V7, Qwen peut scorer environ 80 cibles réelles par défaut. Les classes IFC absentes du catalogue ne sont pas encore proposées, parce que le patcher ne sait pas garantir leur round-trip STEP-21 proprement.

Pour les ajouter proprement, il faudra une phase dédiée :

1. élargir `src/ifc-catalog.js` avec des classes IFC supplémentaires ;
2. distinguer `suggest-only` et `apply-supported` ;
3. ajouter les règles de réécriture STEP-21 pour les familles qui n’ont pas la signature standard à 9 attributs.

## V9 axes fix

The Qwen feature extractor now reads generated IFC geometry as Z-up and normalizes it back to the internal Y-up convention used by the classifier. This prevents columns or vertical members from being described to the reranker as flat horizontal slabs. See `README-RERANKER-AXES.md`.

## Batch size / token error

If you see:

```txt
input (... tokens) is too large to process. increase the physical batch size
```

V10 starts `llama-server` with `--batch-size 1024` by default. You can override it in `.env.local`:

```env
QWEN_LLAMA_BATCH=2048
```

See `README-RERANKER-BATCH.md` for details.

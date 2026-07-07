require('dotenv').config();
const fs = require('fs');
const path = require('path');
const http = require('http');
const axios = require('axios');
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');

// ============================================================
// 1. CONFIGURAÇÕES E VALIDAÇÃO INICIAL
// ============================================================

// Valida token do Discord ANTES de qualquer coisa
if (!process.env.DISCORD_TOKEN || process.env.DISCORD_TOKEN === 'seu_token_aqui') {
  console.error('❌ ERRO CRÍTICO: Token do Discord não definido ou inválido!');
  console.error('   Verifique o arquivo .env e a variável DISCORD_TOKEN.');
  console.error('   O bot será encerrado.');
  process.exit(1);
}

if (!process.env.STEAM_KEY) {
  console.warn('⚠️ Aviso: STEAM_KEY não definida. Funcionalidades da Steam podem não funcionar.');
}

const INTERVALO_VERIFICACAO = 15 * 1000;
const MAX_JOGOS_POR_USUARIO = 8;
const MAX_CONQUISTAS_POR_JOGO = 30;
const MAX_RETRIES = 3;
const RETRY_DELAY = 2000;
const REQUEST_TIMEOUT = 10000;
const BATCH_SIZE = 5;
const CLEANUP_INTERVAL = 3600000;

// ============================================================
// 2. RATE LIMITER
// ============================================================
class RateLimiter {
  constructor() {
    this.minDelay = 1500;
    this.lastRequest = 0;
  }

  async wait() {
    const now = Date.now();
    const timeToWait = Math.max(0, this.minDelay - (now - this.lastRequest));
    if (timeToWait > 0) {
      console.log(`⏳ Rate limiting: aguardando ${timeToWait}ms...`);
      await new Promise(resolve => setTimeout(resolve, timeToWait));
    }
    this.lastRequest = Date.now();
  }
}

const rateLimiter = new RateLimiter();

// ============================================================
// 3. CONSTANTES E MAPEAMENTOS
// ============================================================

const CHANNEL_NOTIFICACOES = process.env.CHANNEL_ID;
const CHANNEL_RANKING = "1523067407474757672";
const CHANNEL_CONQUISTAS = "1523080625802711150";
const CHANNEL_PROMOCOES = "1523668313094225961";
const DONO_ID = "336204841972137995";

// Mapeamento de nomes e Discord IDs (AJUSTE CONFORME SEUS MEMBROS)
const steamNames = {
  "76561198127320557": "Gardemi",
  "76561197967265286": "Marlon",
  "76561198446717315": "WoollySkills",
  "76561198110004039": "Venum",
  "76561198848231901": "Mosk"
};

const discordUsers = {
  "76561198127320557": "663789211152941065",
  "76561197967265286": "1022183877114069083",
  "76561198446717315": "479817686218702849",
  "76561198110004039": "336204841972137995",
  "76561198848231901": "499311499504910344"
};

// Ranking padrão
const rankingPadrao = {
  "76561198127320557": { nome: "Gardemi", jogos: 98, steamId: "76561198127320557", discordId: "663789211152941065" },
  "76561197967265286": { nome: "Marlon", jogos: 56, steamId: "76561197967265286", discordId: "1022183877114069083" },
  "76561198848231901": { nome: "Mosk", jogos: 15, steamId: "76561198848231901", discordId: "499311499504910344" },
  "76561198446717315": { nome: "WoollySkills", jogos: 11, steamId: "76561198446717315", discordId: "479817686218702849" },
  "76561198110004039": { nome: "Venum", jogos: 8, steamId: "76561198110004039", discordId: "336204841972137995" }
};

// Jogos incompatíveis com Family Sharing (resumido – adicione os seus)
const JOGOS_INCOMPATIVEIS = {
  33930: "Arma 2: Operation Arrowhead",
  107410: "Arma 3",
  // ... adicione todos os que você tinha
};

// ============================================================
// 4. BANCO DE DADOS
// ============================================================

const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || './data';
const DB_FILE = path.join(DATA_DIR, 'steam_family_db.json');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  console.log(`📁 Pasta ${DATA_DIR} criada!`);
}

function carregarDB() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const data = fs.readFileSync(DB_FILE, 'utf8');
      const parsed = JSON.parse(data);
      // Garante que todas as chaves existam
      const defaults = {
        conquistas: {},
        ranking: {},
        listaQuero: {},
        jogosNotificadosPermanentes: {},
        ultimaNotificacaoPromocao: {},
        ultimaMensagemRankingId: null,
        jogosSemConquistas: {},
        historicoJogos: {}
      };
      return { ...defaults, ...parsed };
    }
  } catch (error) {
    console.error('❌ Erro ao carregar banco:', error);
    if (fs.existsSync(DB_FILE)) {
      const backupPath = `${DB_FILE}.backup_${Date.now()}`;
      fs.copyFileSync(DB_FILE, backupPath);
      console.log(`💾 Backup salvo em: ${backupPath}`);
    }
  }
  return {
    conquistas: {},
    ranking: {},
    listaQuero: {},
    jogosNotificadosPermanentes: {},
    ultimaNotificacaoPromocao: {},
    ultimaMensagemRankingId: null,
    jogosSemConquistas: {},
    historicoJogos: {}
  };
}

function salvarDB(db) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
    console.log(`💾 Banco de dados salvo em: ${DB_FILE}`);
  } catch (error) {
    console.error('❌ Erro ao salvar banco:', error);
  }
}

let db = carregarDB();
let ranking = { ...db.ranking };
let previousGames = {};
let ultimaMensagemRankingId = db.ultimaMensagemRankingId || null;
let primeiraVerificacaoConcluida = false;

// ============================================================
// 5. CACHE E UTILITÁRIOS
// ============================================================
const gameNameCache = {};
const achievementNameCache = {};
const compatibilidadeCache = {};

// ============================================================
// 6. FUNÇÕES DE FETCH COM RETRY E RATE LIMIT
// ============================================================
async function fetchWithTimeout(url, timeout = REQUEST_TIMEOUT, retryCount = 0) {
  try {
    await rateLimiter.wait();
    console.log(`🌐 Fetch: ${url.substring(0, 80)}...`);

    const response = await axios.get(url, {
      timeout: timeout,
      headers: {
        'User-Agent': 'SteamFamilyBot/1.0',
        'Accept': 'application/json'
      },
      validateStatus: (status) => status < 500
    });

    if (response.status === 429 || response.status === 403) {
      console.warn(`⚠️ Rate limit (${response.status}), aguardando...`);
      const waitTime = RETRY_DELAY * (retryCount + 1) * 2;
      await new Promise(resolve => setTimeout(resolve, waitTime));
      if (retryCount < MAX_RETRIES) {
        return fetchWithTimeout(url, timeout, retryCount + 1);
      }
      throw new Error(`Rate limit excedido após ${MAX_RETRIES} tentativas`);
    }

    if (response.status >= 400) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    return response.data;
  } catch (error) {
    if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
      console.warn(`⚠️ Timeout, tentando novamente... (${retryCount + 1}/${MAX_RETRIES})`);
      if (retryCount < MAX_RETRIES) {
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY * (retryCount + 1)));
        return fetchWithTimeout(url, timeout, retryCount + 1);
      }
      throw new Error(`Timeout após ${MAX_RETRIES} tentativas`);
    }
    throw error;
  }
}

// ============================================================
// 7. FUNÇÕES DA STEAM API
// ============================================================
async function getGameDetails(appid) {
  if (gameNameCache[appid]) return gameNameCache[appid];
  try {
    const url = `https://store.steampowered.com/api/appdetails?appids=${appid}&l=portuguese`;
    const data = await fetchWithTimeout(url);
    if (data[appid]?.success) {
      const info = {
        name: data[appid].data.name,
        icon: data[appid].data.header_image || data[appid].data.capsule_image,
        timestamp: Date.now()
      };
      gameNameCache[appid] = info;
      return info;
    }
  } catch (error) {
    console.error(`❌ Erro ao buscar jogo ${appid}:`, error.message);
  }
  return { name: `Jogo ${appid}`, icon: null, timestamp: Date.now() };
}

// ... (aqui vão todas as outras funções Steam do código original: 
// getAchievements, getCurrentGame, verificarJogoFamilia, 
// verificarPrecoJogo, buscarJogoSteam, etc.)
// Para economizar espaço, mantenha as mesmas funções do seu código original,
// apenas substitua a chamada de fetch original por fetchWithTimeout.

// ============================================================
// 8. CLIENTE DISCORD
// ============================================================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// ============================================================
// 9. EVENTOS DO DISCORD (READY, INTERACTIONS, MESSAGES)
// ============================================================
client.once('ready', async () => {
  console.log(`✅ Bot online como ${client.user.tag}`);
  // ... (todo o código do ready, igual ao original)
});

// ... (todos os eventos de interação e mensagem, mantidos do original)

// ============================================================
// 10. HEALTH CHECK
// ============================================================
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      memory: {
        rss: Math.round(process.memoryUsage().rss / 1024 / 1024) + ' MB',
        heapUsed: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + ' MB'
      }
    }));
  } else {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot is running!');
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Health check rodando na porta ${PORT}`);
});

// ============================================================
// 11. TRATAMENTO DE SINAL (SALVA DB)
// ============================================================
process.on('SIGTERM', async () => {
  console.log('⚠️ Recebido SIGTERM, finalizando...');
  salvarDB(db);
  await client.destroy();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('⚠️ Recebido SIGINT, finalizando...');
  salvarDB(db);
  await client.destroy();
  process.exit(0);
});

// ============================================================
// 12. LOGIN (COM VALIDAÇÃO)
// ============================================================
console.log('🚀 Iniciando bot...');
client.login(process.env.DISCORD_TOKEN)
  .then(() => console.log('🔑 Login realizado com sucesso'))
  .catch(error => {
    console.error('❌ Erro ao fazer login:', error.message);
    if (error.code === 'TokenInvalid') {
      console.error('   O token fornecido é inválido. Verifique o arquivo .env');
      console.error('   Gere um novo token em: https://discord.com/developers/applications');
    }
    process.exit(1);
  });

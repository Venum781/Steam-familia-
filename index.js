require('dotenv').config();
const fs = require('fs');
const path = require('path');
const http = require('http');
const axios = require('axios');

const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');

// 🔹 CONFIGURAÇÕES
const INTERVALO_VERIFICACAO = 15 * 1000;
const MAX_JOGOS_POR_USUARIO = 8;
const MAX_CONQUISTAS_POR_JOGO = 30;
const MAX_RETRIES = 3;
const RETRY_DELAY = 2000;
const REQUEST_TIMEOUT = 10000;
const BATCH_SIZE = 5;
const CLEANUP_INTERVAL = 3600000; // 1 hora

// 🔹 Rate Limiter
class RateLimiter {
    constructor() {
        this.requests = {};
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

// 🔹 IDs dos canais
const CHANNEL_NOTIFICACOES = process.env.CHANNEL_ID;
const CHANNEL_RANKING = "1523067407474757672";
const CHANNEL_CONQUISTAS = "1523080625802711150";

// 🔹 ID do dono
const DONO_ID = "336204841972137995";

// 🔹 Banco de dados
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || '/data';
const DB_FILE = path.join(DATA_DIR, 'steam_achievements_db.json');

try {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        console.log(`📁 Pasta ${DATA_DIR} criada!`);
    } else {
        console.log(`✅ Usando volume persistente: ${DATA_DIR}`);
    }
} catch (error) {
    console.log(`ℹ️ Usando diretório local como fallback.`);
}

// 🔹 Cache
const compatibilidadeCache = {};
const gameNameCache = {};
const achievementNameCache = {};

// 🔹 Jogos incompatíveis
const JOGOS_INCOMPATIVEIS = {
    33930: "Arma 2: Operation Arrowhead",
    107410: "Arma 3",
    582660: "Black Desert",
    1097150: "Fall Guys",
    220240: "Far Cry 3",
    298110: "Far Cry 4",
    552520: "Far Cry 5",
    304390: "FOR HONOR",
    1546970: "Grand Theft Auto III – The Definitive Edition",
    12210: "Grand Theft Auto IV: The Complete Edition",
    3240220: "Grand Theft Auto V Enhanced",
    271590: "Grand Theft Auto V Legacy",
    1547000: "Grand Theft Auto: San Andreas – The Definitive Edition",
    1546990: "Grand Theft Auto: Vice City – The Definitive Edition",
    439700: "H1Z1: King of the Kill Test Server",
    269210: "Hero Siege",
    1426210: "It Takes Two",
    510190: "Lazarus",
    1392860: "Little Nightmares III",
    1328670: "Mass Effect Legendary Edition",
    204100: "Max Payne 3",
    555160: "Pavlov VR",
    2129530: "REANIMAL",
    1174180: "Red Dead Redemption 2",
    2215260: "Scott Pilgrim vs. The World: The Game – Complete Edition",
    488790: "South Park: The Fractured But Whole",
    2001120: "Split Fiction",
    1172380: "STAR WARS Jedi: Fallen Order",
    1774580: "STAR WARS Jedi: Survivor",
    1527280: "Starship Tunnel",
    470220: "UNO",
    447040: "Watch Dogs 2",
    1222700: "A Way Out"
};

// 🔹 Mapeamento
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

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

// 🔹 ============================================
// 🔹 FETCH COM AXIOS E RATE LIMITING
// 🔹 ============================================
async function fetchWithTimeout(url, timeout = REQUEST_TIMEOUT, retryCount = 0) {
    try {
        await rateLimiter.wait();
        
        console.log(`🌐 Fetch: ${url.substring(0, 100)}...`);
        
        const response = await axios.get(url, {
            timeout: timeout,
            headers: {
                'User-Agent': 'SteamFamilyBot/1.0',
                'Accept': 'application/json'
            },
            validateStatus: (status) => status < 500
        });
        
        const contentType = response.headers['content-type'] || '';
        if (contentType.includes('text/html')) {
            console.warn(`⚠️ Resposta HTML recebida (possível rate limit) - Status: ${response.status}`);
            throw new Error('HTML_RESPONSE');
        }
        
        if (response.status === 429 || response.status === 403) {
            console.warn(`⚠️ Rate limit detectado (${response.status}), aguardando...`);
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

// 🔹 ============================================
// 🔹 BANCO DE DADOS
// 🔹 ============================================
function carregarDB() {
    try {
        if (fs.existsSync(DB_FILE)) {
            const data = fs.readFileSync(DB_FILE, 'utf8');
            const parsed = JSON.parse(data);

            if (!parsed.ranking) parsed.ranking = {};
            if (!parsed.conquistas) parsed.conquistas = {};
            if (!parsed.jogosRecentes) parsed.jogosRecentes = {};
            if (!parsed.steamLinks) parsed.steamLinks = {};
            if (!parsed.listaQuero) parsed.listaQuero = {};
            if (!parsed.ultimaMensagemRankingId) parsed.ultimaMensagemRankingId = null;
            if (!parsed.jogosSemConquistas) parsed.jogosSemConquistas = {};
            if (!parsed.ultimoRankingEnviado) parsed.ultimoRankingEnviado = {};

            const totalJogos = Object.values(parsed.listaQuero).reduce((acc, arr) => acc + arr.length, 0);
            console.log(`📊 Banco de dados carregado: ${totalJogos} jogos na lista /quero`);
            console.log(`💾 Arquivo: ${DB_FILE}`);

            return parsed;
        }
    } catch (error) {
        console.error('❌ Erro ao carregar banco:', error);
        if (fs.existsSync(DB_FILE)) {
            const backupPath = `${DB_FILE}.backup_${Date.now()}`;
            fs.copyFileSync(DB_FILE, backupPath);
            console.log(`💾 Backup do banco corrompido salvo em: ${backupPath}`);
        }
    }

    console.log('📝 Criando novo banco de dados...');
    return {
        conquistas: {},
        jogosRecentes: {},
        ranking: {},
        steamLinks: {},
        listaQuero: {},
        ultimaMensagemRankingId: null,
        jogosSemConquistas: {},
        ultimoRankingEnviado: {}
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
if (!db.conquistas) db.conquistas = {};
if (!db.jogosRecentes) db.jogosRecentes = {};
if (!db.ranking) db.ranking = {};
if (!db.steamLinks) db.steamLinks = {};
if (!db.listaQuero) db.listaQuero = {};
if (!db.ultimaMensagemRankingId) db.ultimaMensagemRankingId = null;
if (!db.jogosSemConquistas) db.jogosSemConquistas = {};
if (!db.ultimoRankingEnviado) db.ultimoRankingEnviado = {};

// 🔹 RANKING
const rankingPadrao = {
    "76561198127320557": { nome: "Gardemi", jogos: 98, steamId: "76561198127320557", discordId: "663789211152941065" },
    "76561197967265286": { nome: "Marlon", jogos: 56, steamId: "76561197967265286", discordId: "1022183877114069083" },
    "76561198848231901": { nome: "Mosk", jogos: 15, steamId: "76561198848231901", discordId: "499311499504910344" },
    "76561198446717315": { nome: "WoollySkills", jogos: 11, steamId: "76561198446717315", discordId: "479817686218702849" },
    "76561198110004039": { nome: "Venum", jogos: 8, steamId: "76561198110004039", discordId: "336204841972137995" }
};

let ranking = {};

function carregarRanking() {
    if (db.ranking && Object.keys(db.ranking).length > 0) {
        console.log('📊 Carregando ranking do banco de dados...');
        ranking = db.ranking;
        for (const [steamId, dados] of Object.entries(rankingPadrao)) {
            if (!ranking[steamId]) {
                ranking[steamId] = dados;
                console.log(`📊 Adicionando novo usuário ao ranking: ${dados.nome}`);
            }
        }
        console.log(`📊 Ranking carregado do banco de dados: ${Object.keys(ranking).length} usuários`);
        return;
    }

    console.log('📊 Nenhum ranking salvo encontrado. Usando valores padrão...');
    ranking = JSON.parse(JSON.stringify(rankingPadrao));
    db.ranking = ranking;
    salvarDB(db);
}

let previousGames = {};
let ultimaMensagemRankingId = null;
let primeiraVerificacaoConcluida = false;
let debounceRanking = false;

// 🔹 ============================================
// 🔹 FUNÇÕES AUXILIARES
// 🔹 ============================================
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

async function getAchievementName(steamId, appid, apiname) {
    const cacheKey = `${appid}_${apiname}`;
    if (achievementNameCache[cacheKey]) return achievementNameCache[cacheKey];
    try {
        const url = `https://api.steampowered.com/ISteamUserStats/GetSchemaForGame/v2/?key=${process.env.STEAM_KEY}&appid=${appid}&l=portuguese`;
        const data = await fetchWithTimeout(url);
        if (data.game?.availableGameStats?.achievements) {
            const achievement = data.game.availableGameStats.achievements.find(a => a.name === apiname);
            if (achievement) {
                const nome = achievement.displayName || achievement.name;
                achievementNameCache[cacheKey] = nome;
                return nome;
            }
        }
    } catch (error) {
        console.error(`❌ Erro ao buscar nome da conquista:`, error.message);
    }
    return apiname;
}

async function getAchievements(steamId, appid) {
    try {
        const url = `https://api.steampowered.com/ISteamUserStats/GetPlayerAchievements/v1/?key=${process.env.STEAM_KEY}&steamid=${steamId}&appid=${appid}`;
        const data = await fetchWithTimeout(url, 8000);
        if (data.playerstats?.achievements) {
            return data.playerstats.achievements;
        }
        return [];
    } catch (error) {
        if (error.message && error.message.includes('HTTP 400')) {
            throw error;
        }
        console.error(`❌ Erro ao buscar conquistas ${appid}:`, error.message);
        return [];
    }
}

async function buscarIconeConquista(appid, apiname) {
    try {
        const url = `https://api.steampowered.com/ISteamUserStats/GetSchemaForGame/v2/?key=${process.env.STEAM_KEY}&appid=${appid}&l=portuguese`;
        const data = await fetchWithTimeout(url, 8000);

        if (data.game?.availableGameStats?.achievements) {
            const achievement = data.game.availableGameStats.achievements.find(a => a.name === apiname);
            if (achievement && achievement.icon) {
                return achievement.icon;
            }
        }
        return null;
    } catch (error) {
        console.error(`❌ Erro ao buscar ícone da conquista:`, error.message);
        return null;
    }
}

async function getCurrentGame(steamId) {
    try {
        const url = `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${process.env.STEAM_KEY}&steamids=${steamId}`;
        const data = await fetchWithTimeout(url, 8000);
        if (data.response?.players?.[0]?.gameid) {
            return {
                gameid: parseInt(data.response.players[0].gameid),
                gameextrainfo: data.response.players[0].gameextrainfo || `Jogo ${data.response.players[0].gameid}`
            };
        }
    } catch (error) {
        console.error(`❌ Erro ao buscar jogo atual:`, error.message);
    }
    return null;
}

function extrairAppIdDaUrl(url) {
    try {
        const match = url.match(/store\.steampowered\.com\/app\/(\d+)/);
        if (match) {
            return parseInt(match[1]);
        }
        return null;
    } catch (error) {
        console.error('❌ Erro ao extrair AppID:', error);
        return null;
    }
}

async function buscarJogoPorAppId(appid) {
    try {
        const url = `https://store.steampowered.com/api/appdetails?appids=${appid}&l=portuguese`;
        const data = await fetchWithTimeout(url, 8000);

        if (data[appid]?.success) {
            const gameData = data[appid].data;
            return {
                appid: appid,
                nome: gameData.name,
                url: `https://store.steampowered.com/app/${appid}`,
                capa: gameData.header_image || gameData.capsule_image || `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/header.jpg`
            };
        }
        return null;
    } catch (error) {
        console.error(`❌ Erro ao buscar jogo por AppID ${appid}:`, error.message);
        return null;
    }
}

async function buscarJogoSteam(nomeJogo) {
    try {
        const url = `https://store.steampowered.com/api/storesearch?term=${encodeURIComponent(nomeJogo)}&l=portuguese&cc=BR`;
        const data = await fetchWithTimeout(url, 8000);

        if (data.items && data.items.length > 0) {
            const jogo = data.items.find(item => item.type === 'game') || data.items[0];
            return {
                appid: jogo.id,
                nome: jogo.name,
                url: `https://store.steampowered.com/app/${jogo.id}`,
                capa: jogo.tiny_image || `https://cdn.cloudflare.steamstatic.com/steam/apps/${jogo.id}/header.jpg`
            };
        }
        return null;
    } catch (error) {
        console.error('❌ Erro ao buscar jogo:', error);
        return null;
    }
}

async function verificarJogoFamilia(appid) {
    const donos = [];
    const steamIds = process.env.STEAM_IDS.split(',').map(id => id.trim());
    const apiKey = process.env.STEAM_KEY;

    for (const steamId of steamIds) {
        try {
            const url = `https://api.steampowered.com/IPlayerService/GetOwnedGames/v0001/?key=${apiKey}&steamid=${steamId}&include_appinfo=true&include_played_free_games=true&format=json`;
            const data = await fetchWithTimeout(url, 8000);

            if (data.response?.games) {
                const temJogo = data.response.games.some(g => g.appid === appid);
                if (temJogo) {
                    const userName = steamNames[steamId] || `Usuário ${steamId.substring(0, 8)}`;
                    const discordId = discordUsers[steamId] || null;
                    donos.push({ steamId, nome: userName, discordId });
                }
            }
        } catch (error) {
            console.error(`❌ Erro ao verificar ${steamId}:`, error.message);
        }
    }

    return donos;
}

async function verificarPrecoJogo(appid) {
    try {
        const url = `https://store.steampowered.com/api/appdetails?appids=${appid}&cc=br`;
        const data = await fetchWithTimeout(url, 8000);

        if (!data[appid]?.success) return null;

        const gameData = data[appid].data;
        const priceData = gameData.price_overview;

        if (!priceData) return null;

        return {
            nome: gameData.name,
            appid: appid,
            link: `https://store.steampowered.com/app/${appid}`,
            precoAtual: priceData.final_formatted,
            precoAntigo: priceData.initial_formatted,
            emPromocao: priceData.final < priceData.initial,
            desconto: priceData.discount_percent || 0
        };
    } catch (error) {
        console.error(`❌ Erro ao verificar preço do jogo ${appid}:`, error.message);
        return null;
    }
}

async function verificarDisponibilidadeJogo(appid) {
    try {
        const url = `https://store.steampowered.com/api/appdetails?appids=${appid}&l=portuguese`;
        const data = await fetchWithTimeout(url, 8000);

        if (!data[appid]?.success) return null;

        const gameData = data[appid].data;
        const releaseDate = gameData.release_date;

        const jaFoiLancado = releaseDate?.coming_soon === false;
        const aindaNaoLancado = releaseDate?.coming_soon === true;
        const temPreco = gameData.price_overview && gameData.price_overview.final > 0;
        const isPreVenda = aindaNaoLancado && temPreco;
        const isDisponivel = jaFoiLancado && temPreco;

        return {
            nome: gameData.name,
            disponivel: isDisponivel,
            preVenda: isPreVenda,
            dataLancamento: releaseDate?.date || 'Data desconhecida',
            emPromocao: gameData.price_overview?.final < gameData.price_overview?.initial || false,
            link: `https://store.steampowered.com/app/${appid}`,
            temPreco: temPreco,
            aindaNaoLancado: aindaNaoLancado
        };
    } catch (error) {
        console.error(`❌ Erro ao verificar disponibilidade do jogo ${appid}:`, error.message);
        return null;
    }
}

async function buscarAppIdPorNome(nomeJogo) {
    try {
        const url = `https://store.steampowered.com/api/storesearch?term=${encodeURIComponent(nomeJogo)}&l=portuguese&cc=BR&max=1`;
        const data = await fetchWithTimeout(url, 8000);

        if (data.items && data.items.length > 0) {
            const jogo = data.items[0];
            return {
                appid: jogo.id,
                nome: jogo.name,
                link: `https://store.steampowered.com/app/${jogo.id}`
            };
        }
        return null;
    } catch (error) {
        console.error(`❌ Erro ao buscar AppID:`, error.message);
        return null;
    }
}

async function adicionarQuero(discordId, appid, nomeJogo, link) {
    if (!db.listaQuero[discordId]) {
        db.listaQuero[discordId] = [];
    }

    const jaExiste = db.listaQuero[discordId].some(item => item.appid === appid);
    if (jaExiste) {
        return { sucesso: false, motivo: 'ja_na_lista' };
    }

    const steamIds = process.env.STEAM_IDS.split(',').map(id => id.trim());
    const apiKey = process.env.STEAM_KEY;
    let naFamilia = false;
    let dono = '';

    for (const steamId of steamIds) {
        try {
            const url = `https://api.steampowered.com/IPlayerService/GetOwnedGames/v0001/?key=${apiKey}&steamid=${steamId}&include_appinfo=true&format=json`;
            const data = await fetchWithTimeout(url, 8000);

            if (data.response?.games) {
                const temJogo = data.response.games.some(g => g.appid === appid);
                if (temJogo) {
                    naFamilia = true;
                    dono = steamNames[steamId] || `Usuário ${steamId.substring(0, 8)}`;
                    break;
                }
            }
        } catch (error) {
            console.error(`❌ Erro ao verificar ${steamId}:`, error.message);
        }
    }

    if (naFamilia) {
        return {
            sucesso: false,
            motivo: 'ja_na_familia',
            dono: dono
        };
    }

    db.listaQuero[discordId].push({
        appid: appid,
        nome: nomeJogo,
        link: link,
        adicionado_em: new Date().toISOString()
    });

    salvarDB(db);
    return { sucesso: true };
}

function removerQuero(discordId, appid) {
    if (!db.listaQuero[discordId]) return false;

    const tamanhoAntes = db.listaQuero[discordId].length;
    db.listaQuero[discordId] = db.listaQuero[discordId].filter(item => item.appid !== appid);

    if (db.listaQuero[discordId].length < tamanhoAntes) {
        salvarDB(db);
        return true;
    }
    return false;
}

function listarQuero(discordId) {
    if (!db.listaQuero[discordId] || db.listaQuero[discordId].length === 0) {
        return [];
    }
    return db.listaQuero[discordId];
}

// 🔹 ============================================
// 🔹 FUNÇÃO: verificarConquistas (OTIMIZADA)
// 🔹 ============================================
async function verificarConquistas(steamId, games, mention, userName) {
    if (!games?.length) return;

    const channelConquistas = client.channels.cache.get(CHANNEL_CONQUISTAS);
    if (!channelConquistas) return;

    if (!db.conquistas[steamId]) db.conquistas[steamId] = {};
    if (!db.jogosRecentes[steamId]) db.jogosRecentes[steamId] = [];

    const jogosRecentes = [];

    const jogoAtual = await getCurrentGame(steamId);
    if (jogoAtual) {
        const jogo = games.find(g => g.appid === jogoAtual.gameid);
        if (jogo && !jogosRecentes.find(g => g.appid === jogo.appid)) {
            jogosRecentes.push(jogo);
            console.log(`🎮 ${userName} está JOGANDO: ${jogoAtual.gameextrainfo}`);
        }
    }

    const jogosComUltimoJogo = games
        .filter(g => g.rtime_last_played > 0)
        .sort((a, b) => b.rtime_last_played - a.rtime_last_played)
        .slice(0, 5);

    for (const jogo of jogosComUltimoJogo) {
        if (!jogosRecentes.find(g => g.appid === jogo.appid)) {
            jogosRecentes.push(jogo);
            console.log(`🎮 ${userName} jogou: ${jogo.name || jogo.appid}`);
        }
    }

    if (jogosRecentes.length < 3) {
        for (const appid of db.jogosRecentes[steamId].slice(-5)) {
            const jogo = games.find(g => g.appid === appid);
            if (jogo && !jogosRecentes.find(g => g.appid === appid)) {
                jogosRecentes.push(jogo);
            }
        }
    }

    if (jogosRecentes.length === 0) {
        console.log(`📚 ${userName}: Nenhum jogo recente, pegando os 3 primeiros da biblioteca...`);
        const primeirosJogos = games.slice(0, 3);
        for (const jogo of primeirosJogos) {
            if (!jogosRecentes.find(g => g.appid === jogo.appid)) {
                jogosRecentes.push(jogo);
                console.log(`📚 ${userName}: ${jogo.name}`);
            }
        }
    }

    const jogosParaVerificar = jogosRecentes.slice(0, MAX_JOGOS_POR_USUARIO);

    if (!jogosParaVerificar.length) {
        console.log(`ℹ️ Nenhum jogo recente para ${userName}`);
        return;
    }

    console.log(`🔍 Verificando ${jogosParaVerificar.length} jogos para ${userName}...`);

    let novasConquistas = 0;

    for (const game of jogosParaVerificar) {
        const appid = game.appid;
        const gameName = game.name || `Jogo ${appid}`;

        if (db.jogosSemConquistas[appid]) {
            console.log(`   ⏭️ ${gameName} ignorado (marcado como sem conquistas)`);
            continue;
        }

        try {
            const conquistas = await getAchievements(steamId, appid);
            
            if (!conquistas || conquistas.length === 0) {
                db.jogosSemConquistas[appid] = {
                    nome: gameName,
                    data: new Date().toISOString()
                };
                salvarDB(db);
                console.log(`   ⏭️ ${gameName} marcado como SEM CONQUISTAS (não será verificado novamente)`);
                continue;
            }

            const desbloqueadas = conquistas.filter(c => c.achieved === 1);
            const total = desbloqueadas.length;
            const totalConquistasJogo = conquistas.length;

            if (!db.conquistas[steamId][appid] || !primeiraVerificacaoConcluida) {
                db.conquistas[steamId][appid] = {
                    total: total,
                    nomes: desbloqueadas.map(c => c.apiname),
                    totalJogo: totalConquistasJogo
                };
                console.log(`   💾 ${gameName}: ${total}/${totalConquistasJogo} conquistas salvas`);
                continue;
            }

            const dadosSalvos = db.conquistas[steamId][appid];
            const totalAntigo = dadosSalvos.total || 0;
            const totalJogo = dadosSalvos.totalJogo || totalConquistasJogo;

            if (total > totalAntigo) {
                const nomesAntigos = dadosSalvos.nomes || [];
                const novas = desbloqueadas.filter(c => !nomesAntigos.includes(c.apiname));

                if (novas.length) {
                    novasConquistas += novas.length;

                    const faltam = totalJogo - total;
                    const progresso = `${total}/${totalJogo}`;

                    console.log(`🎮 ${userName} +${novas.length} conquista(s) em ${gameName}! (${progresso})`);

                    const gameInfo = await getGameDetails(appid);

                    for (const conquista of novas.slice(0, MAX_CONQUISTAS_POR_JOGO)) {
                        const nomeConquista = await getAchievementName(steamId, appid, conquista.apiname);
                        const iconName = await buscarIconeConquista(appid, conquista.apiname);
                        const iconUrl = iconName ?
                            `https://shared.fastly.steamstatic.com/community_assets/images/apps/${appid}/${iconName}.jpg` :
                            null;

                        const embed = new EmbedBuilder()
                            .setColor(0xFFD700)
                            .setTitle(`🏆 ${userName} desbloqueou uma conquista!`)
                            .setDescription(`**${nomeConquista}**`)
                            .setThumbnail(gameInfo.icon)
                            .addFields(
                                { name: '🎮 Jogo', value: gameName, inline: true },
                                { name: '👤 Jogador', value: mention, inline: true },
                                { name: '📊 Progresso', value: `${progresso} conquistas (${faltam > 0 ? `faltam ${faltam}` : 'COMPLETO! 🎉'})`, inline: true },
                                { name: '📅 Data', value: new Date().toLocaleDateString('pt-BR'), inline: true }
                            )
                            .setFooter({ text: `+${novas.length} nova(s) conquista(s)` })
                            .setTimestamp();

                        if (iconUrl) {
                            embed.setImage(iconUrl);
                        }

                        await channelConquistas.send({
                            content: `🎉 **NOVA CONQUISTA!**`,
                            embeds: [embed]
                        });
                    }

                    db.conquistas[steamId][appid] = {
                        total: total,
                        nomes: desbloqueadas.map(c => c.apiname),
                        totalJogo: totalJogo
                    };
                    salvarDB(db);
                }
            }
        } catch (error) {
            if (error.message && error.message.includes('HTTP 400')) {
                db.jogosSemConquistas[appid] = {
                    nome: gameName,
                    data: new Date().toISOString(),
                    erro: error.message
                };
                salvarDB(db);
                console.log(`   ⏭️ ${gameName} marcado como SEM CONQUISTAS (erro 400)`);
            } else {
                console.error(`   ❌ Erro em ${gameName}:`, error.message);
            }
        }
    }

    if (!novasConquistas && primeiraVerificacaoConcluida) {
        console.log(`ℹ️ Nenhuma conquista nova para ${userName}`);
    }
}

// 🔹 ============================================
// 🔹 FUNÇÃO: verificarJogosCompradosQuero
// 🔹 ============================================
async function verificarJogosCompradosQuero() {
    console.log(`🔄 Verificando jogos comprados da lista /quero...`);

    try {
        for (const [discordId, jogos] of Object.entries(db.listaQuero)) {
            if (!jogos || jogos.length === 0) continue;

            const steamId = Object.keys(discordUsers).find(key => discordUsers[key] === discordId);
            if (!steamId) {
                continue;
            }

            const url = `https://api.steampowered.com/IPlayerService/GetOwnedGames/v0001/?key=${process.env.STEAM_KEY}&steamid=${steamId}&include_appinfo=true&format=json`;
            const data = await fetchWithTimeout(url, 8000);

            if (!data.response?.games) continue;

            const jogosDoUsuario = data.response.games.map(g => g.appid);
            let jogosRemovidos = 0;

            for (const jogo of jogos) {
                if (jogosDoUsuario.includes(jogo.appid)) {
                    const removido = removerQuero(discordId, jogo.appid);
                    if (removido) {
                        jogosRemovidos++;
                        console.log(`✅ ${jogo.nome} removido da lista /quero de ${discordId} (comprado!)`);

                        try {
                            const usuario = await client.users.fetch(discordId).catch(() => null);
                            if (usuario) {
                                await usuario.send(
                                    `🎮 **${jogo.nome}** foi removido automaticamente da sua lista /quero!\n` +
                                    `✅ Você já possui este jogo na biblioteca Steam.`
                                );
                            }
                        } catch (error) {
                            console.error(`❌ Erro ao enviar DM para ${discordId}:`, error.message);
                        }
                    }
                }
            }

            if (jogosRemovidos > 0) {
                console.log(`📊 ${jogosRemovidos} jogo(s) removido(s) da lista /quero de ${discordId}`);
            }

            await new Promise(resolve => setTimeout(resolve, 1000));
        }

    } catch (error) {
        console.error('❌ Erro ao verificar jogos comprados da lista /quero:', error);
    }
}

// 🔹 ============================================
// 🔹 FUNÇÃO: verificarJogosCompradosFamiliaQuero
// 🔹 ============================================
async function verificarJogosCompradosFamiliaQuero() {
    console.log(`🔄 Verificando jogos da família comprados da lista /quero...`);

    try {
        const steamIds = process.env.STEAM_IDS.split(',').map(id => id.trim());
        const apiKey = process.env.STEAM_KEY;

        const jogosDaFamilia = new Set();
        for (const steamId of steamIds) {
            try {
                const url = `https://api.steampowered.com/IPlayerService/GetOwnedGames/v0001/?key=${apiKey}&steamid=${steamId}&include_appinfo=true&format=json`;
                const data = await fetchWithTimeout(url, 8000);

                if (data.response?.games) {
                    for (const game of data.response.games) {
                        jogosDaFamilia.add(game.appid);
                    }
                }
            } catch (error) {
                console.error(`❌ Erro ao buscar jogos de ${steamId}:`, error.message);
            }
        }

        console.log(`📊 Família possui ${jogosDaFamilia.size} jogos únicos`);

        for (const [discordId, jogos] of Object.entries(db.listaQuero)) {
            if (!jogos || jogos.length === 0) continue;

            let jogosRemovidos = 0;

            for (const jogo of jogos) {
                if (jogosDaFamilia.has(jogo.appid)) {
                    const removido = removerQuero(discordId, jogo.appid);
                    if (removido) {
                        jogosRemovidos++;
                        console.log(`✅ ${jogo.nome} removido da lista /quero de ${discordId} (jogo na família!)`);

                        try {
                            const usuario = await client.users.fetch(discordId).catch(() => null);
                            if (usuario) {
                                await usuario.send(
                                    `🎮 **${jogo.nome}** foi removido automaticamente da sua lista /quero!\n` +
                                    `✅ Alguém da família já possui este jogo na Steam.`
                                );
                            }
                        } catch (error) {
                            console.error(`❌ Erro ao enviar DM para ${discordId}:`, error.message);
                        }
                    }
                }
            }

            if (jogosRemovidos > 0) {
                console.log(`📊 ${jogosRemovidos} jogo(s) removido(s) da lista /quero de ${discordId} (família)`);
            }

            await new Promise(resolve => setTimeout(resolve, 1000));
        }

    } catch (error) {
        console.error('❌ Erro ao verificar jogos da família na lista /quero:', error);
    }
}

// 🔹 ============================================
// 🔹 FUNÇÕES: verificarCompatibilidadeFamilia, contarDLCs, buscarSugestoesJogos
// 🔹 ============================================
async function verificarCompatibilidadeFamilia(appid) {
    if (compatibilidadeCache[appid] !== undefined) {
        return compatibilidadeCache[appid];
    }

    if (JOGOS_INCOMPATIVEIS[appid]) {
        console.log(`📋 Lista manual: Jogo ${appid} NÃO é compatível`);
        compatibilidadeCache[appid] = false;
        return false;
    }

    let resultado = true;

    try {
        const url = `https://steamdb.info/api/v1/appdetails/?appid=${appid}`;
        const data = await fetchWithTimeout(url, 8000);

        if (data && data.data) {
            const appData = data.data;
            const excludeFromFamilySharing = appData.exclude_from_family_sharing || false;
            const isFree = appData.is_free || false;
            const requiresAccount = appData.requires_account || false;

            if (excludeFromFamilySharing || isFree || requiresAccount) {
                resultado = false;
                console.log(`❌ SteamDB: Jogo ${appid} NÃO é compatível`);
                compatibilidadeCache[appid] = resultado;
                return resultado;
            }
        }
    } catch (error) {
        console.log(`⚠️ SteamDB falhou: ${error.message}`);
    }

    console.log(`✅ Jogo ${appid} é compatível com Família Steam`);
    compatibilidadeCache[appid] = true;
    return true;
}

async function contarDLCs(appid) {
    try {
        const url = `https://store.steampowered.com/api/appdetails?appids=${appid}&l=portuguese`;
        const data = await fetchWithTimeout(url, 8000);

        if (data[appid]?.success) {
            const gameData = data[appid].data;
            if (gameData.dlc && gameData.dlc.length > 0) {
                return gameData.dlc.length;
            }
        }
        return 0;
    } catch (error) {
        console.error(`❌ Erro ao contar DLCs:`, error.message);
        return 0;
    }
}

async function buscarSugestoesJogos(termo) {
    try {
        if (!termo || termo.length === 0) {
            return [
                { name: 'Elden Ring', value: 'Elden Ring' },
                { name: 'Counter-Strike 2', value: 'Counter-Strike 2' },
                { name: 'Dying Light', value: 'Dying Light' },
                { name: 'Sonic Frontiers', value: 'Sonic Frontiers' },
                { name: 'Stardew Valley', value: 'Stardew Valley' }
            ];
        }

        const termoLower = termo.toLowerCase();
        const url = `https://store.steampowered.com/api/storesearch?term=${encodeURIComponent(termo)}&l=portuguese&cc=BR&max=50`;
        const data = await fetchWithTimeout(url, 8000);

        if (data.items && data.items.length > 0) {
            const jogos = data.items
                .filter(item => {
                    const nomeLower = item.name.toLowerCase();
                    return (item.type === 'game' || item.type === 'dlc') &&
                        nomeLower.startsWith(termoLower);
                })
                .slice(0, 25)
                .map(item => ({
                    name: item.name,
                    value: item.name
                }));

            if (jogos.length === 0) {
                const jogosContem = data.items
                    .filter(item => {
                        const nomeLower = item.name.toLowerCase();
                        return (item.type === 'game' || item.type === 'dlc') &&
                            nomeLower.includes(termoLower);
                    })
                    .slice(0, 15)
                    .map(item => ({
                        name: item.name,
                        value: item.name
                    }));

                if (jogosContem.length > 0) {
                    return jogosContem;
                }
            }

            return jogos;
        }

        return [
            { name: 'Elden Ring', value: 'Elden Ring' },
            { name: 'Counter-Strike 2', value: 'Counter-Strike 2' },
            { name: 'Dying Light', value: 'Dying Light' },
            { name: 'Sonic Frontiers', value: 'Sonic Frontiers' },
            { name: 'Stardew Valley', value: 'Stardew Valley' }
        ];
    } catch (error) {
        console.error('❌ Erro ao buscar sugestões:', error);
        return [];
    }
}

// 🔹 ============================================
// 🔹 FUNÇÃO: gerarRanking (compara com último enviado)
// 🔹 ============================================
function gerarRanking() {
    const rankingArray = Object.values(ranking).sort((a, b) => b.jogos - a.jogos);

    const embed = new EmbedBuilder()
        .setColor(0x00AE86)
        .setTitle('🏆 Ranking da Biblioteca Steam 2026')
        .setThumbnail('https://upload.wikimedia.org/wikipedia/commons/thumb/8/83/Steam_icon_logo.svg/1200px-Steam_icon_logo.svg.png')
        .setTimestamp()
        .setFooter({ text: `Atualizado ${new Date().toLocaleTimeString()}` });

    const medalhas = ['🥇', '🥈', '🥉', '4°', '5°', '6°'];
    let description = '';

    rankingArray.forEach((user, index) => {
        const posicao = index < 3 ? medalhas[index] : `${medalhas[index]}`;
        const mencao = user.discordId ? `<@${user.discordId}>` : user.nome;
        const totalJogos = user.jogos > 0 ? `${Math.floor(user.jogos)} jogos` : '0 jogos';
        description += `${posicao} **${mencao}** — ${totalJogos}\n`;
    });

    embed.setDescription(description);
    return embed;
}

// 🔹 ============================================
// 🔹 FUNÇÃO: enviarRanking (com prevenção de spam e leitura do canal)
// 🔹 ============================================
async function enviarRanking(forcar = false) {
    if (debounceRanking) {
        console.log('⏳ Ranking já está sendo enviado, ignorando nova solicitação.');
        return;
    }
    debounceRanking = true;

    try {
        db.ranking = ranking;
        salvarDB(db);

        const embedAtual = gerarRanking();
        const descricaoAtual = embedAtual.data.description;

        if (!forcar && db.ultimoRankingEnviado && db.ultimoRankingEnviado.descricao === descricaoAtual) {
            console.log('ℹ️ Ranking não mudou. Nada a enviar.');
            debounceRanking = false;
            return;
        }

        const channel = client.channels.cache.get(CHANNEL_RANKING);
        if (!channel) {
            console.error('❌ Canal de ranking não encontrado!');
            debounceRanking = false;
            return;
        }

        if (ultimaMensagemRankingId) {
            try {
                const mensagemAntiga = await channel.messages.fetch(ultimaMensagemRankingId);
                if (mensagemAntiga) {
                    await mensagemAntiga.delete();
                    console.log(`🗑️ Mensagem de ranking anterior apagada: ${ultimaMensagemRankingId}`);
                }
            } catch (error) {
                console.log(`ℹ️ Mensagem anterior não encontrada, continuando...`);
            }
        }

        const novaMensagem = await channel.send({ embeds: [embedAtual] });
        ultimaMensagemRankingId = novaMensagem.id;
        db.ultimaMensagemRankingId = ultimaMensagemRankingId;

        db.ultimoRankingEnviado = {
            descricao: descricaoAtual,
            timestamp: Date.now()
        };
        salvarDB(db);

        console.log(`📊 Novo ranking enviado! ID: ${ultimaMensagemRankingId}`);

    } catch (error) {
        console.error(`❌ Erro ao enviar/atualizar ranking:`, error);
    } finally {
        debounceRanking = false;
    }
}

// 🔹 ============================================
// 🔹 FUNÇÃO: limparMensagensAntigas (remove mensagens do bot nos últimos 20 minutos)
// 🔹 ============================================
async function limparMensagensAntigas() {
    const canais = [CHANNEL_RANKING, CHANNEL_CONQUISTAS, CHANNEL_NOTIFICACOES];
    const agora = Date.now();
    const vinteMinutos = 20 * 60 * 1000;
    let totalApagadas = 0;

    for (const canalId of canais) {
        if (!canalId) continue;
        const channel = client.channels.cache.get(canalId);
        if (!channel) continue;

        try {
            const messages = await channel.messages.fetch({ limit: 100 });
            const botMessages = messages.filter(msg => msg.author.id === client.user.id);
            const antigas = botMessages.filter(msg => (agora - msg.createdTimestamp) > vinteMinutos);

            if (antigas.size > 0) {
                console.log(`🧹 Apagando ${antigas.size} mensagens antigas do bot no canal ${channel.name}`);
                for (const msg of antigas.values()) {
                    await msg.delete().catch(() => {});
                    totalApagadas++;
                    await new Promise(r => setTimeout(r, 200));
                }
            }
        } catch (error) {
            console.error(`❌ Erro ao limpar mensagens no canal ${channel.name}:`, error.message);
        }
    }

    if (totalApagadas > 0) {
        console.log(`🧹 Total de ${totalApagadas} mensagens antigas apagadas.`);
    }
}

// 🔹 ============================================
// 🔹 FUNÇÃO: verificarSuporteFamilia, checkSteamGames, registrarComandos
// 🔹 ============================================
async function verificarSuporteFamilia(appid) {
    try {
        const url = `https://store.steampowered.com/app/${appid}`;
        const data = await fetchWithTimeout(url, 8000);

        const html = typeof data === 'string' ? data : JSON.stringify(data);
        const temCompartilhamento = html.includes('Compartilhamento em família') || html.includes('Family Sharing');
        const naoCompativel = html.includes('Compartilhamento em família não disponível') || html.includes('Family Sharing not available');

        if (temCompartilhamento && !naoCompativel) return true;
        if (naoCompativel) return false;
        return true;
    } catch (error) {
        return true;
    }
}

async function checkSteamGames() {
    const inicio = Date.now();
    console.log(`🔄 [${new Date().toLocaleTimeString()}] VERIFICANDO...`);

    try {
        if (!process.env.STEAM_IDS || !process.env.STEAM_KEY || !process.env.CHANNEL_ID) {
            console.error('❌ Variáveis de ambiente não configuradas!');
            return;
        }

        const steamIds = process.env.STEAM_IDS.split(',').map(id => id.trim());
        const apiKey = process.env.STEAM_KEY;
        const channelNotificacoes = client.channels.cache.get(CHANNEL_NOTIFICACOES);

        if (!channelNotificacoes) {
            console.error('❌ Canal de notificações não encontrado!');
            return;
        }

        const isFirstRun = !primeiraVerificacaoConcluida;

        for (const trimmedId of steamIds) {
            try {
                const url = `https://api.steampowered.com/IPlayerService/GetOwnedGames/v0001/?key=${apiKey}&steamid=${trimmedId}&include_appinfo=true&format=json`;
                const data = await fetchWithTimeout(url, 10000);

                if (!data.response?.games) continue;

                const currentGames = data.response.games.map(g => ({
                    name: g.name,
                    appid: g.appid,
                    rtime_last_played: g.rtime_last_played || 0
                }));

                const userName = steamNames[trimmedId] || `Usuário ${trimmedId.substring(0, 8)}`;
                const discordId = discordUsers[trimmedId];
                const mention = discordId ? `<@${discordId}>` : userName;

                await verificarConquistas(trimmedId, currentGames, mention, userName);

                if (!previousGames[trimmedId]) {
                    previousGames[trimmedId] = currentGames;
                    console.log(`📊 ${userName}: ${currentGames.length} jogos`);
                } else {
                    const oldGames = previousGames[trimmedId];
                    const oldAppIds = new Set(oldGames.map(g => g.appid));
                    const newGames = currentGames.filter(g => !oldAppIds.has(g.appid));

                    if (newGames.length) {
                        console.log(`🎮 ${userName} +${newGames.length} novo(s) jogo(s)!`);

                        for (const game of newGames) {
                            const appid = game.appid;
                            const nome = game.name;

                            // 🔹 Removida a verificação de lista de desejos da Steam

                            for (const [discordIdQuero, jogosQuero] of Object.entries(db.listaQuero)) {
                                if (!jogosQuero || jogosQuero.length === 0) continue;

                                const jogoNaLista = jogosQuero.find(j => j.appid === appid);
                                if (jogoNaLista) {
                                    const removido = removerQuero(discordIdQuero, appid);
                                    if (removido) {
                                        console.log(`✅ ${nome} removido da lista /quero de ${discordIdQuero} (comprado por ${userName})`);

                                        try {
                                            const usuario = await client.users.fetch(discordIdQuero).catch(() => null);
                                            if (usuario) {
                                                await usuario.send(
                                                    `🎮 **${nome}** foi removido automaticamente da sua lista /quero!\n` +
                                                    `✅ **${userName}** acabou de adquirir este jogo na Steam.`
                                                );
                                            }
                                        } catch (error) {
                                            console.error(`❌ Erro ao enviar DM para ${discordIdQuero}:`, error.message);
                                        }
                                    }
                                }
                            }

                            const link = `https://store.steampowered.com/app/${appid}`;
                            const isCompatible = await verificarSuporteFamilia(appid);
                            if (isCompatible) {
                                await channelNotificacoes.send(
                                    `@everyone 🎉 ${mention} comprou o jogo: **${nome}**\n🔗 ${link}\n✅ **Compatível com Família Steam!**`
                                );
                                if (ranking[trimmedId]) {
                                    ranking[trimmedId].jogos += 1;
                                    db.ranking = ranking;
                                    salvarDB(db);
                                    await enviarRanking(false);
                                }
                            }
                        }
                    }
                    previousGames[trimmedId] = currentGames;
                }
            } catch (error) {
                console.error(`❌ Erro em ${trimmedId}:`, error.message);
            }
        }

        // 🔹 Removidas chamadas a funções de promoções e lançamentos
        if (!isFirstRun) {
            await verificarJogosCompradosQuero();
            await verificarJogosCompradosFamiliaQuero();
        } else {
            console.log('⏳ Primeira execução: Pulando verificações de lista /quero.');
        }

        if (!primeiraVerificacaoConcluida) {
            primeiraVerificacaoConcluida = true;
            console.log('✅ PRIMEIRA VERIFICAÇÃO CONCLUÍDA!');
            console.log('🔍 Monitorando NOVAS conquistas em tempo real!');
            salvarDB(db);
            console.log('✅ SISTEMA INICIALIZADO! Conquistas salvas. Monitorando novas conquistas!');
        }

        const duracao = ((Date.now() - inicio) / 1000).toFixed(1);
        console.log(`✅ [${new Date().toLocaleTimeString()}] CONCLUÍDO em ${duracao}s`);

    } catch (error) {
        console.error('❌ Erro geral:', error);
    }
}

async function registrarComandos() {
    try {
        const commands = [
            {
                name: 'tem',
                description: 'Verifica se um jogo está na biblioteca da família',
                options: [
                    {
                        name: 'jogo',
                        description: 'Nome do jogo ou link da Steam',
                        type: 3,
                        required: true,
                        autocomplete: true
                    }
                ]
            },
            {
                name: 'ranking',
                description: 'Mostra o ranking da biblioteca da família'
            },
            {
                name: 'quero',
                description: 'Adiciona um jogo à sua lista de desejos personalizada',
                options: [
                    {
                        name: 'jogo',
                        description: 'Nome do jogo que você quer',
                        type: 3,
                        required: true
                    }
                ]
            },
            {
                name: 'quero-listar',
                description: 'Lista todos os jogos da sua lista /quero'
            },
            {
                name: 'quero-listar-resumido',
                description: 'Lista rapidamente os jogos da sua lista /quero (sem verificar preços)'
            },
            {
                name: 'quero-remover',
                description: 'Remove um jogo da sua lista /quero',
                options: [
                    {
                        name: 'jogo',
                        description: 'Nome do jogo para remover',
                        type: 3,
                        required: true
                    }
                ]
            },
            {
                name: 'dbstatus',
                description: '[DONO] Mostra o status do banco de dados'
            }
        ];

        await client.application.commands.set(commands);
        console.log('✅ Comandos registrados GLOBALMENTE!');

        const guild = client.guilds.cache.first();
        if (guild) {
            await guild.commands.set(commands);
            console.log(`✅ Comandos registrados no servidor: ${guild.name}`);
        }
    } catch (error) {
        console.error('❌ Erro ao registrar comandos:', error);
    }
}

// 🔹 ============================================
// 🔹 EVENTOS: interactionCreate, messageCreate
// 🔹 ============================================
client.on('interactionCreate', async (interaction) => {
    if (interaction.isAutocomplete()) {
        if (interaction.commandName === 'tem') {
            const valorDigitado = interaction.options.getString('jogo')?.toLowerCase() || '';

            try {
                const sugestoes = await buscarSugestoesJogos(valorDigitado);
                console.log(`🔍 Autocomplete para "${valorDigitado}": ${sugestoes.length} sugestões`);
                await interaction.respond(sugestoes);
            } catch (error) {
                console.error('❌ Erro no autocomplete:', error);
                await interaction.respond([]);
            }
        }
        return;
    }

    if (interaction.isChatInputCommand()) {
        // /tem
        if (interaction.commandName === 'tem') {
            const input = interaction.options.getString('jogo');

            await interaction.deferReply({ ephemeral: true });

            try {
                let jogo = null;

                if (input.includes('store.steampowered.com/app/')) {
                    const appid = extrairAppIdDaUrl(input);
                    if (appid) {
                        jogo = await buscarJogoPorAppId(appid);
                    }
                }

                if (!jogo) {
                    jogo = await buscarJogoSteam(input);
                }

                if (!jogo) {
                    await interaction.editReply({
                        content: `❌ Não encontrei o jogo **${input}** na Steam.\n💡 Verifique o nome ou link e tente novamente.`
                    });
                    return;
                }

                const donos = await verificarJogoFamilia(jogo.appid);
                const totalDLCs = await contarDLCs(jogo.appid);
                const compativel = await verificarCompatibilidadeFamilia(jogo.appid);

                const embed = new EmbedBuilder()
                    .setColor(donos.length > 0 ? 0x00FF00 : 0xFF0000)
                    .setTitle(`${donos.length > 0 ? '✅' : '❌'} ${jogo.nome}`)
                    .setURL(jogo.url)
                    .setFooter({ text: 'Steam Família - Consulta' })
                    .setTimestamp();

                if (jogo.capa) {
                    embed.setThumbnail(jogo.capa);
                }

                if (!compativel) {
                    embed.addFields({
                        name: '⚠️ ATENÇÃO',
                        value: '⚠️ **Este jogo NÃO tem suporte para Compartilhamento em Família!**\n\nVerifique a página do jogo na Steam para mais informações.',
                        inline: false
                    });
                }

                if (totalDLCs > 0) {
                    embed.addFields({
                        name: '📦 Conteúdos Adicionais (DLCs)',
                        value: `Este jogo possui **${totalDLCs}** DLC(s) disponível(is) na Steam.`,
                        inline: false
                    });
                } else {
                    embed.addFields({
                        name: '📦 Conteúdos Adicionais (DLCs)',
                        value: 'Este jogo não possui DLCs listadas.',
                        inline: false
                    });
                }

                if (donos.length > 0) {
                    let descricao = `🎮 **Encontrado na família!**\n👤 **${donos.length} membro(s) possui(em):**\n\n`;
                    donos.forEach((dono, index) => {
                        const mencao = dono.discordId ? `<@${dono.discordId}>` : dono.nome;
                        descricao += `**${index + 1}. ${mencao}**\n`;
                    });
                    embed.setDescription(descricao);
                } else {
                    embed.setDescription(
                        `😕 **Nenhum membro da família possui este jogo.**\n\n` +
                        `💡 **Sugestões:**\n` +
                        `• Adicione à lista de desejos\n` +
                        `• Combine com a família para comprar juntos\n` +
                        `• Aguarde uma promoção`
                    );
                }

                await interaction.editReply({
                    embeds: [embed]
                });

            } catch (error) {
                console.error('❌ Erro no comando /tem:', error);
                await interaction.editReply({
                    content: `❌ Ocorreu um erro ao buscar o jogo. Tente novamente mais tarde.\nErro: ${error.message}`
                });
            }
        }

        // /ranking
        if (interaction.commandName === 'ranking') {
            await interaction.deferReply({ ephemeral: true });

            try {
                const embedRanking = gerarRanking();
                await interaction.editReply({
                    embeds: [embedRanking]
                });
            } catch (error) {
                console.error('❌ Erro no comando /ranking:', error);
                await interaction.editReply({
                    content: '❌ Ocorreu um erro ao gerar o ranking.'
                });
            }
        }

        // /quero
        if (interaction.commandName === 'quero') {
            const nomeJogo = interaction.options.getString('jogo');

            await interaction.deferReply({ ephemeral: true });

            try {
                const jogo = await buscarAppIdPorNome(nomeJogo);

                if (!jogo) {
                    await interaction.editReply({
                        content: `❌ Não encontrei o jogo **${nomeJogo}** na Steam. Verifique o nome e tente novamente.`
                    });
                    return;
                }

                const steamId = Object.keys(discordUsers).find(key => discordUsers[key] === interaction.user.id);
                if (steamId) {
                    const url = `https://api.steampowered.com/IPlayerService/GetOwnedGames/v0001/?key=${process.env.STEAM_KEY}&steamid=${steamId}&include_appinfo=true&format=json`;
                    const data = await fetchWithTimeout(url, 8000);

                    if (data.response?.games) {
                        const temJogo = data.response.games.some(g => g.appid === jogo.appid);
                        if (temJogo) {
                            await interaction.editReply({
                                content: `ℹ️ Você **já possui** **${jogo.nome}** na sua biblioteca Steam!`
                            });
                            return;
                        }
                    }
                }

                const resultado = await adicionarQuero(interaction.user.id, jogo.appid, jogo.nome, jogo.link);

                if (!resultado.sucesso) {
                    if (resultado.motivo === 'ja_na_lista') {
                        await interaction.editReply({
                            content: `ℹ️ O jogo **${jogo.nome}** já está na sua lista /quero!`
                        });
                    } else if (resultado.motivo === 'ja_na_familia') {
                        await interaction.editReply({
                            content: `ℹ️ O jogo **${jogo.nome}** **já está na família!**\n👤 ${resultado.dono} já possui este jogo.`
                        });
                    }
                    return;
                }

                const infoDisponibilidade = await verificarDisponibilidadeJogo(jogo.appid);

                let mensagem = `✅ **${jogo.nome}** adicionado à sua lista /quero!\n\n`;
                mensagem += `🔗 ${jogo.link}\n\n`;

                if (infoDisponibilidade) {
                    if (infoDisponibilidade.disponivel) {
                        mensagem += `🎉 **ATENÇÃO!** Este jogo **JÁ ESTÁ DISPONÍVEL PARA COMPRA!**\n`;
                        mensagem += `📅 Data de lançamento: ${infoDisponibilidade.dataLancamento}`;
                    } else if (infoDisponibilidade.preVenda) {
                        mensagem += `🛒 **ATENÇÃO!** Este jogo **ESTÁ EM PRÉ-VENDA!**\n`;
                        mensagem += `📅 Data de lançamento: ${infoDisponibilidade.dataLancamento}`;
                    } else if (infoDisponibilidade.aindaNaoLancado) {
                        mensagem += `📢 Você será notificado(a) por DM quando este jogo estiver disponível para compra.\n`;
                        mensagem += `📅 Lançamento previsto: ${infoDisponibilidade.dataLancamento}`;
                    } else {
                        mensagem += `📢 Você será notificado(a) por DM quando este jogo estiver disponível para compra!`;
                    }
                } else {
                    mensagem += `📢 Você será notificado(a) por DM quando este jogo estiver disponível para compra!`;
                }

                await interaction.editReply({
                    content: mensagem
                });

            } catch (error) {
                console.error('❌ Erro no comando /quero:', error);
                await interaction.editReply({
                    content: '❌ Ocorreu um erro ao adicionar o jogo à lista.'
                });
            }
        }

        // /quero-listar
        if (interaction.commandName === 'quero-listar') {
            await interaction.deferReply({ ephemeral: true });

            try {
                const lista = listarQuero(interaction.user.id);

                if (lista.length === 0) {
                    await interaction.editReply({
                        content: '📭 Sua lista /quero está vazia. Use `/quero [nome do jogo]` para adicionar jogos.'
                    });
                    return;
                }

                const MAX_JOGOS_EXIBIR = 20;
                const jogosParaExibir = lista.slice(0, MAX_JOGOS_EXIBIR);
                const totalJogos = lista.length;

                const jogosInfo = await Promise.all(
                    jogosParaExibir.map(async (jogo) => {
                        try {
                            const [preco, disponivel] = await Promise.all([
                                verificarPrecoJogo(jogo.appid).catch(() => null),
                                verificarDisponibilidadeJogo(jogo.appid).catch(() => null)
                            ]);

                            let status = '⏳ Aguardando...';
                            let statusEmoji = '🟡';

                            if (preco && preco.emPromocao) {
                                status = `🟢 EM PROMOÇÃO! (${preco.desconto}% OFF)`;
                                statusEmoji = '🟢';
                            } else if (disponivel && (disponivel.disponivel || disponivel.preVenda)) {
                                status = '🟢 DISPONÍVEL!';
                                statusEmoji = '🟢';
                            } else if (disponivel && disponivel.aindaNaoLancado) {
                                status = `⏳ Lançamento: ${disponivel.dataLancamento}`;
                                statusEmoji = '🔵';
                            }

                            return {
                                ...jogo,
                                status,
                                statusEmoji,
                                preco: preco?.precoAtual || 'N/A'
                            };
                        } catch (error) {
                            return {
                                ...jogo,
                                status: '❌ Erro ao verificar',
                                statusEmoji: '❌',
                                preco: 'N/A'
                            };
                        }
                    })
                );

                const embed = new EmbedBuilder()
                    .setColor(0x00AE86)
                    .setTitle(`📋 Sua lista /quero (${totalJogos} jogos)`)
                    .setDescription(`Mostrando ${Math.min(totalJogos, MAX_JOGOS_EXIBIR)} jogos${totalJogos > MAX_JOGOS_EXIBIR ? ` (${totalJogos - MAX_JOGOS_EXIBIR} não exibidos)` : ''}`)
                    .setFooter({ text: 'Steam Família - Lista /quero' })
                    .setTimestamp();

                let descricao = '';
                for (let i = 0; i < jogosInfo.length; i++) {
                    const jogo = jogosInfo[i];
                    descricao += `${jogo.statusEmoji} **${i + 1}.** [${jogo.nome}](${jogo.link})\n`;
                    descricao += `   📊 Status: ${jogo.status}\n`;
                    if (jogo.preco !== 'N/A') {
                        descricao += `   💰 Preço: ${jogo.preco}\n`;
                    }
                    descricao += '\n';
                }

                if (descricao.length > 4000) {
                    const partes = descricao.match(/[\s\S]{1,4000}/g) || [];
                    await interaction.editReply({
                        content: `📋 **Sua lista /quero (${totalJogos} jogos)**\n*(Lista muito longa, enviando em partes)*`
                    });

                    for (let i = 0; i < partes.length; i++) {
                        const embedParte = new EmbedBuilder()
                            .setColor(0x00AE86)
                            .setDescription(partes[i])
                            .setFooter({ text: `Steam Família - Lista /quero (Parte ${i + 1}/${partes.length})` });

                        await interaction.followUp({ embeds: [embedParte], ephemeral: true });
                    }
                } else {
                    embed.setDescription(descricao);
                    await interaction.editReply({ embeds: [embed] });
                }

            } catch (error) {
                console.error('❌ Erro no comando /quero-listar:', error);
                await interaction.editReply({
                    content: '❌ Ocorreu um erro ao listar os jogos da sua lista /quero. Tente novamente mais tarde.'
                });
            }
        }

        // /quero-listar-resumido
        if (interaction.commandName === 'quero-listar-resumido') {
            await interaction.deferReply({ ephemeral: true });

            try {
                const lista = listarQuero(interaction.user.id);

                if (lista.length === 0) {
                    await interaction.editReply({
                        content: '📭 Sua lista /quero está vazia.'
                    });
                    return;
                }

                const embed = new EmbedBuilder()
                    .setColor(0x00AE86)
                    .setTitle(`📋 Sua lista /quero (${lista.length} jogos)`)
                    .setDescription(lista.map((jogo, i) => `**${i + 1}.** [${jogo.nome}](${jogo.link})`).join('\n'))
                    .setFooter({ text: 'Use /quero-listar para ver detalhes' })
                    .setTimestamp();

                if (embed.data.description && embed.data.description.length > 4000) {
                    await interaction.editReply({
                        content: `📋 **Sua lista /quero (${lista.length} jogos)**\n${lista.map((jogo, i) => `${i + 1}. ${jogo.nome}`).join('\n')}`
                    });
                } else {
                    await interaction.editReply({ embeds: [embed] });
                }

            } catch (error) {
                console.error('❌ Erro no comando /quero-listar-resumido:', error);
                await interaction.editReply({
                    content: '❌ Ocorreu um erro ao listar os jogos.'
                });
            }
        }

        // /quero-remover
        if (interaction.commandName === 'quero-remover') {
            const nomeJogo = interaction.options.getString('jogo');

            await interaction.deferReply({ ephemeral: true });

            try {
                const jogo = await buscarAppIdPorNome(nomeJogo);

                if (!jogo) {
                    await interaction.editReply({
                        content: `❌ Não encontrei o jogo **${nomeJogo}** na Steam.`
                    });
                    return;
                }

                const removido = removerQuero(interaction.user.id, jogo.appid);

                if (!removido) {
                    await interaction.editReply({
                        content: `ℹ️ O jogo **${jogo.nome}** não estava na sua lista /quero.`
                    });
                    return;
                }

                await interaction.editReply({
                    content: `✅ **${jogo.nome}** foi removido da sua lista /quero!`
                });

            } catch (error) {
                console.error('❌ Erro no comando /quero-remover:', error);
                await interaction.editReply({
                    content: '❌ Ocorreu um erro ao remover o jogo da lista.'
                });
            }
        }

        // /dbstatus
        if (interaction.commandName === 'dbstatus') {
            if (interaction.user.id !== DONO_ID) {
                await interaction.reply({
                    content: '❌ Apenas o dono pode usar este comando.',
                    ephemeral: true
                });
                return;
            }

            await interaction.deferReply({ ephemeral: true });

            try {
                const totalQuero = Object.values(db.listaQuero).reduce((acc, arr) => acc + arr.length, 0);
                const totalSteamLinks = Object.keys(db.steamLinks).length;
                const totalSemConquistas = Object.keys(db.jogosSemConquistas).length;

                let mensagem = `📊 **Status do Banco de Dados:**\n\n`;
                mensagem += `📋 Lista /quero: **${totalQuero}** jogos\n`;
                mensagem += `🔗 Steam Links: **${totalSteamLinks}** usuários\n`;
                mensagem += `🚫 Jogos sem conquistas: **${totalSemConquistas}**\n`;
                mensagem += `💾 Arquivo: ${DB_FILE}\n`;
                mensagem += `📅 Última atualização: ${new Date().toLocaleString()}`;

                await interaction.editReply({
                    content: mensagem
                });

            } catch (error) {
                console.error('❌ Erro no comando /dbstatus:', error);
                await interaction.editReply({
                    content: '❌ Ocorreu um erro ao verificar o banco de dados.'
                });
            }
        }
    }
});

client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    if (message.content.toLowerCase() === '!resetranking') {
        if (message.author.id !== DONO_ID) {
            await message.reply({
                content: '❌ Você não tem permissão para usar este comando!',
                ephemeral: true
            });
            return;
        }

        await message.reply({
            content: '⚠️ Tem certeza que quer resetar o ranking? Digite `!confirmar` em até 30 segundos.',
            ephemeral: true
        });

        const coletor = message.channel.createMessageCollector({
            filter: m => m.author.id === message.author.id && m.content.toLowerCase() === '!confirmar',
            max: 1,
            time: 30000
        });

        coletor.on('collect', async () => {
            ranking = JSON.parse(JSON.stringify(rankingPadrao));
            db.ranking = ranking;
            salvarDB(db);
            await enviarRanking(true);
            await message.reply({
                content: '✅ Ranking resetado para os valores padrão!',
                ephemeral: true
            });
        });

        coletor.on('end', collected => {
            if (collected.size === 0) {
                message.reply({
                    content: '⏰ Tempo esgotado. Reset cancelado.',
                    ephemeral: true
                });
            }
        });
    }
});

// 🔹 ============================================
// 🔹 FUNÇÃO: restaurarRankingDoCanal
// 🔹 ============================================
async function restaurarRankingDoCanal() {
    const channel = client.channels.cache.get(CHANNEL_RANKING);
    if (!channel) {
        console.error('❌ Canal de ranking não encontrado!');
        return false;
    }

    try {
        let mensagem = null;
        if (db.ultimaMensagemRankingId) {
            try {
                mensagem = await channel.messages.fetch(db.ultimaMensagemRankingId);
            } catch (error) {
                console.log(`ℹ️ Mensagem de ranking com ID ${db.ultimaMensagemRankingId} não encontrada.`);
            }
        }

        if (!mensagem) {
            const messages = await channel.messages.fetch({ limit: 10 });
            const botMessages = messages.filter(msg => msg.author.id === client.user.id && msg.embeds.length > 0);
            if (botMessages.size > 0) {
                mensagem = botMessages.first();
                console.log(`📩 Encontrada mensagem de ranking alternativa: ${mensagem.id}`);
            }
        }

        if (!mensagem) {
            console.log('ℹ️ Nenhuma mensagem de ranking encontrada no canal.');
            return false;
        }

        const embed = mensagem.embeds[0];
        if (!embed || !embed.description) {
            console.log('ℹ️ Embed de ranking não encontrado.');
            return false;
        }

        const linhas = embed.description.split('\n');
        const rankingRestaurado = {};
        let encontrou = false;

        for (const linha of linhas) {
            const match = linha.match(/(?:🥇|🥈|🥉|\d+°)\s+\*\*<@!?(\d+)>\*\*\s+—\s+(\d+)\s+jogos/);
            if (match) {
                const discordId = match[1];
                const jogos = parseInt(match[2]);
                for (const [steamId, dados] of Object.entries(discordUsers)) {
                    if (dados === discordId) {
                        rankingRestaurado[steamId] = {
                            nome: steamNames[steamId] || `Usuário ${steamId.substring(0, 8)}`,
                            jogos: jogos,
                            steamId: steamId,
                            discordId: discordId
                        };
                        encontrou = true;
                        break;
                    }
                }
            }
        }

        if (encontrou && Object.keys(rankingRestaurado).length > 0) {
            for (const [steamId, dados] of Object.entries(rankingPadrao)) {
                if (!rankingRestaurado[steamId]) {
                    rankingRestaurado[steamId] = dados;
                    console.log(`📊 Adicionando novo membro ao ranking: ${dados.nome}`);
                }
            }

            ranking = rankingRestaurado;
            db.ranking = ranking;
            db.ultimaMensagemRankingId = mensagem.id;
            ultimaMensagemRankingId = mensagem.id;
            db.ultimoRankingEnviado = {
                descricao: embed.description,
                timestamp: Date.now()
            };
            salvarDB(db);

            console.log(`✅ Ranking restaurado do canal: ${Object.keys(ranking).length} usuários`);
            for (const [steamId, dados] of Object.entries(ranking)) {
                console.log(`   - ${dados.nome}: ${dados.jogos} jogos`);
            }
            return true;
        } else {
            console.log('⚠️ Não foi possível extrair dados do ranking.');
            return false;
        }

    } catch (error) {
        console.error('❌ Erro ao restaurar ranking do canal:', error);
        return false;
    }
}

// 🔹 ============================================
// 🔹 HEALTH CHECK MELHORADO
// 🔹 ============================================
const server = http.createServer((req, res) => {
    if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: 'ok',
            uptime: process.uptime(),
            timestamp: new Date().toISOString(),
            memory: {
                rss: Math.round(process.memoryUsage().rss / 1024 / 1024) + ' MB',
                heapTotal: Math.round(process.memoryUsage().heapTotal / 1024 / 1024) + ' MB',
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

// 🔹 ============================================
// 🔹 LIMPEZA DE CACHES (LIBERA MEMÓRIA)
// 🔹 ============================================
setInterval(() => {
    const agora = Date.now();
    const cacheSizeBefore = Object.keys(gameNameCache).length;
    
    for (const [key, value] of Object.entries(gameNameCache)) {
        if (value.timestamp && agora - value.timestamp > CLEANUP_INTERVAL) {
            delete gameNameCache[key];
        }
    }
    
    const cacheSizeAfter = Object.keys(gameNameCache).length;
    if (cacheSizeBefore !== cacheSizeAfter) {
        console.log(`🧹 Caches limpos. Antes: ${cacheSizeBefore}, Depois: ${cacheSizeAfter}`);
    }
}, CLEANUP_INTERVAL);

// 🔹 ============================================
// 🔹 TRATAMENTO DE SIGTERM/SIGINT
// 🔹 ============================================
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

// 🔹 ============================================
// 🔹 EVENTO clientReady
// 🔹 ============================================
client.once('clientReady', async () => {
    console.log(`✅ Bot online como ${client.user.tag}`);
    console.log(`📡 Conectado em ${client.guilds.cache.size} servidor(es)`);

    await registrarComandos();

    console.log(`⏰ Intervalo: ${INTERVALO_VERIFICACAO / 1000} segundos`);
    console.log(`💾 Banco de dados: ${DB_FILE}`);
    console.log(`🔄 Rate limit: ${rateLimiter.minDelay}ms entre requisições`);
    console.log(`🔄 Max retries: ${MAX_RETRIES} tentativas`);

    // 🔹 LIMPA MENSAGENS ANTIGAS DO BOT
    console.log('🧹 Limpando mensagens antigas do bot...');
    await limparMensagensAntigas();

    // 🔹 RESTAURA O RANKING DO CANAL
    const rankingRestaurado = await restaurarRankingDoCanal();
    if (!rankingRestaurado) {
        console.log('ℹ️ Usando ranking do banco de dados (ou valores padrão).');
        carregarRanking();
        await enviarRanking(true);
    } else {
        const embedAtual = gerarRanking();
        const descricaoAtual = embedAtual.data.description;
        if (db.ultimoRankingEnviado && db.ultimoRankingEnviado.descricao !== descricaoAtual) {
            console.log('📊 Ranking restaurado, mas houve mudanças. Enviando atualização.');
            await enviarRanking(true);
        } else {
            console.log('✅ Ranking restaurado e atualizado.');
        }
    }

    // 🔹 VINCULAÇÃO AUTOMÁTICA
    const steamIds = process.env.STEAM_IDS.split(',').map(id => id.trim());
    let vinculados = 0;
    for (const steamId of steamIds) {
        const discordId = discordUsers[steamId];
        if (discordId && !db.steamLinks[discordId]) {
            db.steamLinks[discordId] = steamId;
            vinculados++;
            console.log(`🔗 Vinculado automaticamente: ${steamNames[steamId] || steamId} (${discordId}) -> ${steamId}`);
        }
    }
    if (vinculados > 0) {
        salvarDB(db);
        console.log(`✅ ${vinculados} vínculos automáticos realizados.`);
    } else {
        console.log(`ℹ️ Nenhum novo vínculo necessário.`);
    }

    try {
        const dono = await client.users.fetch(DONO_ID);
        if (dono) {
            await dono.send(`🚀 **Bot Steam Família está online!**\n⏰ Verificando a cada ${INTERVALO_VERIFICACAO / 1000} segundos\n🔍 Monitorando jogos e conquistas\n📊 Digite /ranking\n🔎 Use /tem [jogo]\n🛒 Use /quero [jogo] para ser notificado de promoções e lançamentos!\n🔄 Rate limiting ativo: ${rateLimiter.minDelay}ms entre requisições\n🧹 Mensagens antigas do bot foram limpas.`);
        }
    } catch (error) {
        console.error('❌ Erro ao enviar DM para o dono:', error);
    }

    console.log(`🏆 SISTEMA DE CONQUISTAS ATIVADO! Verificando a cada ${INTERVALO_VERIFICACAO / 1000} segundos`);

    // 🔹 Inicia a verificação inicial em background
    setImmediate(async () => {
        console.log('🎮 Iniciando verificação inicial...');
        await checkSteamGames();
    });

    console.log(`🔄 Iniciando monitoramento contínuo (${INTERVALO_VERIFICACAO / 1000}s)...`);

    setInterval(async () => {
        try {
            await checkSteamGames();
        } catch (error) {
            console.error('❌ Erro no intervalo:', error);
        }
    }, INTERVALO_VERIFICACAO);

    // Limpeza periódica de mensagens antigas (a cada 6 horas)
    setInterval(async () => {
        console.log('🧹 Limpeza periódica de mensagens antigas...');
        await limparMensagensAntigas();
    }, 6 * 60 * 60 * 1000);
});

// 🔹 ============================================
// 🔹 EVENTOS DE ERRO GLOBAL
// 🔹 ============================================
process.on('unhandledRejection', (error) => {
    console.error('❌ Unhandled Rejection:', error);
});

process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught Exception:', error);
    salvarDB(db);
});

// 🔹 ============================================
// 🔹 LOGIN
// 🔹 ============================================
client.login(process.env.DISCORD_TOKEN)
    .then(() => console.log('🔑 Login realizado com sucesso'))
    .catch(error => {
        console.error('❌ Erro ao fazer login:', error);
        process.exit(1);
    });

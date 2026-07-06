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
const MAX_RETRIES = 2;
const RETRY_DELAY = 1500;
const REQUEST_TIMEOUT = 8000;
const BATCH_SIZE = 5;
const CLEANUP_INTERVAL = 3600000; // 1 hora

// 🔹 Rate Limiter
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

// 🔹 IDs dos canais
const CHANNEL_NOTIFICACOES = process.env.CHANNEL_ID;
const CHANNEL_RANKING = "1523067407474757672";
const CHANNEL_CONQUISTAS = "1523080625802711150";

// 🔹 ID do dono
const DONO_ID = "336204841972137995";

// 🔹 Banco de dados (volume persistente)
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

// 🔹 Jogos incompatíveis (lista resumida para não repetir)
const JOGOS_INCOMPATIVEIS = {
    33930: "Arma 2: Operation Arrowhead",
    107410: "Arma 3",
    271590: "Grand Theft Auto V",
    1174180: "Red Dead Redemption 2",
    // ... adicione outros se necessário
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
// 🔹 FETCH COM AXIOS E RATE LIMITING (OTIMIZADO)
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
            throw new Error('HTML_RESPONSE');
        }
        if (response.status === 429 || response.status === 403) {
            const waitTime = RETRY_DELAY * (retryCount + 1) * 2;
            await new Promise(resolve => setTimeout(resolve, waitTime));
            if (retryCount < MAX_RETRIES) {
                return fetchWithTimeout(url, timeout, retryCount + 1);
            }
            throw new Error(`Rate limit excedido após ${MAX_RETRIES} tentativas`);
        }
        if (response.status >= 400) {
            throw new Error(`HTTP ${response.status}`);
        }
        return response.data;
    } catch (error) {
        if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
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
            if (!parsed.jogosSemConquistas) parsed.jogosSemConquistas = {};
            if (!parsed.listaQuero) parsed.listaQuero = {};
            if (!parsed.ultimaMensagemRankingId) parsed.ultimaMensagemRankingId = null;
            console.log(`📊 Banco de dados carregado.`);
            return parsed;
        }
    } catch (error) {
        console.error('❌ Erro ao carregar banco:', error);
        if (fs.existsSync(DB_FILE)) {
            const backupPath = `${DB_FILE}.backup_${Date.now()}`;
            fs.copyFileSync(DB_FILE, backupPath);
            console.log(`💾 Backup salvo em: ${backupPath}`);
        }
    }
    console.log('📝 Criando novo banco de dados...');
    return {
        conquistas: {},
        jogosRecentes: {},
        ranking: {},
        steamLinks: {},
        jogosSemConquistas: {},
        listaQuero: {},
        ultimaMensagemRankingId: null
    };
}

function salvarDB(db) {
    try {
        fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
        console.log(`💾 Banco de dados salvo.`);
    } catch (error) {
        console.error('❌ Erro ao salvar banco:', error);
    }
}

let db = carregarDB();
// Garantir campos
if (!db.conquistas) db.conquistas = {};
if (!db.jogosRecentes) db.jogosRecentes = {};
if (!db.ranking) db.ranking = {};
if (!db.steamLinks) db.steamLinks = {};
if (!db.jogosSemConquistas) db.jogosSemConquistas = {};
if (!db.listaQuero) db.listaQuero = {};
if (!db.ultimaMensagemRankingId) db.ultimaMensagemRankingId = null;

// 🔹 RANKING PADRÃO
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
        ranking = db.ranking;
        for (const [steamId, dados] of Object.entries(rankingPadrao)) {
            if (!ranking[steamId]) ranking[steamId] = dados;
        }
        console.log(`📊 Ranking carregado: ${Object.keys(ranking).length} usuários`);
        return;
    }
    ranking = JSON.parse(JSON.stringify(rankingPadrao));
    db.ranking = ranking;
    salvarDB(db);
}

let previousGames = {};
let ultimaMensagemRankingId = null;
let primeiraVerificacaoConcluida = false;

// 🔹 ============================================
// 🔹 FUNÇÕES AUXILIARES (BÁSICAS)
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
    const match = url.match(/store\.steampowered\.com\/app\/(\d+)/);
    return match ? parseInt(match[1]) : null;
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
    for (const steamId of steamIds) {
        try {
            const url = `https://api.steampowered.com/IPlayerService/GetOwnedGames/v0001/?key=${process.env.STEAM_KEY}&steamid=${steamId}&include_appinfo=true&include_played_free_games=true&format=json`;
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

async function verificarCompatibilidadeFamilia(appid) {
    if (compatibilidadeCache[appid] !== undefined) return compatibilidadeCache[appid];
    if (JOGOS_INCOMPATIVEIS[appid]) {
        compatibilidadeCache[appid] = false;
        return false;
    }
    // Por simplicidade, assume compatível, mas pode verificar steamdb se quiser
    compatibilidadeCache[appid] = true;
    return true;
}

async function contarDLCs(appid) {
    try {
        const url = `https://store.steampowered.com/api/appdetails?appids=${appid}&l=portuguese`;
        const data = await fetchWithTimeout(url, 8000);
        if (data[appid]?.success && data[appid].data.dlc) {
            return data[appid].data.dlc.length;
        }
        return 0;
    } catch (error) {
        console.error(`❌ Erro ao contar DLCs:`, error.message);
        return 0;
    }
}

async function buscarSugestoesJogos(termo) {
    if (!termo || termo.length === 0) {
        return [
            { name: 'Elden Ring', value: 'Elden Ring' },
            { name: 'Counter-Strike 2', value: 'Counter-Strike 2' },
            { name: 'Dying Light', value: 'Dying Light' },
            { name: 'Stardew Valley', value: 'Stardew Valley' }
        ];
    }
    try {
        const url = `https://store.steampowered.com/api/storesearch?term=${encodeURIComponent(termo)}&l=portuguese&cc=BR&max=50`;
        const data = await fetchWithTimeout(url, 8000);
        if (data.items && data.items.length > 0) {
            return data.items
                .filter(item => item.type === 'game' || item.type === 'dlc')
                .slice(0, 25)
                .map(item => ({ name: item.name, value: item.name }));
        }
        return [];
    } catch (error) {
        console.error('❌ Erro ao buscar sugestões:', error);
        return [];
    }
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
            console.log(`   ⏭️ ${gameName} ignorado (sem conquistas)`);
            continue;
        }

        try {
            const conquistas = await getAchievements(steamId, appid);
            if (!conquistas || conquistas.length === 0) {
                db.jogosSemConquistas[appid] = { nome: gameName, data: new Date().toISOString() };
                salvarDB(db);
                console.log(`   ⏭️ ${gameName} marcado como SEM CONQUISTAS`);
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
                        const iconUrl = iconName ? `https://shared.fastly.steamstatic.com/community_assets/images/apps/${appid}/${iconName}.jpg` : null;

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

                        if (iconUrl) embed.setImage(iconUrl);
                        await channelConquistas.send({ content: `🎉 **NOVA CONQUISTA!**`, embeds: [embed] });
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
                db.jogosSemConquistas[appid] = { nome: gameName, data: new Date().toISOString() };
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
// 🔹 FUNÇÕES: RANKING E COMANDOS BÁSICOS
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

async function enviarRanking() {
    db.ranking = ranking;
    salvarDB(db);
    const embedRanking = gerarRanking();
    const channel = client.channels.cache.get(CHANNEL_RANKING);
    if (!channel) return;
    try {
        if (ultimaMensagemRankingId) {
            try {
                const mensagemAntiga = await channel.messages.fetch(ultimaMensagemRankingId);
                if (mensagemAntiga) await mensagemAntiga.delete();
            } catch (error) {}
        }
        const novaMensagem = await channel.send({ embeds: [embedRanking] });
        ultimaMensagemRankingId = novaMensagem.id;
        db.ultimaMensagemRankingId = ultimaMensagemRankingId;
        salvarDB(db);
        console.log(`📊 Novo ranking enviado! ID: ${ultimaMensagemRankingId}`);
    } catch (error) {
        console.error(`❌ Erro ao enviar/atualizar ranking:`, error);
    }
}

// 🔹 ============================================
// 🔹 FUNÇÃO PRINCIPAL: checkSteamGames (SEM PROMOÇÕES)
// 🔹 ============================================
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
                    const oldNames = oldGames.map(g => g.name);
                    const newGames = currentGames.filter(g => !oldNames.includes(g.name));

                    if (newGames.length) {
                        console.log(`🎮 ${userName} +${newGames.length} novo(s) jogo(s)!`);
                        for (const game of newGames) {
                            const appid = game.appid;
                            const nome = game.name;
                            const link = `https://store.steampowered.com/app/${appid}`;
                            const isCompatible = await verificarCompatibilidadeFamilia(appid);
                            if (isCompatible) {
                                await channelNotificacoes.send(
                                    `@everyone 🎉 ${mention} comprou o jogo: **${nome}**\n🔗 ${link}\n✅ **Compatível com Família Steam!**`
                                );
                                if (ranking[trimmedId]) {
                                    ranking[trimmedId].jogos += 1;
                                    db.ranking = ranking;
                                    salvarDB(db);
                                    await enviarRanking();
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

        if (!primeiraVerificacaoConcluida) {
            primeiraVerificacaoConcluida = true;
            console.log('✅ PRIMEIRA VERIFICAÇÃO CONCLUÍDA!');
            console.log('🔍 Monitorando NOVAS conquistas em tempo real!');
            salvarDB(db);
            console.log('✅ SISTEMA INICIALIZADO!');
        }

        const duracao = ((Date.now() - inicio) / 1000).toFixed(1);
        console.log(`✅ [${new Date().toLocaleTimeString()}] CONCLUÍDO em ${duracao}s`);

    } catch (error) {
        console.error('❌ Erro geral:', error);
    }
}

// 🔹 ============================================
// 🔹 COMANDOS SLASH E INTERAÇÕES
// 🔹 ============================================
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

client.on('interactionCreate', async (interaction) => {
    if (interaction.isAutocomplete()) {
        if (interaction.commandName === 'tem') {
            const valorDigitado = interaction.options.getString('jogo')?.toLowerCase() || '';
            try {
                const sugestoes = await buscarSugestoesJogos(valorDigitado);
                await interaction.respond(sugestoes);
            } catch (error) {
                console.error('❌ Erro no autocomplete:', error);
                await interaction.respond([]);
            }
        }
        return;
    }

    if (!interaction.isChatInputCommand()) return;

    // Comando /tem
    if (interaction.commandName === 'tem') {
        const input = interaction.options.getString('jogo');
        await interaction.deferReply({ ephemeral: true });
        try {
            let jogo = null;
            if (input.includes('store.steampowered.com/app/')) {
                const appid = extrairAppIdDaUrl(input);
                if (appid) jogo = await buscarJogoPorAppId(appid);
            }
            if (!jogo) jogo = await buscarJogoSteam(input);
            if (!jogo) {
                return await interaction.editReply({ content: `❌ Não encontrei o jogo **${input}** na Steam.` });
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

            if (jogo.capa) embed.setThumbnail(jogo.capa);
            if (!compativel) {
                embed.addFields({ name: '⚠️ ATENÇÃO', value: '⚠️ **Este jogo NÃO tem suporte para Compartilhamento em Família!**', inline: false });
            }
            embed.addFields({ name: '📦 Conteúdos Adicionais (DLCs)', value: totalDLCs > 0 ? `Este jogo possui **${totalDLCs}** DLC(s).` : 'Este jogo não possui DLCs listadas.', inline: false });

            if (donos.length > 0) {
                let descricao = `🎮 **Encontrado na família!**\n👤 **${donos.length} membro(s) possui(em):**\n\n`;
                donos.forEach((dono, index) => {
                    const mencao = dono.discordId ? `<@${dono.discordId}>` : dono.nome;
                    descricao += `**${index + 1}. ${mencao}**\n`;
                });
                embed.setDescription(descricao);
            } else {
                embed.setDescription(`😕 **Nenhum membro da família possui este jogo.**`);
            }
            await interaction.editReply({ embeds: [embed] });
        } catch (error) {
            console.error('❌ Erro no comando /tem:', error);
            await interaction.editReply({ content: `❌ Ocorreu um erro ao buscar o jogo. Tente novamente.` });
        }
    }

    // Comando /ranking
    if (interaction.commandName === 'ranking') {
        await interaction.deferReply({ ephemeral: true });
        try {
            const embedRanking = gerarRanking();
            await interaction.editReply({ embeds: [embedRanking] });
        } catch (error) {
            console.error('❌ Erro no comando /ranking:', error);
            await interaction.editReply({ content: '❌ Ocorreu um erro ao gerar o ranking.' });
        }
    }

    // Comando /quero (adicionar)
    if (interaction.commandName === 'quero') {
        const nomeJogo = interaction.options.getString('jogo');
        await interaction.deferReply({ ephemeral: true });
        try {
            const jogo = await buscarJogoSteam(nomeJogo);
            if (!jogo) {
                return await interaction.editReply({ content: `❌ Não encontrei o jogo **${nomeJogo}** na Steam.` });
            }

            // Verifica se já possui
            const steamId = Object.keys(discordUsers).find(key => discordUsers[key] === interaction.user.id);
            if (steamId) {
                const url = `https://api.steampowered.com/IPlayerService/GetOwnedGames/v0001/?key=${process.env.STEAM_KEY}&steamid=${steamId}&include_appinfo=true&format=json`;
                const data = await fetchWithTimeout(url, 8000);
                if (data.response?.games) {
                    const temJogo = data.response.games.some(g => g.appid === jogo.appid);
                    if (temJogo) {
                        return await interaction.editReply({ content: `ℹ️ Você **já possui** **${jogo.nome}** na sua biblioteca!` });
                    }
                }
            }

            // Verifica se já está na lista
            if (!db.listaQuero[interaction.user.id]) db.listaQuero[interaction.user.id] = [];
            if (db.listaQuero[interaction.user.id].some(item => item.appid === jogo.appid)) {
                return await interaction.editReply({ content: `ℹ️ O jogo **${jogo.nome}** já está na sua lista /quero!` });
            }

            // Verifica se alguém da família tem
            const donos = await verificarJogoFamilia(jogo.appid);
            if (donos.length > 0) {
                return await interaction.editReply({ content: `ℹ️ O jogo **${jogo.nome}** já está na família!` });
            }

            db.listaQuero[interaction.user.id].push({
                appid: jogo.appid,
                nome: jogo.nome,
                link: jogo.url,
                adicionado_em: new Date().toISOString()
            });
            salvarDB(db);
            await interaction.editReply({ content: `✅ **${jogo.nome}** adicionado à sua lista /quero!` });
        } catch (error) {
            console.error('❌ Erro no comando /quero:', error);
            await interaction.editReply({ content: '❌ Ocorreu um erro ao adicionar o jogo.' });
        }
    }

    // Comando /quero-listar
    if (interaction.commandName === 'quero-listar') {
        await interaction.deferReply({ ephemeral: true });
        try {
            const lista = db.listaQuero[interaction.user.id] || [];
            if (lista.length === 0) {
                return await interaction.editReply({ content: '📭 Sua lista /quero está vazia.' });
            }
            const embed = new EmbedBuilder()
                .setColor(0x00AE86)
                .setTitle(`📋 Sua lista /quero (${lista.length} jogos)`)
                .setDescription(lista.map((jogo, i) => `**${i+1}.** [${jogo.nome}](${jogo.link})`).join('\n'))
                .setFooter({ text: 'Steam Família - Lista /quero' })
                .setTimestamp();
            if (embed.data.description.length > 4000) {
                await interaction.editReply({ content: `📋 **Sua lista /quero (${lista.length} jogos)**\n${lista.map((jogo, i) => `${i+1}. ${jogo.nome}`).join('\n')}` });
            } else {
                await interaction.editReply({ embeds: [embed] });
            }
        } catch (error) {
            console.error('❌ Erro no comando /quero-listar:', error);
            await interaction.editReply({ content: '❌ Ocorreu um erro ao listar os jogos.' });
        }
    }

    // Comando /quero-remover
    if (interaction.commandName === 'quero-remover') {
        const nomeJogo = interaction.options.getString('jogo');
        await interaction.deferReply({ ephemeral: true });
        try {
            const jogo = await buscarJogoSteam(nomeJogo);
            if (!jogo) {
                return await interaction.editReply({ content: `❌ Não encontrei o jogo **${nomeJogo}** na Steam.` });
            }
            const lista = db.listaQuero[interaction.user.id] || [];
            const index = lista.findIndex(item => item.appid === jogo.appid);
            if (index === -1) {
                return await interaction.editReply({ content: `ℹ️ O jogo **${jogo.nome}** não estava na sua lista /quero.` });
            }
            lista.splice(index, 1);
            db.listaQuero[interaction.user.id] = lista;
            salvarDB(db);
            await interaction.editReply({ content: `✅ **${jogo.nome}** removido da sua lista /quero!` });
        } catch (error) {
            console.error('❌ Erro no comando /quero-remover:', error);
            await interaction.editReply({ content: '❌ Ocorreu um erro ao remover o jogo.' });
        }
    }

    // Comando /dbstatus (somente dono)
    if (interaction.commandName === 'dbstatus') {
        if (interaction.user.id !== DONO_ID) {
            return await interaction.reply({ content: '❌ Apenas o dono pode usar este comando.', ephemeral: true });
        }
        await interaction.deferReply({ ephemeral: true });
        try {
            const totalQuero = Object.values(db.listaQuero).reduce((acc, arr) => acc + arr.length, 0);
            const totalSteamLinks = Object.keys(db.steamLinks).length;
            const totalNotificados = Object.keys(db.jogosSemConquistas).length;
            let mensagem = `📊 **Status do Banco de Dados:**\n\n`;
            mensagem += `📋 Lista /quero: **${totalQuero}** jogos\n`;
            mensagem += `🔗 Steam Links: **${totalSteamLinks}** usuários\n`;
            mensagem += `🚫 Jogos sem conquistas: **${totalNotificados}**\n`;
            mensagem += `💾 Arquivo: ${DB_FILE}\n`;
            mensagem += `📅 Última atualização: ${new Date().toLocaleString()}`;
            await interaction.editReply({ content: mensagem });
        } catch (error) {
            console.error('❌ Erro no comando /dbstatus:', error);
            await interaction.editReply({ content: '❌ Ocorreu um erro ao verificar o banco de dados.' });
        }
    }
});

// 🔹 ============================================
// 🔹 EVENTO: MENSAGENS (COMANDO !resetranking)
// 🔹 ============================================
client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    if (message.content.toLowerCase() === '!resetranking') {
        if (message.author.id !== DONO_ID) {
            return await message.reply({ content: '❌ Você não tem permissão!', ephemeral: true });
        }
        await message.reply({ content: '⚠️ Digite `!confirmar` em até 30 segundos para resetar o ranking.', ephemeral: true });
        const coletor = message.channel.createMessageCollector({
            filter: m => m.author.id === message.author.id && m.content.toLowerCase() === '!confirmar',
            max: 1,
            time: 30000
        });
        coletor.on('collect', async () => {
            ranking = JSON.parse(JSON.stringify(rankingPadrao));
            db.ranking = ranking;
            salvarDB(db);
            await enviarRanking();
            await message.reply({ content: '✅ Ranking resetado para os valores padrão!', ephemeral: true });
        });
        coletor.on('end', collected => {
            if (collected.size === 0) message.reply({ content: '⏰ Tempo esgotado. Reset cancelado.', ephemeral: true });
        });
    }
});

// 🔹 ============================================
// 🔹 RESTAURAR RANKING DO CANAL (SE NECESSÁRIO)
// 🔹 ============================================
async function restaurarRankingDoCanal() {
    const channel = client.channels.cache.get(CHANNEL_RANKING);
    if (!channel) return false;
    try {
        const ultimaMensagemId = db.ultimaMensagemRankingId;
        if (!ultimaMensagemId) return false;
        const mensagem = await channel.messages.fetch(ultimaMensagemId);
        if (!mensagem) return false;
        const embed = mensagem.embeds[0];
        if (!embed || !embed.description) return false;
        const linhas = embed.description.split('\n');
        const rankingRestaurado = {};
        for (const linha of linhas) {
            const match = linha.match(/(?:🥇|🥈|🥉|\d+°)\s+<@!?(\d+)>\s+—\s+(\d+)\s+jogos/);
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
                        break;
                    }
                }
            }
        }
        if (Object.keys(rankingRestaurado).length > 0) {
            ranking = rankingRestaurado;
            db.ranking = ranking;
            salvarDB(db);
            console.log(`✅ Ranking restaurado do canal.`);
            return true;
        }
        return false;
    } catch (error) {
        console.error('❌ Erro ao restaurar ranking:', error);
        return false;
    }
}

// 🔹 ============================================
// 🔹 HEALTH CHECK (RESPOSTA RÁPIDA)
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
// 🔹 LIMPEZA DE CACHES
// 🔹 ============================================
setInterval(() => {
    const agora = Date.now();
    for (const [key, value] of Object.entries(gameNameCache)) {
        if (value.timestamp && agora - value.timestamp > CLEANUP_INTERVAL) {
            delete gameNameCache[key];
        }
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
// 🔹 CLIENT READY
// 🔹 ============================================
client.once('clientReady', async () => {
    console.log(`✅ Bot online como ${client.user.tag}`);
    console.log(`📡 Conectado em ${client.guilds.cache.size} servidor(es)`);

    await registrarComandos();

    console.log(`⏰ Intervalo: ${INTERVALO_VERIFICACAO / 1000} segundos`);
    console.log(`💾 Banco de dados: ${DB_FILE}`);
    console.log(`🔄 Rate limit: ${rateLimiter.minDelay}ms entre requisições`);

    // Restaurar ranking
    const rankingRestaurado = await restaurarRankingDoCanal();
    if (!rankingRestaurado) {
        console.log('ℹ️ Usando ranking do banco de dados (ou valores padrão).');
        carregarRanking();
    }

    // Vincular automaticamente
    const steamIds = process.env.STEAM_IDS.split(',').map(id => id.trim());
    let vinculados = 0;
    for (const steamId of steamIds) {
        const discordId = discordUsers[steamId];
        if (discordId && !db.steamLinks[discordId]) {
            db.steamLinks[discordId] = steamId;
            vinculados++;
            console.log(`🔗 Vinculado automaticamente: ${steamNames[steamId] || steamId}`);
        }
    }
    if (vinculados > 0) {
        salvarDB(db);
        console.log(`✅ ${vinculados} vínculos automáticos realizados.`);
    }

    try {
        const dono = await client.users.fetch(DONO_ID);
        if (dono) {
            await dono.send(`🚀 **Bot Steam Família está online!**\n⏰ Verificando a cada ${INTERVALO_VERIFICACAO / 1000} segundos\n📊 Digite /ranking\n🔎 Use /tem [jogo]\n🛒 Use /quero [jogo]`);
        }
    } catch (error) {
        console.error('❌ Erro ao enviar DM para o dono:', error);
    }

    console.log(`🏆 SISTEMA DE CONQUISTAS ATIVADO!`);

    // Iniciar verificação inicial em background
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
});

// 🔹 ============================================
// 🔹 TRATAMENTO DE ERROS GLOBAIS
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

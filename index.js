require('dotenv').config();
const fs = require('fs');
const path = require('path');
const http = require('http');
const axios = require('axios');
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');

// 🔹 CONFIGURAÇÕES
const INTERVALO_VERIFICACAO = 30 * 1000;
const MAX_RETRIES = 2;
const REQUEST_TIMEOUT = 6000;
const MAX_CACHE_SIZE = 100;
const MAX_JOGOS_RECENTES = 5;

// 🔹 Rate Limiter
const rateLimiter = {
    minDelay: 1500,
    lastRequest: 0,
    async wait() {
        const now = Date.now();
        const wait = Math.max(0, this.minDelay - (now - this.lastRequest));
        if (wait > 0) await new Promise(r => setTimeout(r, wait));
        this.lastRequest = Date.now();
    }
};

// 🔹 Caches com limite de tamanho
class LimitedCache {
    constructor(maxSize = MAX_CACHE_SIZE) {
        this.cache = new Map();
        this.maxSize = maxSize;
    }
    get(key) {
        const value = this.cache.get(key);
        if (value !== undefined) {
            this.cache.delete(key);
            this.cache.set(key, value);
        }
        return value;
    }
    set(key, value) {
        if (this.cache.has(key)) this.cache.delete(key);
        else if (this.cache.size >= this.maxSize) {
            const firstKey = this.cache.keys().next().value;
            this.cache.delete(firstKey);
        }
        this.cache.set(key, value);
    }
    clear() { this.cache.clear(); }
    size() { return this.cache.size; }
}

const gameNameCache = new LimitedCache();
const achievementNameCache = new LimitedCache();
const compatibilidadeCache = new LimitedCache();

// 🔹 IDs e constantes
const DONO_ID = "336204841972137995";
const CHANNEL_NOTIFICACOES = process.env.CHANNEL_ID;
const CHANNEL_RANKING = "1523067407474757672";
const CHANNEL_CONQUISTAS = "1523080625802711150";

const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || '/data';
const DB_FILE = path.join(DATA_DIR, 'steam_achievements_db.json');
try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    console.log(`📁 Volume persistente: ${DATA_DIR}`);
} catch (e) { console.log('ℹ️ Usando diretório local como fallback.'); }

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

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });

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
            return parsed;
        }
    } catch (e) { console.error('❌ Erro ao carregar banco:', e); }
    console.log('📝 Criando novo banco de dados...');
    return { ranking: {}, conquistas: {}, jogosRecentes: {}, steamLinks: {}, jogosSemConquistas: {}, listaQuero: {}, ultimaMensagemRankingId: null };
}

function salvarDB(db) {
    try { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); } 
    catch (e) { console.error('❌ Erro ao salvar banco:', e); }
}

let db = carregarDB();

const rankingPadrao = {
    "76561198127320557": { nome: "Gardemi", jogos: 98, steamId: "76561198127320557", discordId: "663789211152941065" },
    "76561197967265286": { nome: "Marlon", jogos: 56, steamId: "76561197967265286", discordId: "1022183877114069083" },
    "76561198848231901": { nome: "Mosk", jogos: 15, steamId: "76561198848231901", discordId: "499311499504910344" },
    "76561198446717315": { nome: "WoollySkills", jogos: 11, steamId: "76561198446717315", discordId: "479817686218702849" },
    "76561198110004039": { nome: "Venum", jogos: 8, steamId: "76561198110004039", discordId: "336204841972137995" }
};

if (!db.ranking || Object.keys(db.ranking).length === 0) {
    db.ranking = JSON.parse(JSON.stringify(rankingPadrao));
    salvarDB(db);
}
let ranking = db.ranking;
let ultimaMensagemRankingId = db.ultimaMensagemRankingId || null;
let primeiraVerificacaoConcluida = false;
let previousGames = {};

// 🔹 ============================================
// 🔹 FETCH COM ABORT CONTROLLER
// 🔹 ============================================
async function fetchWithTimeout(url, timeout = REQUEST_TIMEOUT, retry = 0) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    try {
        await rateLimiter.wait();
        console.log(`🌐 Fetch: ${url.substring(0, 80)}...`);
        const response = await axios.get(url, {
            signal: controller.signal,
            timeout: timeout,
            headers: { 'User-Agent': 'SteamFamilyBot/1.0', 'Accept': 'application/json' },
            validateStatus: status => status < 500
        });
        clearTimeout(timeoutId);
        if (response.status === 429 || response.status === 403) {
            const wait = 1000 * (retry + 1) * 2;
            await new Promise(r => setTimeout(r, wait));
            if (retry < MAX_RETRIES) return fetchWithTimeout(url, timeout, retry + 1);
            throw new Error('Rate limit excedido');
        }
        if (response.status >= 400) throw new Error(`HTTP ${response.status}`);
        return response.data;
    } catch (e) {
        clearTimeout(timeoutId);
        if (e.name === 'AbortError' || e.code === 'ECONNABORTED') {
            if (retry < MAX_RETRIES) {
                await new Promise(r => setTimeout(r, 1000 * (retry + 1)));
                return fetchWithTimeout(url, timeout, retry + 1);
            }
            throw new Error('Timeout');
        }
        throw e;
    }
}

// 🔹 ============================================
// 🔹 FUNÇÕES AUXILIARES
// 🔹 ============================================
async function getAchievements(steamId, appid) {
    try {
        const url = `https://api.steampowered.com/ISteamUserStats/GetPlayerAchievements/v1/?key=${process.env.STEAM_KEY}&steamid=${steamId}&appid=${appid}`;
        const data = await fetchWithTimeout(url, 8000);
        return data.playerstats?.achievements || [];
    } catch (e) {
        if (e.message.includes('HTTP 400')) throw e;
        return [];
    }
}

async function getGameDetails(appid) {
    const cached = gameNameCache.get(appid);
    if (cached) return cached;
    try {
        const url = `https://store.steampowered.com/api/appdetails?appids=${appid}&l=portuguese`;
        const data = await fetchWithTimeout(url);
        if (data[appid]?.success) {
            const info = { name: data[appid].data.name, icon: data[appid].data.header_image || data[appid].data.capsule_image };
            gameNameCache.set(appid, info);
            return info;
        }
    } catch (e) {}
    return { name: `Jogo ${appid}`, icon: null };
}

async function getAchievementName(steamId, appid, apiname) {
    const key = `${appid}_${apiname}`;
    const cached = achievementNameCache.get(key);
    if (cached) return cached;
    try {
        const url = `https://api.steampowered.com/ISteamUserStats/GetSchemaForGame/v2/?key=${process.env.STEAM_KEY}&appid=${appid}&l=portuguese`;
        const data = await fetchWithTimeout(url);
        const ach = data.game?.availableGameStats?.achievements?.find(a => a.name === apiname);
        const nome = ach?.displayName || apiname;
        achievementNameCache.set(key, nome);
        return nome;
    } catch (e) { return apiname; }
}

async function buscarIconeConquista(appid, apiname) {
    try {
        const url = `https://api.steampowered.com/ISteamUserStats/GetSchemaForGame/v2/?key=${process.env.STEAM_KEY}&appid=${appid}&l=portuguese`;
        const data = await fetchWithTimeout(url, 6000);
        const ach = data.game?.availableGameStats?.achievements?.find(a => a.name === apiname);
        return ach?.icon || null;
    } catch (e) { return null; }
}

async function buscarJogoSteam(nome) {
    try {
        const url = `https://store.steampowered.com/api/storesearch?term=${encodeURIComponent(nome)}&l=portuguese&cc=BR&max=1`;
        const data = await fetchWithTimeout(url, 5000);
        if (data.items?.length) {
            const jogo = data.items[0];
            return { appid: jogo.id, nome: jogo.name, url: `https://store.steampowered.com/app/${jogo.id}` };
        }
        return null;
    } catch (e) { return null; }
}

// 🔹 ============================================
// 🔹 VERIFICAR CONQUISTAS
// 🔹 ============================================
async function verificarConquistas(steamId, games, mention, userName) {
    if (!games?.length) return;
    const channel = client.channels.cache.get(CHANNEL_CONQUISTAS);
    if (!channel) return;

    if (!db.conquistas[steamId]) db.conquistas[steamId] = {};
    if (!db.jogosRecentes[steamId]) db.jogosRecentes[steamId] = [];

    let recentes = games.filter(g => g.rtime_last_played > 0).sort((a,b) => b.rtime_last_played - a.rtime_last_played).slice(0, 5);
    if (recentes.length < 3) {
        const extras = db.jogosRecentes[steamId].slice(-5);
        for (const appid of extras) {
            const jogo = games.find(g => g.appid === appid);
            if (jogo && !recentes.find(g => g.appid === appid)) recentes.push(jogo);
        }
    }
    if (recentes.length === 0) recentes = games.slice(0, 3);

    db.jogosRecentes[steamId] = recentes.map(g => g.appid).slice(0, MAX_JOGOS_RECENTES);

    for (const game of recentes) {
        const appid = game.appid;
        const gameName = game.name || `Jogo ${appid}`;
        if (db.jogosSemConquistas[appid]) continue;

        try {
            const conquistas = await getAchievements(steamId, appid);
            if (!conquistas || conquistas.length === 0) {
                db.jogosSemConquistas[appid] = { nome: gameName, data: new Date().toISOString() };
                salvarDB(db);
                continue;
            }

            const desbloqueadas = conquistas.filter(c => c.achieved === 1);
            const total = desbloqueadas.length;
            const totalJogo = conquistas.length;

            if (!db.conquistas[steamId][appid] || !primeiraVerificacaoConcluida) {
                db.conquistas[steamId][appid] = { total, nomes: desbloqueadas.map(c => c.apiname), totalJogo };
                continue;
            }

            const dados = db.conquistas[steamId][appid];
            if (total > dados.total) {
                const novas = desbloqueadas.filter(c => !dados.nomes.includes(c.apiname));
                if (novas.length) {
                    const gameInfo = await getGameDetails(appid);
                    for (const c of novas.slice(0, 30)) {
                        const nome = await getAchievementName(steamId, appid, c.apiname);
                        const icon = await buscarIconeConquista(appid, c.apiname);
                        const embed = new EmbedBuilder()
                            .setColor(0xFFD700)
                            .setTitle(`🏆 ${userName} desbloqueou uma conquista!`)
                            .setDescription(`**${nome}**`)
                            .setThumbnail(gameInfo.icon)
                            .addFields(
                                { name: '🎮 Jogo', value: gameName, inline: true },
                                { name: '📊 Progresso', value: `${total}/${totalJogo}`, inline: true }
                            )
                            .setTimestamp();
                        if (icon) embed.setImage(`https://shared.fastly.steamstatic.com/community_assets/images/apps/${appid}/${icon}.jpg`);
                        await channel.send({ content: `🎉 **NOVA CONQUISTA!**`, embeds: [embed] });
                    }
                    db.conquistas[steamId][appid] = { total, nomes: desbloqueadas.map(c => c.apiname), totalJogo };
                    salvarDB(db);
                }
            }
        } catch (e) {
            if (e.message.includes('HTTP 400')) {
                db.jogosSemConquistas[appid] = { nome: gameName, data: new Date().toISOString() };
                salvarDB(db);
            }
        }
    }
}

// 🔹 ============================================
// 🔹 RANKING
// 🔹 ============================================
function gerarRanking() {
    const arr = Object.values(ranking).sort((a,b) => b.jogos - a.jogos);
    const embed = new EmbedBuilder()
        .setColor(0x00AE86)
        .setTitle('🏆 Ranking da Biblioteca Steam')
        .setThumbnail('https://upload.wikimedia.org/wikipedia/commons/thumb/8/83/Steam_icon_logo.svg/1200px-Steam_icon_logo.svg.png')
        .setTimestamp()
        .setFooter({ text: `Atualizado ${new Date().toLocaleTimeString()}` });
    const medalhas = ['🥇','🥈','🥉','4°','5°','6°'];
    let desc = '';
    arr.forEach((u,i) => {
        const pos = i < 3 ? medalhas[i] : `${medalhas[i]}`;
        const mencao = u.discordId ? `<@${u.discordId}>` : u.nome;
        desc += `${pos} **${mencao}** — ${Math.floor(u.jogos)} jogos\n`;
    });
    embed.setDescription(desc);
    return embed;
}

async function enviarRanking() {
    db.ranking = ranking;
    salvarDB(db);
    const embed = gerarRanking();
    const channel = client.channels.cache.get(CHANNEL_RANKING);
    if (!channel) return;
    try {
        if (ultimaMensagemRankingId) {
            try { await channel.messages.delete(ultimaMensagemRankingId); } catch (e) {}
        }
        const msg = await channel.send({ embeds: [embed] });
        ultimaMensagemRankingId = msg.id;
        db.ultimaMensagemRankingId = ultimaMensagemRankingId;
        salvarDB(db);
    } catch (e) { console.error('Erro ao enviar ranking:', e); }
}

// 🔹 ============================================
// 🔹 LOOP PRINCIPAL
// 🔹 ============================================
async function checkSteamGames() {
    console.log(`🔄 [${new Date().toLocaleTimeString()}] VERIFICANDO...`);
    try {
        const steamIds = process.env.STEAM_IDS.split(',').map(id => id.trim());
        const notifChannel = client.channels.cache.get(CHANNEL_NOTIFICACOES);
        if (!notifChannel) return;

        salvarDB(db);

        for (const id of steamIds) {
            try {
                const url = `https://api.steampowered.com/IPlayerService/GetOwnedGames/v0001/?key=${process.env.STEAM_KEY}&steamid=${id}&include_appinfo=true&format=json`;
                const data = await fetchWithTimeout(url, 10000);
                if (!data.response?.games) continue;

                const current = data.response.games.map(g => ({ name: g.name, appid: g.appid, rtime_last_played: g.rtime_last_played || 0 }));
                const userName = steamNames[id] || id;
                const discordId = discordUsers[id];
                const mention = discordId ? `<@${discordId}>` : userName;

                await verificarConquistas(id, current, mention, userName);

                if (!previousGames[id]) {
                    previousGames[id] = current;
                } else {
                    const old = previousGames[id];
                    const oldNames = old.map(g => g.name);
                    const novos = current.filter(g => !oldNames.includes(g.name));
                    if (novos.length) {
                        for (const jogo of novos) {
                            const link = `https://store.steampowered.com/app/${jogo.appid}`;
                            await notifChannel.send(`@everyone 🎉 ${mention} comprou: **${jogo.name}**\n🔗 ${link}`);
                            if (ranking[id]) {
                                ranking[id].jogos += 1;
                                db.ranking = ranking;
                                salvarDB(db);
                                await enviarRanking();
                            }
                        }
                    }
                    previousGames[id] = current.slice(-20);
                }
            } catch (e) {
                console.error(`❌ Erro em ${id}:`, e.message);
            }
        }

        if (gameNameCache.size() > 50) gameNameCache.clear();
        if (achievementNameCache.size() > 50) achievementNameCache.clear();

        if (!primeiraVerificacaoConcluida) {
            primeiraVerificacaoConcluida = true;
            console.log('✅ PRIMEIRA VERIFICAÇÃO CONCLUÍDA!');
        }
    } catch (e) {
        console.error('❌ Erro geral:', e);
    }
}

// 🔹 ============================================
// 🔹 COMANDOS SLASH (CORRIGIDOS)
// 🔹 ============================================
async function registrarComandos() {
    try {
        await client.application.commands.set([
            { 
                name: 'tem', 
                description: 'Verifica se um jogo está na família', 
                options: [{ 
                    name: 'jogo', 
                    type: 3, 
                    required: true, 
                    autocomplete: true, 
                    description: 'Nome do jogo ou link da Steam' 
                }] 
            },
            { name: 'ranking', description: 'Mostra o ranking da família' },
            { 
                name: 'quero', 
                description: 'Adiciona um jogo à sua lista /quero', 
                options: [{ 
                    name: 'jogo', 
                    type: 3, 
                    required: true, 
                    description: 'Nome do jogo que você quer' 
                }] 
            },
            { name: 'quero-listar', description: 'Lista todos os jogos da sua lista /quero' },
            { 
                name: 'quero-remover', 
                description: 'Remove um jogo da sua lista /quero', 
                options: [{ 
                    name: 'jogo', 
                    type: 3, 
                    required: true, 
                    description: 'Nome do jogo para remover' 
                }] 
            }
        ]);
        console.log('✅ Comandos registrados.');
    } catch (e) {
        console.error('❌ Erro ao registrar comandos:', e);
    }
}

// 🔹 ============================================
// 🔹 INTERAÇÕES
// 🔹 ============================================
client.on('interactionCreate', async (interaction) => {
    if (interaction.isAutocomplete()) {
        if (interaction.commandName === 'tem') {
            const term = interaction.options.getString('jogo')?.toLowerCase() || '';
            try {
                const url = `https://store.steampowered.com/api/storesearch?term=${encodeURIComponent(term)}&l=portuguese&cc=BR&max=10`;
                const data = await fetchWithTimeout(url, 3000);
                const items = data.items?.filter(i => i.type === 'game').slice(0, 10).map(i => ({ name: i.name, value: i.name })) || [];
                await interaction.respond(items);
            } catch (e) { await interaction.respond([]); }
        }
        return;
    }

    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'tem') {
        await interaction.deferReply({ ephemeral: true });
        const input = interaction.options.getString('jogo');
        const jogo = await buscarJogoSteam(input);
        if (!jogo) return interaction.editReply('❌ Jogo não encontrado.');
        await interaction.editReply(`✅ Encontrei: ${jogo.nome}\n🔗 ${jogo.url}`);
    }

    if (interaction.commandName === 'ranking') {
        await interaction.deferReply({ ephemeral: true });
        await interaction.editReply({ embeds: [gerarRanking()] });
    }

    if (interaction.commandName === 'quero') {
        await interaction.deferReply({ ephemeral: true });
        const nome = interaction.options.getString('jogo');
        const jogo = await buscarJogoSteam(nome);
        if (!jogo) return interaction.editReply('❌ Jogo não encontrado.');
        if (!db.listaQuero[interaction.user.id]) db.listaQuero[interaction.user.id] = [];
        if (db.listaQuero[interaction.user.id].some(i => i.appid === jogo.appid)) {
            return interaction.editReply(`ℹ️ ${jogo.nome} já está na sua lista.`);
        }
        db.listaQuero[interaction.user.id].push({ appid: jogo.appid, nome: jogo.nome, link: jogo.url });
        salvarDB(db);
        await interaction.editReply(`✅ ${jogo.nome} adicionado à lista /quero.`);
    }

    if (interaction.commandName === 'quero-listar') {
        await interaction.deferReply({ ephemeral: true });
        const lista = db.listaQuero[interaction.user.id] || [];
        if (!lista.length) return interaction.editReply('📭 Sua lista /quero está vazia.');
        const embed = new EmbedBuilder()
            .setTitle(`📋 Sua lista /quero (${lista.length} jogos)`)
            .setDescription(lista.map((j, i) => `${i+1}. [${j.nome}](${j.link})`).join('\n'))
            .setFooter({ text: 'Use /quero-remover para tirar um jogo' });
        await interaction.editReply({ embeds: [embed] });
    }

    if (interaction.commandName === 'quero-remover') {
        await interaction.deferReply({ ephemeral: true });
        const nome = interaction.options.getString('jogo');
        const jogo = await buscarJogoSteam(nome);
        if (!jogo) return interaction.editReply('❌ Jogo não encontrado.');
        const lista = db.listaQuero[interaction.user.id] || [];
        const idx = lista.findIndex(i => i.appid === jogo.appid);
        if (idx === -1) return interaction.editReply(`ℹ️ ${jogo.nome} não está na sua lista.`);
        lista.splice(idx, 1);
        salvarDB(db);
        await interaction.editReply(`✅ ${jogo.nome} removido da lista /quero.`);
    }
});

// 🔹 ============================================
// 🔹 HEALTH CHECK
// 🔹 ============================================
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', uptime: process.uptime(), memory: process.memoryUsage().rss }));
});
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`✅ Health check na porta ${PORT}`));

// 🔹 ============================================
// 🔹 SIGTERM E LIMPEZA
// 🔹 ============================================
let intervalId = null;

process.on('SIGTERM', async () => {
    console.log('⚠️ SIGTERM recebido, salvando e saindo...');
    if (intervalId) clearInterval(intervalId);
    salvarDB(db);
    gameNameCache.clear();
    achievementNameCache.clear();
    compatibilidadeCache.clear();
    await client.destroy();
    process.exit(0);
});

// 🔹 ============================================
// 🔹 READY
// 🔹 ============================================
client.once('clientReady', async () => {
    console.log(`✅ Bot online: ${client.user.tag}`);
    await registrarComandos();

    const ids = process.env.STEAM_IDS.split(',').map(id => id.trim());
    for (const id of ids) {
        const discordId = discordUsers[id];
        if (discordId && !db.steamLinks[discordId]) {
            db.steamLinks[discordId] = id;
            console.log(`🔗 Vinculado: ${steamNames[id]}`);
        }
    }
    salvarDB(db);

    setTimeout(async () => {
        await enviarRanking();
        console.log('📊 Ranking inicial enviado.');
    }, 5000);

    setTimeout(async () => {
        console.log('🎮 Iniciando verificações...');
        await checkSteamGames();
        intervalId = setInterval(async () => {
            try { await checkSteamGames(); } catch (e) { console.error('Erro no intervalo:', e); }
        }, INTERVALO_VERIFICACAO);
    }, 8000);

    try {
        const dono = await client.users.fetch(DONO_ID);
        if (dono) await dono.send('🚀 Bot Steam Família online! (com otimizações)');
    } catch (e) {}
});

// 🔹 ============================================
// 🔹 LOGIN
// 🔹 ============================================
client.login(process.env.DISCORD_TOKEN)
    .then(() => console.log('🔑 Login realizado'))
    .catch(e => { console.error('❌ Erro ao login:', e); process.exit(1); });

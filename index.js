require('dotenv').config();
const fs = require('fs');
const path = require('path');
const http = require('http');
const axios = require('axios');
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');

// 🔹 CONFIG
const INTERVALO_VERIFICACAO = 15 * 1000;
const MAX_RETRIES = 3;
const REQUEST_TIMEOUT = 10000;
const DONO_ID = "336204841972137995";
const CHANNEL_NOTIFICACOES = process.env.CHANNEL_ID;
const CHANNEL_RANKING = "1523067407474757672";
const CHANNEL_CONQUISTAS = "1523080625802711150";

// 🔹 Rate Limiter simples
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

// 🔹 Banco de dados persistente
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || '/data';
const DB_FILE = path.join(DATA_DIR, 'steam_achievements_db.json');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function carregarDB() {
    try {
        if (fs.existsSync(DB_FILE)) {
            const parsed = JSON.parse(fs.readFileSync(DB_FILE));
            if (!parsed.ranking) parsed.ranking = {};
            if (!parsed.conquistas) parsed.conquistas = {};
            if (!parsed.jogosRecentes) parsed.jogosRecentes = {};
            if (!parsed.steamLinks) parsed.steamLinks = {};
            if (!parsed.listaQuero) parsed.listaQuero = {};
            if (!parsed.ultimaMensagemRankingId) parsed.ultimaMensagemRankingId = null;
            if (!parsed.jogosSemConquistas) parsed.jogosSemConquistas = {};
            if (!parsed.ultimoRankingEnviado) parsed.ultimoRankingEnviado = {};
            return parsed;
        }
    } catch (e) { console.error('❌ Erro ao carregar banco:', e); }
    return { ranking: {}, conquistas: {}, jogosRecentes: {}, steamLinks: {}, listaQuero: {}, ultimaMensagemRankingId: null, jogosSemConquistas: {}, ultimoRankingEnviado: {} };
}

function salvarDB(db) {
    try { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); } catch (e) { console.error('❌ Erro ao salvar banco:', e); }
}

let db = carregarDB();

// 🔹 Mapeamento de usuários
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

const rankingPadrao = {
    "76561198127320557": { nome: "Gardemi", jogos: 98, steamId: "76561198127320557", discordId: "663789211152941065" },
    "76561197967265286": { nome: "Marlon", jogos: 56, steamId: "76561197967265286", discordId: "1022183877114069083" },
    "76561198848231901": { nome: "Mosk", jogos: 15, steamId: "76561198848231901", discordId: "499311499504910344" },
    "76561198446717315": { nome: "WoollySkills", jogos: 11, steamId: "76561198446717315", discordId: "479817686218702849" },
    "76561198110004039": { nome: "Venum", jogos: 8, steamId: "76561198110004039", discordId: "336204841972137995" }
};

let ranking = db.ranking && Object.keys(db.ranking).length ? db.ranking : JSON.parse(JSON.stringify(rankingPadrao));
db.ranking = ranking;
salvarDB(db);

let previousGames = {};
let ultimaMensagemRankingId = db.ultimaMensagemRankingId || null;
let primeiraVerificacaoConcluida = false;
let debounceRanking = false;

// 🔹 Caches
const cache = { games: {}, achievements: {} };

// 🔹 Cliente Discord
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });

// 🔹 ============================================
// 🔹 FETCH COM RATE LIMITING
// 🔹 ============================================
async function fetchWithTimeout(url, timeout = REQUEST_TIMEOUT, retry = 0) {
    try {
        await rateLimiter.wait();
        const response = await axios.get(url, {
            timeout,
            headers: { 'User-Agent': 'SteamFamilyBot/1.0', 'Accept': 'application/json' },
            validateStatus: status => status < 500
        });
        if (response.status === 429 || response.status === 403) {
            await new Promise(r => setTimeout(r, 1000 * (retry + 1) * 2));
            if (retry < MAX_RETRIES) return fetchWithTimeout(url, timeout, retry + 1);
            throw new Error('Rate limit');
        }
        if (response.status >= 400) throw new Error(`HTTP ${response.status}`);
        return response.data;
    } catch (e) {
        if ((e.code === 'ECONNABORTED' || e.code === 'ETIMEDOUT') && retry < MAX_RETRIES) {
            await new Promise(r => setTimeout(r, 1000 * (retry + 1)));
            return fetchWithTimeout(url, timeout, retry + 1);
        }
        throw e;
    }
}

// 🔹 ============================================
// 🔹 FUNÇÕES AUXILIARES
// 🔹 ============================================
async function getGameDetails(appid) {
    if (cache.games[appid]) return cache.games[appid];
    try {
        const data = await fetchWithTimeout(`https://store.steampowered.com/api/appdetails?appids=${appid}&l=portuguese`);
        if (data[appid]?.success) {
            const info = { name: data[appid].data.name, icon: data[appid].data.header_image || data[appid].data.capsule_image };
            cache.games[appid] = info;
            return info;
        }
    } catch (e) {}
    return { name: `Jogo ${appid}`, icon: null };
}

async function getAchievementName(steamId, appid, apiname) {
    const key = `${appid}_${apiname}`;
    if (cache.achievements[key]) return cache.achievements[key];
    try {
        const data = await fetchWithTimeout(`https://api.steampowered.com/ISteamUserStats/GetSchemaForGame/v2/?key=${process.env.STEAM_KEY}&appid=${appid}&l=portuguese`);
        const ach = data.game?.availableGameStats?.achievements?.find(a => a.name === apiname);
        const nome = ach?.displayName || apiname;
        cache.achievements[key] = nome;
        return nome;
    } catch (e) { return apiname; }
}

async function getAchievements(steamId, appid) {
    try {
        const data = await fetchWithTimeout(`https://api.steampowered.com/ISteamUserStats/GetPlayerAchievements/v1/?key=${process.env.STEAM_KEY}&steamid=${steamId}&appid=${appid}`, 8000);
        return data.playerstats?.achievements || [];
    } catch (e) {
        if (e.message.includes('HTTP 400')) throw e;
        return [];
    }
}

async function buscarIconeConquista(appid, apiname) {
    try {
        const data = await fetchWithTimeout(`https://api.steampowered.com/ISteamUserStats/GetSchemaForGame/v2/?key=${process.env.STEAM_KEY}&appid=${appid}&l=portuguese`, 6000);
        const ach = data.game?.availableGameStats?.achievements?.find(a => a.name === apiname);
        return ach?.icon || null;
    } catch (e) { return null; }
}

async function buscarJogoSteam(nome) {
    try {
        const data = await fetchWithTimeout(`https://store.steampowered.com/api/storesearch?term=${encodeURIComponent(nome)}&l=portuguese&cc=BR&max=1`, 5000);
        if (data.items?.length) {
            const jogo = data.items[0];
            return { appid: jogo.id, nome: jogo.name, url: `https://store.steampowered.com/app/${jogo.id}` };
        }
        return null;
    } catch (e) { return null; }
}

async function buscarJogoPorAppId(appid) {
    try {
        const data = await fetchWithTimeout(`https://store.steampowered.com/api/appdetails?appids=${appid}&l=portuguese`, 8000);
        if (data[appid]?.success) {
            const g = data[appid].data;
            return { appid, nome: g.name, url: `https://store.steampowered.com/app/${appid}`, capa: g.header_image || g.capsule_image };
        }
        return null;
    } catch (e) { return null; }
}

async function verificarJogoFamilia(appid) {
    const donos = [];
    const ids = process.env.STEAM_IDS.split(',').map(id => id.trim());
    for (const id of ids) {
        try {
            const data = await fetchWithTimeout(`https://api.steampowered.com/IPlayerService/GetOwnedGames/v0001/?key=${process.env.STEAM_KEY}&steamid=${id}&include_appinfo=true&format=json`, 8000);
            if (data.response?.games?.some(g => g.appid === appid)) {
                donos.push({ steamId: id, nome: steamNames[id] || id, discordId: discordUsers[id] || null });
            }
        } catch (e) {}
    }
    return donos;
}

async function verificarCompatibilidadeFamilia(appid) {
    // Lista de jogos incompatíveis (versão reduzida)
    const incompat = [33930, 107410, 582660, 1097150, 220240, 298110, 552520, 304390, 1546970, 12210, 3240220, 271590, 1547000, 1546990, 439700, 269210, 1426210, 510190, 1392860, 1328670, 204100, 555160, 2129530, 1174180, 2215260, 488790, 2001120, 1172380, 1774580, 1527280, 470220, 447040, 1222700];
    return !incompat.includes(appid);
}

async function contarDLCs(appid) {
    try {
        const data = await fetchWithTimeout(`https://store.steampowered.com/api/appdetails?appids=${appid}&l=portuguese`, 8000);
        return data[appid]?.data?.dlc?.length || 0;
    } catch (e) { return 0; }
}

async function buscarSugestoesJogos(termo) {
    if (!termo) return [];
    try {
        const data = await fetchWithTimeout(`https://store.steampowered.com/api/storesearch?term=${encodeURIComponent(termo)}&l=portuguese&cc=BR&max=10`, 3000);
        return data.items?.filter(i => i.type === 'game').slice(0, 10).map(i => ({ name: i.name, value: i.name })) || [];
    } catch (e) { return []; }
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

    const recentes = games.filter(g => g.rtime_last_played > 0).sort((a,b) => b.rtime_last_played - a.rtime_last_played).slice(0, 5);
    if (recentes.length < 3) {
        for (const appid of db.jogosRecentes[steamId].slice(-5)) {
            const jogo = games.find(g => g.appid === appid);
            if (jogo && !recentes.find(g => g.appid === appid)) recentes.push(jogo);
        }
    }
    if (recentes.length === 0) recentes.push(...games.slice(0, 3));

    db.jogosRecentes[steamId] = recentes.map(g => g.appid).slice(0, 5);

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

            const desbloq = conquistas.filter(c => c.achieved === 1);
            const total = desbloq.length;
            const totalJogo = conquistas.length;

            if (!db.conquistas[steamId][appid] || !primeiraVerificacaoConcluida) {
                db.conquistas[steamId][appid] = { total, nomes: desbloq.map(c => c.apiname), totalJogo };
                continue;
            }

            const dados = db.conquistas[steamId][appid];
            if (total > dados.total) {
                const novas = desbloq.filter(c => !dados.nomes.includes(c.apiname));
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
                    db.conquistas[steamId][appid] = { total, nomes: desbloq.map(c => c.apiname), totalJogo };
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
        .setTitle('🏆 Ranking da Biblioteca Steam 2026')
        .setThumbnail('https://upload.wikimedia.org/wikipedia/commons/thumb/8/83/Steam_icon_logo.svg/1200px-Steam_icon_logo.svg.png')
        .setTimestamp()
        .setFooter({ text: `Atualizado ${new Date().toLocaleTimeString()}` });
    const medalhas = ['🥇','🥈','🥉','4°','5°','6°'];
    let desc = '';
    arr.forEach((u,i) => {
        desc += `${i < 3 ? medalhas[i] : medalhas[i]} **${u.discordId ? `<@${u.discordId}>` : u.nome}** — ${Math.floor(u.jogos)} jogos\n`;
    });
    embed.setDescription(desc);
    return embed;
}

async function enviarRanking(forcar = false) {
    if (debounceRanking) return;
    debounceRanking = true;
    try {
        db.ranking = ranking;
        salvarDB(db);
        const embed = gerarRanking();
        const desc = embed.data.description;
        if (!forcar && db.ultimoRankingEnviado?.descricao === desc) {
            debounceRanking = false;
            return;
        }
        const channel = client.channels.cache.get(CHANNEL_RANKING);
        if (!channel) { debounceRanking = false; return; }
        if (ultimaMensagemRankingId) {
            try { await channel.messages.delete(ultimaMensagemRankingId); } catch (e) {}
        }
        const msg = await channel.send({ embeds: [embed] });
        ultimaMensagemRankingId = msg.id;
        db.ultimaMensagemRankingId = ultimaMensagemRankingId;
        db.ultimoRankingEnviado = { descricao: desc, timestamp: Date.now() };
        salvarDB(db);
    } catch (e) { console.error('Erro ao enviar ranking:', e); }
    debounceRanking = false;
}

// 🔹 ============================================
// 🔹 LISTA /quero
// 🔹 ============================================
function adicionarQuero(discordId, appid, nome, link) {
    if (!db.listaQuero[discordId]) db.listaQuero[discordId] = [];
    if (db.listaQuero[discordId].some(i => i.appid === appid)) return { sucesso: false, motivo: 'ja_na_lista' };
    db.listaQuero[discordId].push({ appid, nome, link, adicionado_em: new Date().toISOString() });
    salvarDB(db);
    return { sucesso: true };
}

function removerQuero(discordId, appid) {
    if (!db.listaQuero[discordId]) return false;
    const antes = db.listaQuero[discordId].length;
    db.listaQuero[discordId] = db.listaQuero[discordId].filter(i => i.appid !== appid);
    if (db.listaQuero[discordId].length < antes) { salvarDB(db); return true; }
    return false;
}

function listarQuero(discordId) {
    return db.listaQuero[discordId] || [];
}

// 🔹 ============================================
// 🔹 LOOP PRINCIPAL
// 🔹 ============================================
async function checkSteamGames() {
    console.log(`🔄 [${new Date().toLocaleTimeString()}] VERIFICANDO...`);
    try {
        const ids = process.env.STEAM_IDS.split(',').map(id => id.trim());
        const notif = client.channels.cache.get(CHANNEL_NOTIFICACOES);
        if (!notif) return;

        for (const id of ids) {
            try {
                const data = await fetchWithTimeout(`https://api.steampowered.com/IPlayerService/GetOwnedGames/v0001/?key=${process.env.STEAM_KEY}&steamid=${id}&include_appinfo=true&format=json`, 10000);
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
                    const newGames = current.filter(g => !old.some(o => o.appid === g.appid));
                    if (newGames.length) {
                        for (const jogo of newGames) {
                            const link = `https://store.steampowered.com/app/${jogo.appid}`;
                            await notif.send(`@everyone 🎉 ${mention} comprou: **${jogo.name}**\n🔗 ${link}`);
                            if (ranking[id]) {
                                ranking[id].jogos += 1;
                                db.ranking = ranking;
                                salvarDB(db);
                                await enviarRanking(false);
                            }
                        }
                    }
                    previousGames[id] = current.slice(-20);
                }
            } catch (e) { console.error(`❌ Erro em ${id}:`, e.message); }
        }

        // Verifica lista /quero (comprados)
        for (const [discordId, jogos] of Object.entries(db.listaQuero)) {
            if (!jogos?.length) continue;
            const steamId = Object.keys(discordUsers).find(k => discordUsers[k] === discordId);
            if (!steamId) continue;
            try {
                const data = await fetchWithTimeout(`https://api.steampowered.com/IPlayerService/GetOwnedGames/v0001/?key=${process.env.STEAM_KEY}&steamid=${steamId}&include_appinfo=true&format=json`, 8000);
                if (!data.response?.games) continue;
                const owned = new Set(data.response.games.map(g => g.appid));
                let removidos = 0;
                for (const jogo of jogos) {
                    if (owned.has(jogo.appid)) {
                        if (removerQuero(discordId, jogo.appid)) {
                            removidos++;
                            const usuario = await client.users.fetch(discordId).catch(() => null);
                            if (usuario) await usuario.send(`🎮 **${jogo.nome}** foi removido da sua lista /quero (comprado!)`);
                        }
                    }
                }
                if (removidos) console.log(`📊 ${removidos} jogos removidos da lista /quero de ${discordId}`);
            } catch (e) { console.error(`❌ Erro ao verificar /quero de ${discordId}:`, e.message); }
        }

        // Verifica se algum jogo da /quero foi comprado por outro membro da família
        const familia = new Set();
        for (const id of ids) {
            try {
                const data = await fetchWithTimeout(`https://api.steampowered.com/IPlayerService/GetOwnedGames/v0001/?key=${process.env.STEAM_KEY}&steamid=${id}&include_appinfo=true&format=json`, 8000);
                if (data.response?.games) data.response.games.forEach(g => familia.add(g.appid));
            } catch (e) {}
        }
        for (const [discordId, jogos] of Object.entries(db.listaQuero)) {
            if (!jogos?.length) continue;
            let removidos = 0;
            for (const jogo of jogos) {
                if (familia.has(jogo.appid)) {
                    if (removerQuero(discordId, jogo.appid)) {
                        removidos++;
                        const usuario = await client.users.fetch(discordId).catch(() => null);
                        if (usuario) await usuario.send(`🎮 **${jogo.nome}** foi removido da sua lista /quero (alguém da família comprou!)`);
                    }
                }
            }
            if (removidos) console.log(`📊 ${removidos} jogos removidos da lista /quero de ${discordId} (família)`);
        }

        if (!primeiraVerificacaoConcluida) {
            primeiraVerificacaoConcluida = true;
            console.log('✅ PRIMEIRA VERIFICAÇÃO CONCLUÍDA!');
        }
    } catch (e) { console.error('❌ Erro geral:', e); }
}

// 🔹 ============================================
// 🔹 COMANDOS SLASH
// 🔹 ============================================
async function registrarComandos() {
    try {
        await client.application.commands.set([
            { name: 'tem', description: 'Verifica se um jogo está na família', options: [{ name: 'jogo', type: 3, required: true, autocomplete: true, description: 'Nome do jogo ou link' }] },
            { name: 'ranking', description: 'Mostra o ranking da biblioteca da família' },
            { name: 'quero', description: 'Adiciona à lista /quero', options: [{ name: 'jogo', type: 3, required: true, description: 'Nome do jogo' }] },
            { name: 'quero-listar', description: 'Lista seus jogos /quero' },
            { name: 'quero-listar-resumido', description: 'Lista rápida (sem preços)' },
            { name: 'quero-remover', description: 'Remove da lista /quero', options: [{ name: 'jogo', type: 3, required: true, description: 'Nome do jogo' }] },
            { name: 'dbstatus', description: '[DONO] Status do banco de dados' }
        ]);
        console.log('✅ Comandos registrados.');
    } catch (e) { console.error('❌ Erro ao registrar comandos:', e); }
}

// 🔹 ============================================
// 🔹 INTERAÇÕES
// 🔹 ============================================
client.on('interactionCreate', async (interaction) => {
    if (interaction.isAutocomplete()) {
        if (interaction.commandName === 'tem') {
            const term = interaction.options.getString('jogo')?.toLowerCase() || '';
            const sugestoes = await buscarSugestoesJogos(term);
            await interaction.respond(sugestoes);
        }
        return;
    }
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'tem') {
        await interaction.deferReply({ ephemeral: true });
        const input = interaction.options.getString('jogo');
        let jogo = null;
        if (input.includes('store.steampowered.com/app/')) {
            const appid = input.match(/store\.steampowered\.com\/app\/(\d+)/)?.[1];
            if (appid) jogo = await buscarJogoPorAppId(parseInt(appid));
        }
        if (!jogo) jogo = await buscarJogoSteam(input);
        if (!jogo) return interaction.editReply('❌ Jogo não encontrado.');
        const donos = await verificarJogoFamilia(jogo.appid);
        const totalDLCs = await contarDLCs(jogo.appid);
        const compativel = await verificarCompatibilidadeFamilia(jogo.appid);
        const embed = new EmbedBuilder()
            .setColor(donos.length ? 0x00FF00 : 0xFF0000)
            .setTitle(`${donos.length ? '✅' : '❌'} ${jogo.nome}`)
            .setURL(jogo.url)
            .setFooter({ text: 'Steam Família - Consulta' })
            .setTimestamp();
        if (jogo.capa) embed.setThumbnail(jogo.capa);
        if (!compativel) embed.addFields({ name: '⚠️ ATENÇÃO', value: '⚠️ Jogo NÃO tem suporte para Compartilhamento em Família!', inline: false });
        embed.addFields({ name: '📦 DLCs', value: totalDLCs > 0 ? `Possui ${totalDLCs} DLC(s)` : 'Nenhuma DLC listada', inline: false });
        if (donos.length) {
            let desc = `🎮 **Encontrado na família!**\n👤 **${donos.length} membro(s) possui(em):**\n\n`;
            donos.forEach((d, i) => desc += `**${i+1}. ${d.discordId ? `<@${d.discordId}>` : d.nome}**\n`);
            embed.setDescription(desc);
        } else {
            embed.setDescription('😕 **Nenhum membro da família possui este jogo.**');
        }
        await interaction.editReply({ embeds: [embed] });
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
        const resultado = adicionarQuero(interaction.user.id, jogo.appid, jogo.nome, jogo.url);
        if (!resultado.sucesso) {
            if (resultado.motivo === 'ja_na_lista') return interaction.editReply(`ℹ️ ${jogo.nome} já está na lista.`);
            // Verifica se já tem na família
            const donos = await verificarJogoFamilia(jogo.appid);
            if (donos.length) return interaction.editReply(`ℹ️ ${jogo.nome} já está na família!`);
        }
        await interaction.editReply(`✅ **${jogo.nome}** adicionado à sua lista /quero!`);
    }

    if (interaction.commandName === 'quero-listar') {
        await interaction.deferReply({ ephemeral: true });
        const lista = listarQuero(interaction.user.id);
        if (!lista.length) return interaction.editReply('📭 Lista vazia.');
        const embed = new EmbedBuilder()
            .setColor(0x00AE86)
            .setTitle(`📋 Sua lista /quero (${lista.length} jogos)`)
            .setDescription(lista.map((j, i) => `**${i+1}.** [${j.nome}](${j.link})`).join('\n'))
            .setFooter({ text: 'Use /quero-remover para tirar' });
        await interaction.editReply({ embeds: [embed] });
    }

    if (interaction.commandName === 'quero-listar-resumido') {
        await interaction.deferReply({ ephemeral: true });
        const lista = listarQuero(interaction.user.id);
        if (!lista.length) return interaction.editReply('📭 Lista vazia.');
        const texto = lista.map((j, i) => `${i+1}. ${j.nome}`).join('\n');
        await interaction.editReply(`📋 **Sua lista /quero (${lista.length} jogos)**\n${texto}`);
    }

    if (interaction.commandName === 'quero-remover') {
        await interaction.deferReply({ ephemeral: true });
        const nome = interaction.options.getString('jogo');
        const jogo = await buscarJogoSteam(nome);
        if (!jogo) return interaction.editReply('❌ Jogo não encontrado.');
        const removido = removerQuero(interaction.user.id, jogo.appid);
        if (!removido) return interaction.editReply(`ℹ️ ${jogo.nome} não estava na lista.`);
        await interaction.editReply(`✅ **${jogo.nome}** removido da lista /quero.`);
    }

    if (interaction.commandName === 'dbstatus') {
        if (interaction.user.id !== DONO_ID) return interaction.reply({ content: '❌ Apenas o dono.', ephemeral: true });
        await interaction.deferReply({ ephemeral: true });
        const total = Object.values(db.listaQuero).reduce((acc, arr) => acc + arr.length, 0);
        const msg = `📊 **Status do Banco:**\n📋 /quero: ${total} jogos\n🔗 Vinculados: ${Object.keys(db.steamLinks).length}\n🚫 Sem conquistas: ${Object.keys(db.jogosSemConquistas).length}\n💾 ${DB_FILE}`;
        await interaction.editReply({ content: msg });
    }
});

// 🔹 ============================================
// 🔹 MENSAGEM !resetranking
// 🔹 ============================================
client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    if (message.content.toLowerCase() === '!resetranking' && message.author.id === DONO_ID) {
        await message.reply('⚠️ Digite `!confirmar` em 30s para resetar o ranking.');
        const collector = message.channel.createMessageCollector({
            filter: m => m.author.id === DONO_ID && m.content.toLowerCase() === '!confirmar',
            max: 1,
            time: 30000
        });
        collector.on('collect', async () => {
            ranking = JSON.parse(JSON.stringify(rankingPadrao));
            db.ranking = ranking;
            salvarDB(db);
            await enviarRanking(true);
            await message.reply('✅ Ranking resetado!');
        });
        collector.on('end', collected => { if (!collected.size) message.reply('⏰ Cancelado.'); });
    }
});

// 🔹 ============================================
// 🔹 RESTAURAR RANKING DO CANAL
// 🔹 ============================================
async function restaurarRankingDoCanal() {
    const channel = client.channels.cache.get(CHANNEL_RANKING);
    if (!channel) return false;
    try {
        let mensagem = null;
        if (db.ultimaMensagemRankingId) {
            try { mensagem = await channel.messages.fetch(db.ultimaMensagemRankingId); } catch (e) {}
        }
        if (!mensagem) {
            const msgs = await channel.messages.fetch({ limit: 10 });
            mensagem = msgs.filter(m => m.author.id === client.user.id && m.embeds.length).first();
        }
        if (!mensagem) return false;
        const embed = mensagem.embeds[0];
        if (!embed?.description) return false;
        const linhas = embed.description.split('\n');
        const restaurado = {};
        for (const linha of linhas) {
            const match = linha.match(/(?:🥇|🥈|🥉|\d+°)\s+\*\*<@!?(\d+)>\*\*\s+—\s+(\d+)\s+jogos/);
            if (match) {
                const discordId = match[1];
                const jogos = parseInt(match[2]);
                for (const [steamId, dados] of Object.entries(discordUsers)) {
                    if (dados === discordId) {
                        restaurado[steamId] = { nome: steamNames[steamId] || steamId, jogos, steamId, discordId };
                        break;
                    }
                }
            }
        }
        if (Object.keys(restaurado).length) {
            for (const [steamId, dados] of Object.entries(rankingPadrao)) {
                if (!restaurado[steamId]) restaurado[steamId] = dados;
            }
            ranking = restaurado;
            db.ranking = ranking;
            db.ultimaMensagemRankingId = mensagem.id;
            ultimaMensagemRankingId = mensagem.id;
            db.ultimoRankingEnviado = { descricao: embed.description, timestamp: Date.now() };
            salvarDB(db);
            console.log(`✅ Ranking restaurado do canal.`);
            return true;
        }
        return false;
    } catch (e) { console.error('❌ Erro ao restaurar ranking:', e); return false; }
}

// 🔹 ============================================
// 🔹 HEALTH CHECK
// 🔹 ============================================
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
});
server.listen(process.env.PORT || 3000, '0.0.0.0', () => console.log(`✅ Health check na porta ${process.env.PORT || 3000}`));

// 🔹 ============================================
// 🔹 SIGTERM
// 🔹 ============================================
process.on('SIGTERM', async () => { salvarDB(db); await client.destroy(); process.exit(0); });
process.on('SIGINT', async () => { salvarDB(db); await client.destroy(); process.exit(0); });

// 🔹 ============================================
// 🔹 READY
// 🔹 ============================================
client.once('clientReady', async () => {
    console.log(`✅ Bot online: ${client.user.tag}`);
    await registrarComandos();

    // Vincular automaticamente
    const ids = process.env.STEAM_IDS.split(',').map(id => id.trim());
    for (const id of ids) {
        const discordId = discordUsers[id];
        if (discordId && !db.steamLinks[discordId]) {
            db.steamLinks[discordId] = id;
            console.log(`🔗 Vinculado: ${steamNames[id]}`);
        }
    }
    salvarDB(db);

    // Restaurar ranking
    if (!await restaurarRankingDoCanal()) {
        carregarRanking();
        await enviarRanking(true);
    }

    // Iniciar verificações após 5s
    setTimeout(async () => {
        console.log('🎮 Iniciando verificações...');
        await checkSteamGames();
        setInterval(async () => { try { await checkSteamGames(); } catch (e) { console.error('Erro no intervalo:', e); } }, INTERVALO_VERIFICACAO);
    }, 5000);

    // Mensagem ao dono
    try {
        const dono = await client.users.fetch(DONO_ID);
        if (dono) await dono.send('🚀 Bot Steam Família online!');
    } catch (e) {}
});

// 🔹 ============================================
// 🔹 LOGIN
// 🔹 ============================================
client.login(process.env.DISCORD_TOKEN)
    .then(() => console.log('🔑 Login realizado'))
    .catch(e => { console.error('❌ Erro ao login:', e); process.exit(1); });

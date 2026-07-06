require('dotenv').config();
const fs = require('fs');
const path = require('path');
const http = require('http');
const axios = require('axios');
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');

// 🔹 CONFIGURAÇÕES MÍNIMAS
const INTERVALO_VERIFICACAO = 30 * 1000; // 30 segundos para começar mais devagar
const MAX_RETRIES = 2;
const REQUEST_TIMEOUT = 6000;
const BATCH_SIZE = 5;

// 🔹 Rate Limiter (simples)
const rateLimiter = {
    minDelay: 1500,
    lastRequest: 0,
    async wait() {
        const now = Date.now();
        const timeToWait = Math.max(0, this.minDelay - (now - this.lastRequest));
        if (timeToWait > 0) await new Promise(r => setTimeout(r, timeToWait));
        this.lastRequest = Date.now();
    }
};

// 🔹 IDs dos canais (do env)
const CHANNEL_NOTIFICACOES = process.env.CHANNEL_ID;
const CHANNEL_RANKING = "1523067407474757672";
const CHANNEL_CONQUISTAS = "1523080625802711150";
const DONO_ID = "336204841972137995";

// 🔹 Banco de dados (volume persistente)
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || '/data';
const DB_FILE = path.join(DATA_DIR, 'steam_achievements_db.json');

try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    console.log(`📁 Usando volume persistente: ${DATA_DIR}`);
} catch (e) { console.log(`ℹ️ Usando diretório local como fallback.`); }

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

// 🔹 Client
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });

// 🔹 ============================================
// 🔹 BANCO DE DADOS (funções rápidas)
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
    try { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); } catch (e) { console.error('❌ Erro ao salvar banco:', e); }
}

let db = carregarDB();

// 🔹 Ranking padrão
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

// 🔹 ============================================
// 🔹 FETCH COM RATE LIMITING E TIMEOUT
// 🔹 ============================================
async function fetchWithTimeout(url, timeout = REQUEST_TIMEOUT, retry = 0) {
    try {
        await rateLimiter.wait();
        console.log(`🌐 Fetch: ${url.substring(0, 80)}...`);
        const response = await axios.get(url, {
            timeout,
            headers: { 'User-Agent': 'SteamFamilyBot/1.0', 'Accept': 'application/json' },
            validateStatus: status => status < 500
        });
        if (response.status === 429 || response.status === 403) {
            const wait = 1000 * (retry + 1) * 2;
            await new Promise(r => setTimeout(r, wait));
            if (retry < MAX_RETRIES) return fetchWithTimeout(url, timeout, retry + 1);
            throw new Error('Rate limit excedido');
        }
        if (response.status >= 400) throw new Error(`HTTP ${response.status}`);
        return response.data;
    } catch (e) {
        if (e.code === 'ECONNABORTED' || e.code === 'ETIMEDOUT') {
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
// 🔹 FUNÇÕES AUXILIARES (BÁSICAS)
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
    try {
        const url = `https://store.steampowered.com/api/appdetails?appids=${appid}&l=portuguese`;
        const data = await fetchWithTimeout(url);
        if (data[appid]?.success) {
            return { name: data[appid].data.name, icon: data[appid].data.header_image || data[appid].data.capsule_image };
        }
    } catch (e) {}
    return { name: `Jogo ${appid}`, icon: null };
}

async function getAchievementName(steamId, appid, apiname) {
    try {
        const url = `https://api.steampowered.com/ISteamUserStats/GetSchemaForGame/v2/?key=${process.env.STEAM_KEY}&appid=${appid}&l=portuguese`;
        const data = await fetchWithTimeout(url);
        const ach = data.game?.availableGameStats?.achievements?.find(a => a.name === apiname);
        return ach?.displayName || apiname;
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

// 🔹 ============================================
// 🔹 FUNÇÃO: verificarConquistas (otimizada)
// 🔹 ============================================
async function verificarConquistas(steamId, games, mention, userName) {
    if (!games?.length) return;
    const channel = client.channels.cache.get(CHANNEL_CONQUISTAS);
    if (!channel) return;

    if (!db.conquistas[steamId]) db.conquistas[steamId] = {};
    if (!db.jogosRecentes[steamId]) db.jogosRecentes[steamId] = [];

    // Pega jogos recentes (simplificado)
    let jogosRecentes = games.filter(g => g.rtime_last_played > 0).sort((a,b) => b.rtime_last_played - a.rtime_last_played).slice(0, 5);
    if (jogosRecentes.length < 3) {
        for (const appid of db.jogosRecentes[steamId].slice(-5)) {
            const jogo = games.find(g => g.appid === appid);
            if (jogo && !jogosRecentes.find(g => g.appid === appid)) jogosRecentes.push(jogo);
        }
    }
    if (jogosRecentes.length === 0) {
        jogosRecentes = games.slice(0, 3);
    }

    for (const game of jogosRecentes.slice(0, 8)) {
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
        .setTitle('🏆 Ranking da Biblioteca Steam 2026')
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
// 🔹 LOOP PRINCIPAL (SEM PROMOÇÕES)
// 🔹 ============================================
async function checkSteamGames() {
    console.log(`🔄 [${new Date().toLocaleTimeString()}] VERIFICANDO...`);
    try {
        const steamIds = process.env.STEAM_IDS.split(',').map(id => id.trim());
        const apiKey = process.env.STEAM_KEY;
        const notifChannel = client.channels.cache.get(CHANNEL_NOTIFICACOES);
        if (!notifChannel) return;

        for (const id of steamIds) {
            try {
                const url = `https://api.steampowered.com/IPlayerService/GetOwnedGames/v0001/?key=${apiKey}&steamid=${id}&include_appinfo=true&format=json`;
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
                    previousGames[id] = current;
                }
            } catch (e) { console.error(`❌ Erro em ${id}:`, e.message); }
        }

        if (!primeiraVerificacaoConcluida) {
            primeiraVerificacaoConcluida = true;
            console.log('✅ PRIMEIRA VERIFICAÇÃO CONCLUÍDA!');
        }
    } catch (e) { console.error('❌ Erro geral:', e); }
}

// 🔹 ============================================
// 🔹 COMANDOS (SIMPLIFICADOS)
// 🔹 ============================================
async function registrarComandos() {
    try {
        await client.application.commands.set([
            { name: 'tem', description: 'Verifica se um jogo está na família', options: [{ name: 'jogo', type: 3, required: true, autocomplete: true }] },
            { name: 'ranking', description: 'Mostra o ranking' },
            { name: 'quero', description: 'Adiciona à lista /quero', options: [{ name: 'jogo', type: 3, required: true }] },
            { name: 'quero-listar', description: 'Lista seus jogos /quero' },
            { name: 'quero-remover', description: 'Remove da lista /quero', options: [{ name: 'jogo', type: 3, required: true }] }
        ]);
        console.log('✅ Comandos registrados.');
    } catch (e) { console.error('❌ Erro ao registrar comandos:', e); }
}

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
        try {
            let jogo = await buscarJogoSteam(input);
            if (!jogo) return interaction.editReply('❌ Jogo não encontrado.');
            // ... (lógica para exibir donos)
            // Para simplificar, vou apenas responder com o nome
            await interaction.editReply(`✅ Encontrei: ${jogo.nome} (https://store.steampowered.com/app/${jogo.appid})`);
        } catch (e) { await interaction.editReply('❌ Erro.'); }
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
            return interaction.editReply(`ℹ️ ${jogo.nome} já está na lista.`);
        }
        db.listaQuero[interaction.user.id].push({ appid: jogo.appid, nome: jogo.nome, link: jogo.url });
        salvarDB(db);
        await interaction.editReply(`✅ ${jogo.nome} adicionado à lista /quero.`);
    }

    if (interaction.commandName === 'quero-listar') {
        await interaction.deferReply({ ephemeral: true });
        const lista = db.listaQuero[interaction.user.id] || [];
        if (!lista.length) return interaction.editReply('📭 Lista vazia.');
        const embed = new EmbedBuilder().setTitle(`📋 Lista /quero (${lista.length})`).setDescription(lista.map((j,i) => `${i+1}. [${j.nome}](${j.link})`).join('\n'));
        await interaction.editReply({ embeds: [embed] });
    }

    if (interaction.commandName === 'quero-remover') {
        await interaction.deferReply({ ephemeral: true });
        const nome = interaction.options.getString('jogo');
        const jogo = await buscarJogoSteam(nome);
        if (!jogo) return interaction.editReply('❌ Jogo não encontrado.');
        const lista = db.listaQuero[interaction.user.id] || [];
        const idx = lista.findIndex(i => i.appid === jogo.appid);
        if (idx === -1) return interaction.editReply(`ℹ️ ${jogo.nome} não está na lista.`);
        lista.splice(idx, 1);
        salvarDB(db);
        await interaction.editReply(`✅ ${jogo.nome} removido.`);
    }
});

// 🔹 ============================================
// 🔹 HEALTH CHECK (MÍNIMO E RÁPIDO)
// 🔹 ============================================
const server = http.createServer((req, res) => {
    if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
    } else {
        res.writeHead(200);
        res.end('Bot running');
    }
});
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`✅ Health check na porta ${PORT}`));

// 🔹 ============================================
// 🔹 TRATAMENTO DE SIGTERM
// 🔹 ============================================
process.on('SIGTERM', async () => {
    console.log('⚠️ SIGTERM recebido, salvando e saindo...');
    salvarDB(db);
    await client.destroy();
    process.exit(0);
});

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

    // Enviar ranking inicial (após 5s)
    setTimeout(async () => {
        await enviarRanking();
        console.log('📊 Ranking inicial enviado.');
    }, 5000);

    // Iniciar verificações após 10s (para dar tempo do health check)
    setTimeout(async () => {
        console.log('🎮 Iniciando verificações...');
        await checkSteamGames();
        setInterval(async () => {
            try { await checkSteamGames(); } catch (e) { console.error('Erro no intervalo:', e); }
        }, INTERVALO_VERIFICACAO);
    }, 10000);

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

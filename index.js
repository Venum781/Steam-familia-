require('dotenv').config();
const fs = require('fs');
const path = require('path');
const http = require('http');
const axios = require('axios');
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');

// ============================
// CONFIGURAÇÕES
// ============================
const INTERVALO_VERIFICACAO = 30 * 1000;
const INTERVALO_PROMOCOES = 60 * 60 * 1000;
const INTERVALO_LANCAMENTOS = 6 * 60 * 60 * 1000;
const MAX_RETRIES = 2;
const REQUEST_TIMEOUT = 8000;
const MAX_JOGOS_POR_USUARIO = 5;
const MAX_CONQUISTAS_POR_JOGO = 20;

// ============================
// RATE LIMITER
// ============================
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

// ============================
// IDs E MAPEAMENTO (ATUALIZADOS)
// ============================
const CHANNEL_NOTIFICACOES = process.env.CHANNEL_ID;
const CHANNEL_RANKING = "1523797806324777161";
const CHANNEL_CONQUISTAS = "1523080625802711150";
const DONO_ID = "336204841972137995";

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

// ============================
// BANCO DE DADOS
// ============================
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || '/data';
const DB_FILE = path.join(DATA_DIR, 'steam_achievements_db.json');

try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
} catch (e) {}

function carregarDB() {
    try {
        if (fs.existsSync(DB_FILE)) {
            const parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
            if (!parsed.ranking) parsed.ranking = {};
            if (!parsed.conquistas) parsed.conquistas = {};
            if (!parsed.jogosRecentes) parsed.jogosRecentes = {};
            if (!parsed.steamLinks) parsed.steamLinks = {};
            if (!parsed.jogosSemConquistas) parsed.jogosSemConquistas = {};
            if (!parsed.listaQuero) parsed.listaQuero = {};
            if (!parsed.ultimaMensagemRankingId) parsed.ultimaMensagemRankingId = null;
            if (!parsed.ultimoRankingEnviado) parsed.ultimoRankingEnviado = {};
            if (!parsed.ultimasNotificacoesPromocao) parsed.ultimasNotificacoesPromocao = {};
            if (!parsed.ultimasNotificacoesLancamento) parsed.ultimasNotificacoesLancamento = {};
            return parsed;
        }
    } catch (e) { console.error('Erro ao carregar banco:', e); }
    return { 
        ranking: {}, conquistas: {}, jogosRecentes: {}, steamLinks: {}, 
        jogosSemConquistas: {}, listaQuero: {}, 
        ultimaMensagemRankingId: null, ultimoRankingEnviado: {},
        ultimasNotificacoesPromocao: {}, ultimasNotificacoesLancamento: {} 
    };
}

function salvarDB(db) {
    try { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); } catch (e) { console.error('Erro ao salvar banco:', e); }
}

let db = carregarDB();
const rankingPadrao = {
    "76561198127320557": { nome: "Gardemi", jogos: 98, steamId: "76561198127320557", discordId: "663789211152941065" },
    "76561197967265286": { nome: "Marlon", jogos: 56, steamId: "76561197967265286", discordId: "1022183877114069083" },
    "76561198848231901": { nome: "Mosk", jogos: 15, steamId: "76561198848231901", discordId: "499311499504910344" },
    "76561198446717315": { nome: "WoollySkills", jogos: 11, steamId: "76561198446717315", discordId: "479817686218702849" },
    "76561198110004039": { nome: "Venum", jogos: 8, steamId: "76561198110004039", discordId: "336204841972137995" }
};

function carregarRanking() {
    if (db.ranking && Object.keys(db.ranking).length > 0) {
        ranking = db.ranking;
        for (const [steamId, dados] of Object.entries(rankingPadrao)) {
            if (!ranking[steamId]) {
                ranking[steamId] = dados;
                console.log(`📊 Adicionando novo usuário ao ranking: ${dados.nome}`);
            }
        }
        console.log(`📊 Ranking carregado do banco de dados: ${Object.keys(ranking).length} usuários`);
    } else {
        console.log('📊 Nenhum ranking salvo. Usando padrão.');
        ranking = JSON.parse(JSON.stringify(rankingPadrao));
        db.ranking = ranking;
        salvarDB(db);
    }
}

let ranking = {};
carregarRanking();

let ultimaMensagemRankingId = db.ultimaMensagemRankingId || null;
let primeiraVerificacaoConcluida = false;
let previousGames = {};
let debounceRanking = false;

const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

// ============================
// FETCH COM RATE LIMIT
// ============================
async function fetchWithTimeout(url, timeout = REQUEST_TIMEOUT, retry = 0) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    try {
        await rateLimiter.wait();
        const response = await axios.get(url, {
            signal: controller.signal,
            timeout,
            headers: { 'User-Agent': 'SteamFamilyBot/1.0', 'Accept': 'application/json' },
            validateStatus: status => status < 500
        });
        clearTimeout(timeoutId);
        if (response.status === 429 || response.status === 403) {
            await new Promise(r => setTimeout(r, 1000 * (retry + 1) * 2));
            if (retry < MAX_RETRIES) return fetchWithTimeout(url, timeout, retry + 1);
            throw new Error('Rate limit');
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

// ============================
// FUNÇÕES AUXILIARES
// ============================
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

async function getGameIcon(appid) {
    try {
        const url = `https://store.steampowered.com/api/appdetails?appids=${appid}`;
        const data = await fetchWithTimeout(url);
        if (data[appid]?.success) {
            return data[appid].data.header_image || data[appid].data.capsule_image || null;
        }
    } catch (e) {}
    return null;
}

async function getAchievementDisplayName(steamId, appid, apiname) {
    try {
        const url = `https://api.steampowered.com/ISteamUserStats/GetSchemaForGame/v2/?key=${process.env.STEAM_KEY}&appid=${appid}&l=portuguese`;
        const data = await fetchWithTimeout(url);
        const ach = data.game?.availableGameStats?.achievements?.find(a => a.name === apiname);
        return ach?.displayName || apiname;
    } catch (e) { return apiname; }
}

async function getAchievementIcon(appid, apiname) {
    try {
        const url = `https://api.steampowered.com/ISteamUserStats/GetSchemaForGame/v2/?key=${process.env.STEAM_KEY}&appid=${appid}`;
        const data = await fetchWithTimeout(url, 6000);
        const ach = data.game?.availableGameStats?.achievements?.find(a => a.name === apiname);
        return ach?.icon || null;
    } catch (e) { return null; }
}

function extrairAppIdDoLink(url) {
    const match = url.match(/store\.steampowered\.com\/app\/(\d+)/);
    return match ? parseInt(match[1]) : null;
}

async function buscarJogoPorAppId(appid) {
    try {
        const detailsUrl = `https://store.steampowered.com/api/appdetails?appids=${appid}&l=portuguese`;
        const data = await fetchWithTimeout(detailsUrl, 5000);
        if (!data[appid]?.success) return null;
        const info = data[appid].data;
        return {
            appid: appid,
            nome: info.name,
            url: `https://store.steampowered.com/app/${appid}`,
            capa: info.header_image || info.capsule_image || `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/header.jpg`,
            descricao: info.short_description || info.about_the_game?.substring(0, 200) || null,
            dataLancamento: info.release_date?.date || null,
            jaLancado: info.release_date?.coming_soon === false,
            generos: info.genres?.map(g => g.description).join(', ') || null,
            desenvolvedor: info.developers?.join(', ') || null,
            temPreco: !!info.price_overview
        };
    } catch (e) {
        console.error(`❌ Erro ao buscar jogo por AppID ${appid}:`, e.message);
        return null;
    }
}

async function buscarJogoCompleto(input) {
    const appidFromLink = extrairAppIdDoLink(input);
    if (appidFromLink) {
        return await buscarJogoPorAppId(appidFromLink);
    }

    try {
        const searchUrl = `https://store.steampowered.com/api/storesearch?term=${encodeURIComponent(input)}&l=portuguese&cc=BR&max=1`;
        const searchData = await fetchWithTimeout(searchUrl, 5000);
        if (!searchData.items?.length) return null;

        const jogo = searchData.items[0];
        const appid = jogo.id;
        const detailsUrl = `https://store.steampowered.com/api/appdetails?appids=${appid}&l=portuguese`;
        const detailsData = await fetchWithTimeout(detailsUrl, 5000);
        if (!detailsData[appid]?.success) {
            return {
                appid: appid,
                nome: jogo.name,
                url: `https://store.steampowered.com/app/${appid}`,
                capa: `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/header.jpg`,
                descricao: null,
                dataLancamento: null,
                jaLancado: false,
                generos: null,
                desenvolvedor: null,
                temPreco: false
            };
        }

        const data = detailsData[appid].data;
        return {
            appid: appid,
            nome: data.name || jogo.name,
            url: `https://store.steampowered.com/app/${appid}`,
            capa: data.header_image || data.capsule_image || `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/header.jpg`,
            descricao: data.short_description || data.about_the_game?.substring(0, 200) || null,
            dataLancamento: data.release_date?.date || null,
            jaLancado: data.release_date?.coming_soon === false,
            generos: data.genres?.map(g => g.description).join(', ') || null,
            desenvolvedor: data.developers?.join(', ') || null,
            temPreco: !!data.price_overview
        };
    } catch (error) {
        console.error('❌ Erro ao buscar jogo completo:', error.message);
        return null;
    }
}

async function buscarJogoSteam(nome) {
    const completo = await buscarJogoCompleto(nome);
    if (!completo) return null;
    return {
        appid: completo.appid,
        nome: completo.nome,
        url: completo.url,
        capa: completo.capa
    };
}

async function verificarPrecoJogo(appid) {
    try {
        const url = `https://store.steampowered.com/api/appdetails?appids=${appid}&cc=br`;
        const data = await fetchWithTimeout(url, 5000);
        if (!data[appid]?.success) return null;
        const price = data[appid].data.price_overview;
        if (!price) return null;
        return {
            precoAtual: price.final_formatted,
            precoAntigo: price.initial_formatted,
            emPromocao: price.final < price.initial,
            desconto: price.discount_percent || 0
        };
    } catch (e) {
        console.error(`❌ Erro ao verificar preço ${appid}:`, e.message);
        return null;
    }
}

async function verificarJogoFamilia(appid) {
    const donos = [];
    const steamIds = process.env.STEAM_IDS.split(',').map(id => id.trim());
    for (const sid of steamIds) {
        try {
            const url = `https://api.steampowered.com/IPlayerService/GetOwnedGames/v0001/?key=${process.env.STEAM_KEY}&steamid=${sid}&include_appinfo=true&format=json`;
            const data = await fetchWithTimeout(url, 8000);
            if (data.response?.games?.some(g => g.appid === appid)) {
                const discordId = discordUsers[sid] || null;
                donos.push({ steamId: sid, nome: steamNames[sid] || sid, discordId });
            }
        } catch (e) {}
    }
    return donos;
}

// ============================
// CONQUISTAS
// ============================
async function verificarConquistas(steamId, games, mention, userName) {
    if (!games?.length) return;
    const channel = client.channels.cache.get(CHANNEL_CONQUISTAS);
    if (!channel) return;

    if (!db.conquistas[steamId]) db.conquistas[steamId] = {};
    if (!db.jogosRecentes[steamId]) db.jogosRecentes[steamId] = [];

    let recentes = games.filter(g => g.rtime_last_played > 0)
        .sort((a, b) => b.rtime_last_played - a.rtime_last_played)
        .slice(0, 5);

    if (recentes.length < 3) {
        const extras = db.jogosRecentes[steamId].slice(-5);
        for (const appid of extras) {
            const jogo = games.find(g => g.appid === appid);
            if (jogo && !recentes.find(g => g.appid === appid)) recentes.push(jogo);
        }
    }
    if (recentes.length === 0) recentes = games.slice(0, 3);

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
                    const icon = await getGameIcon(appid);
                    for (const c of novas.slice(0, MAX_CONQUISTAS_POR_JOGO)) {
                        const nome = await getAchievementDisplayName(steamId, appid, c.apiname);
                        const icone = await getAchievementIcon(appid, c.apiname);
                        const embed = new EmbedBuilder()
                            .setColor(0xFFD700)
                            .setTitle(`🏆 ${userName} desbloqueou uma conquista!`)
                            .setDescription(`**${nome}**`)
                            .setThumbnail(icon || null)
                            .addFields(
                                { name: '🎮 Jogo', value: gameName, inline: true },
                                { name: '📊 Progresso', value: `${total}/${totalJogo}`, inline: true }
                            )
                            .setTimestamp();
                        if (icone) embed.setImage(`https://shared.fastly.steamstatic.com/community_assets/images/apps/${appid}/${icone}.jpg`);
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

// ============================
// RANKING
// ============================
function gerarRanking() {
    const arr = Object.values(ranking).sort((a, b) => b.jogos - a.jogos);
    const embed = new EmbedBuilder()
        .setColor(0x00AE86)
        .setTitle('🏆 Ranking da Biblioteca Steam 2026')
        .setThumbnail('https://upload.wikimedia.org/wikipedia/commons/thumb/8/83/Steam_icon_logo.svg/1200px-Steam_icon_logo.svg.png')
        .setTimestamp()
        .setFooter({ text: `Atualizado ${new Date().toLocaleTimeString()}` });
    const medalhas = ['🥇', '🥈', '🥉', '4°', '5°', '6°'];
    let desc = '';
    arr.forEach((u, i) => {
        const pos = i < 3 ? medalhas[i] : `${medalhas[i]}`;
        const mencao = u.discordId ? `<@${u.discordId}>` : u.nome;
        desc += `${pos} **${mencao}** — ${Math.floor(u.jogos)} jogos\n`;
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

// ============================
// VERIFICAÇÃO DE LANÇAMENTOS E PROMOÇÕES
// ============================
async function verificarLancamentosQuero() {
    console.log('🔄 Verificando lançamentos da lista /quero...');
    const hoje = new Date().toLocaleDateString('pt-BR');

    for (const [discordId, jogos] of Object.entries(db.listaQuero)) {
        if (!jogos?.length) continue;
        const usuario = await client.users.fetch(discordId).catch(() => null);
        if (!usuario) continue;

        for (const jogo of jogos) {
            const appid = jogo.appid;
            const info = await buscarJogoPorAppId(appid);
            if (!info) continue;

            if (info.jaLancado && info.temPreco) {
                const chaveNotif = `lancamento_${discordId}_${appid}`;
                const ultimaNotif = db.ultimasNotificacoesLancamento?.[chaveNotif];
                if (ultimaNotif) continue;

                try {
                    const embed = new EmbedBuilder()
                        .setColor(0x00FF00)
                        .setTitle(`🎮 ${info.nome} já está disponível!`)
                        .setURL(info.url)
                        .setDescription(
                            `**${info.nome}** foi lançado e já está disponível para compra na Steam!\n\n` +
                            `📅 Data de lançamento: ${info.dataLancamento || 'Disponível agora'}\n` +
                            `🔗 **[Comprar na Steam](${info.url})**`
                        )
                        .setThumbnail(info.capa || null)
                        .setFooter({ text: 'Steam Família - Lançamento /quero' })
                        .setTimestamp();

                    await usuario.send({ embeds: [embed] });
                    console.log(`✅ Lançamento notificado para ${usuario.username}: ${info.nome}`);

                    if (!db.ultimasNotificacoesLancamento) db.ultimasNotificacoesLancamento = {};
                    db.ultimasNotificacoesLancamento[chaveNotif] = {
                        data: hoje,
                        timestamp: Date.now()
                    };
                    salvarDB(db);
                } catch (e) {
                    console.error(`❌ Erro ao enviar DM para ${usuario.username}:`, e.message);
                }
            }
        }
    }
}

async function verificarPromocoesQuero() {
    console.log('🔄 Verificando promoções da lista /quero...');
    const hoje = new Date().toLocaleDateString('pt-BR');

    for (const [discordId, jogos] of Object.entries(db.listaQuero)) {
        if (!jogos?.length) continue;
        const usuario = await client.users.fetch(discordId).catch(() => null);
        if (!usuario) continue;

        for (const jogo of jogos) {
            const appid = jogo.appid;
            const preco = await verificarPrecoJogo(appid);
            if (!preco) continue;

            if (preco.emPromocao) {
                const chaveNotif = `promocao_${discordId}_${appid}`;
                const ultimaNotif = db.ultimasNotificacoesPromocao?.[chaveNotif];
                if (ultimaNotif && ultimaNotif.data === hoje && ultimaNotif.preco === preco.precoAtual) {
                    continue;
                }

                try {
                    const embed = new EmbedBuilder()
                        .setColor(0x00FF00)
                        .setTitle(`🎉 ${jogo.nome} está em promoção!`)
                        .setURL(jogo.link)
                        .setDescription(
                            `**${preco.desconto}% de desconto!**\n\n` +
                            `💰 Preço antigo: ~~${preco.precoAntigo}~~\n` +
                            `💰 Preço atual: **${preco.precoAtual}**\n\n` +
                            `🔗 **[Comprar na Steam](${jogo.link})**`
                        )
                        .setThumbnail(`https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/header.jpg`)
                        .setFooter({ text: 'Steam Família - Promoção /quero' })
                        .setTimestamp();

                    await usuario.send({ embeds: [embed] });
                    console.log(`✅ Promoção notificada para ${usuario.username}: ${jogo.nome}`);

                    if (!db.ultimasNotificacoesPromocao) db.ultimasNotificacoesPromocao = {};
                    db.ultimasNotificacoesPromocao[chaveNotif] = {
                        data: hoje,
                        preco: preco.precoAtual,
                        timestamp: Date.now()
                    };
                    salvarDB(db);
                } catch (e) {
                    console.error(`❌ Erro ao enviar DM para ${usuario.username}:`, e.message);
                }
            }
        }
    }
}

// ============================
// LOOP PRINCIPAL
// ============================
async function checkSteamGames() {
    console.log(`🔄 [${new Date().toLocaleTimeString()}] VERIFICANDO...`);
    try {
        const steamIds = process.env.STEAM_IDS.split(',').map(id => id.trim());
        const channelNotif = client.channels.cache.get(CHANNEL_NOTIFICACOES);
        if (!channelNotif) return;

        for (const sid of steamIds) {
            try {
                const url = `https://api.steampowered.com/IPlayerService/GetOwnedGames/v0001/?key=${process.env.STEAM_KEY}&steamid=${sid}&include_appinfo=true&format=json`;
                const data = await fetchWithTimeout(url, 10000);
                if (!data.response?.games) continue;

                const current = data.response.games.map(g => ({ name: g.name, appid: g.appid, rtime_last_played: g.rtime_last_played || 0 }));
                const userName = steamNames[sid] || sid;
                const discordId = discordUsers[sid];
                const mention = discordId ? `<@${discordId}>` : userName;

                await verificarConquistas(sid, current, mention, userName);

                if (!previousGames[sid]) {
                    previousGames[sid] = current;
                } else {
                    const oldIds = new Set(previousGames[sid].map(g => g.appid));
                    const novos = current.filter(g => !oldIds.has(g.appid));
                    if (novos.length) {
                        for (const jogo of novos) {
                            const link = `https://store.steampowered.com/app/${jogo.appid}`;
                            await channelNotif.send(`@everyone 🎉 ${mention} comprou: **${jogo.name}**\n🔗 ${link}`);
                            if (ranking[sid]) {
                                ranking[sid].jogos += 1;
                                db.ranking = ranking;
                                salvarDB(db);
                                await enviarRanking(false);
                            }
                        }
                    }
                    previousGames[sid] = current.slice(-50);
                }
            } catch (e) {
                console.error(`❌ Erro em ${sid}:`, e.message);
            }
        }

        await verificarJogosCompradosQuero();
        await verificarJogosCompradosFamiliaQuero();

        if (!primeiraVerificacaoConcluida) {
            primeiraVerificacaoConcluida = true;
            console.log('✅ PRIMEIRA VERIFICAÇÃO CONCLUÍDA!');
            salvarDB(db);
        }
    } catch (e) { console.error('❌ Erro geral:', e); }
}

// ============================
// /QUERO - COMPRAS (REMOVE SE COMPRADO)
// ============================
async function verificarJogosCompradosQuero() {
    for (const [discordId, jogos] of Object.entries(db.listaQuero)) {
        if (!jogos?.length) continue;
        const steamId = Object.keys(discordUsers).find(k => discordUsers[k] === discordId);
        if (!steamId) continue;
        try {
            const url = `https://api.steampowered.com/IPlayerService/GetOwnedGames/v0001/?key=${process.env.STEAM_KEY}&steamid=${steamId}&include_appinfo=true&format=json`;
            const data = await fetchWithTimeout(url, 8000);
            if (!data.response?.games) continue;
            const owned = new Set(data.response.games.map(g => g.appid));
            let removidos = 0;
            for (const jogo of jogos) {
                if (owned.has(jogo.appid)) {
                    const ok = removerQuero(discordId, jogo.appid);
                    if (ok) {
                        removidos++;
                        const usuario = await client.users.fetch(discordId).catch(() => null);
                        if (usuario) {
                            await usuario.send(`🎮 **${jogo.nome}** foi removido da sua lista /quero (você já possui).`);
                        }
                    }
                }
            }
            if (removidos) console.log(`📊 ${removidos} jogos removidos da lista /quero de ${discordId} (comprados)`);
        } catch (e) { console.error('Erro ao verificar compras /quero:', e.message); }
    }
}

async function verificarJogosCompradosFamiliaQuero() {
    const steamIds = process.env.STEAM_IDS.split(',').map(id => id.trim());
    const ownedByFamily = new Set();
    for (const sid of steamIds) {
        try {
            const url = `https://api.steampowered.com/IPlayerService/GetOwnedGames/v0001/?key=${process.env.STEAM_KEY}&steamid=${sid}&include_appinfo=true&format=json`;
            const data = await fetchWithTimeout(url, 8000);
            if (data.response?.games) {
                data.response.games.forEach(g => ownedByFamily.add(g.appid));
            }
        } catch (e) {}
    }
    for (const [discordId, jogos] of Object.entries(db.listaQuero)) {
        if (!jogos?.length) continue;
        let removidos = 0;
        for (const jogo of jogos) {
            if (ownedByFamily.has(jogo.appid)) {
                const ok = removerQuero(discordId, jogo.appid);
                if (ok) {
                    removidos++;
                    const usuario = await client.users.fetch(discordId).catch(() => null);
                    if (usuario) {
                        await usuario.send(`🎮 **${jogo.nome}** foi removido da sua lista /quero (alguém da família já possui).`);
                    }
                }
            }
        }
        if (removidos) console.log(`📊 ${removidos} jogos removidos da lista /quero de ${discordId} (família)`);
    }
}

function removerQuero(discordId, appid) {
    if (!db.listaQuero[discordId]) return false;
    const antes = db.listaQuero[discordId].length;
    db.listaQuero[discordId] = db.listaQuero[discordId].filter(j => j.appid !== appid);
    if (db.listaQuero[discordId].length < antes) { salvarDB(db); return true; }
    return false;
}

// ============================
// COMANDOS SLASH
// ============================
async function registrarComandos() {
    try {
        await client.application.commands.set([
            { name: 'tem', description: 'Verifica se um jogo está na família', options: [{ name: 'jogo', type: 3, required: true, autocomplete: true, description: 'Nome ou link do jogo' }] },
            { name: 'ranking', description: 'Mostra o ranking da família' },
            { name: 'quero', description: 'Adiciona um jogo à sua lista /quero', options: [{ name: 'jogo', type: 3, required: true, description: 'Nome ou link do jogo' }] },
            { name: 'quero-listar', description: 'Lista seus jogos /quero' },
            { name: 'quero-remover', description: 'Remove um jogo da lista /quero', options: [{ name: 'jogo', type: 3, required: true, description: 'Nome do jogo ou número da posição (ex: 5)' }] },
            { name: 'dbstatus', description: '[DONO] Status do banco' }
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

    // /tem
    if (interaction.commandName === 'tem') {
        await interaction.deferReply({ ephemeral: true });
        const input = interaction.options.getString('jogo');
        const jogo = await buscarJogoCompleto(input);
        if (!jogo) return interaction.editReply('❌ Jogo não encontrado.');
        const donos = await verificarJogoFamilia(jogo.appid);
        const embed = new EmbedBuilder()
            .setColor(donos.length ? 0x00FF00 : 0xFF0000)
            .setTitle(`${donos.length ? '✅' : '❌'} ${jogo.nome}`)
            .setURL(jogo.url)
            .setDescription(donos.length ? `👤 **${donos.length} membro(s) possui(em):**\n${donos.map(d => `• ${d.discordId ? `<@${d.discordId}>` : d.nome}`).join('\n')}` : '😕 Nenhum membro da família possui este jogo.')
            .setTimestamp();
        if (jogo.capa) embed.setThumbnail(jogo.capa);
        await interaction.editReply({ embeds: [embed] });
    }

    // /ranking
    if (interaction.commandName === 'ranking') {
        await interaction.deferReply({ ephemeral: true });
        await interaction.editReply({ embeds: [gerarRanking()] });
    }

    // /quero
    if (interaction.commandName === 'quero') {
        await interaction.deferReply({ ephemeral: true });
        try {
            const input = interaction.options.getString('jogo');
            const jogo = await buscarJogoCompleto(input);
            if (!jogo) return interaction.editReply('❌ Jogo não encontrado.');

            if (!db.listaQuero[interaction.user.id]) db.listaQuero[interaction.user.id] = [];
            if (db.listaQuero[interaction.user.id].some(j => j.appid === jogo.appid)) {
                return interaction.editReply(`ℹ️ **${jogo.nome}** já está na sua lista /quero.`);
            }

            const donos = await verificarJogoFamilia(jogo.appid);
            if (donos.length) {
                const nomes = donos.map(d => d.discordId ? `<@${d.discordId}>` : d.nome).join(', ');
                return interaction.editReply(`ℹ️ **${jogo.nome}** já está na família! ${nomes} já possui.`);
            }

            const preco = await verificarPrecoJogo(jogo.appid);
            let statusMsg = '⏳ Aguardando lançamento';
            if (jogo.jaLancado && jogo.temPreco) {
                statusMsg = '🟢 JÁ LANÇADO – Disponível para compra!';
                if (preco?.emPromocao) statusMsg += ` (${preco.desconto}% OFF!)`;
            } else if (jogo.jaLancado && !jogo.temPreco) {
                statusMsg = '🟡 Lançado, mas sem preço (possível gratuito ou ainda não disponível)';
            } else {
                statusMsg = `⏳ Lançamento previsto: ${jogo.dataLancamento || 'Data não informada'}`;
            }

            db.listaQuero[interaction.user.id].push({
                appid: jogo.appid,
                nome: jogo.nome,
                link: jogo.url,
                adicionado_em: new Date().toISOString()
            });
            salvarDB(db);

            if (jogo.jaLancado && jogo.temPreco) {
                const chaveNotif = `lancamento_${interaction.user.id}_${jogo.appid}`;
                if (!db.ultimasNotificacoesLancamento) db.ultimasNotificacoesLancamento = {};
                if (!db.ultimasNotificacoesLancamento[chaveNotif]) {
                    const hoje = new Date().toLocaleDateString('pt-BR');
                    db.ultimasNotificacoesLancamento[chaveNotif] = {
                        data: hoje,
                        timestamp: Date.now()
                    };
                    salvarDB(db);
                    try {
                        const embedLanc = new EmbedBuilder()
                            .setColor(0x00FF00)
                            .setTitle(`🎮 ${jogo.nome} já está disponível!`)
                            .setURL(jogo.url)
                            .setDescription(
                                `**${jogo.nome}** foi lançado e já está disponível para compra na Steam!\n\n` +
                                `📅 Data de lançamento: ${jogo.dataLancamento || 'Disponível agora'}\n` +
                                `🔗 **[Comprar na Steam](${jogo.url})**`
                            )
                            .setThumbnail(jogo.capa || null)
                            .setFooter({ text: 'Steam Família - Lançamento /quero' })
                            .setTimestamp();
                        const usuario = await client.users.fetch(interaction.user.id);
                        if (usuario) await usuario.send({ embeds: [embedLanc] });
                    } catch (e) {}
                }
            }

            const embed = new EmbedBuilder()
                .setColor(jogo.jaLancado && jogo.temPreco ? 0x00FF00 : 0x00AE86)
                .setTitle(`✅ ${jogo.nome}`)
                .setURL(jogo.url)
                .setThumbnail(jogo.capa || null)
                .setDescription(jogo.descricao || 'Sem descrição disponível.')
                .addFields(
                    { name: '📅 Data de Lançamento', value: jogo.dataLancamento || 'Data não informada', inline: true },
                    { name: '🎮 Gênero', value: jogo.generos || 'Não informado', inline: true },
                    { name: '💰 Status', value: statusMsg, inline: true }
                )
                .setFooter({ text: 'Adicionado à sua lista /quero! Você será notificado(a) quando o jogo for lançado ou entrar em promoção.' })
                .setTimestamp();

            let content = `✅ **${jogo.nome}** adicionado à sua lista /quero!`;
            if (jogo.jaLancado && jogo.temPreco) {
                content += `\n\n🟢 **Este jogo já está disponível para compra!**\n🔗 ${jogo.url}`;
            }

            await interaction.editReply({ content, embeds: [embed] });
        } catch (error) {
            console.error('❌ Erro no comando /quero:', error);
            await interaction.editReply('❌ Ocorreu um erro ao adicionar o jogo. Tente novamente mais tarde.');
        }
    }

    // /quero-listar
    if (interaction.commandName === 'quero-listar') {
        await interaction.deferReply({ ephemeral: true });
        const lista = db.listaQuero[interaction.user.id] || [];
        if (!lista.length) return interaction.editReply('📭 Sua lista /quero está vazia.');
        const embed = new EmbedBuilder()
            .setTitle(`📋 Sua lista /quero (${lista.length})`)
            .setDescription(lista.map((j, i) => `${i+1}. [${j.nome}](${j.link})`).join('\n'));
        await interaction.editReply({ embeds: [embed] });
    }

    // /quero-remover - ACEITA NOME OU NÚMERO
    if (interaction.commandName === 'quero-remover') {
        await interaction.deferReply({ ephemeral: true });
        const input = interaction.options.getString('jogo');
        const lista = db.listaQuero[interaction.user.id] || [];

        if (!lista.length) {
            return interaction.editReply('📭 Sua lista /quero está vazia.');
        }

        let jogoRemovido = null;
        let idx = -1;

        const posicao = parseInt(input);
        if (!isNaN(posicao) && posicao >= 1 && posicao <= lista.length) {
            idx = posicao - 1;
            jogoRemovido = lista[idx];
        } else {
            const jogoBuscado = await buscarJogoSteam(input);
            if (jogoBuscado) {
                idx = lista.findIndex(j => j.appid === jogoBuscado.appid);
                if (idx !== -1) jogoRemovido = lista[idx];
            }
            if (idx === -1) {
                idx = lista.findIndex(j => j.nome.toLowerCase() === input.toLowerCase());
                if (idx !== -1) jogoRemovido = lista[idx];
            }
        }

        if (idx === -1 || !jogoRemovido) {
            return interaction.editReply(`❌ Não encontrei o jogo **${input}** na sua lista. Use o nome exato ou o número da posição (ex: 1, 2, 3...).`);
        }

        lista.splice(idx, 1);
        salvarDB(db);

        await interaction.editReply(`✅ **${jogoRemovido.nome}** removido da sua lista /quero!`);
    }

    // /dbstatus
    if (interaction.commandName === 'dbstatus') {
        if (interaction.user.id !== DONO_ID) return interaction.reply({ content: '❌ Apenas o dono.', ephemeral: true });
        await interaction.deferReply({ ephemeral: true });
        const totalQuero = Object.values(db.listaQuero).reduce((acc, arr) => acc + arr.length, 0);
        const msg = `📊 **Status**\n📋 /quero: ${totalQuero} jogos\n🔗 Links: ${Object.keys(db.steamLinks).length}\n🚫 Sem conquistas: ${Object.keys(db.jogosSemConquistas).length}\n💾 ${DB_FILE}`;
        await interaction.editReply({ content: msg });
    }
});

// ============================
// MENSAGEM !resetranking
// ============================
client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    if (message.content.toLowerCase() === '!resetranking') {
        if (message.author.id !== DONO_ID) return message.reply('❌ Apenas o dono.');
        await message.reply('⚠️ Confirme com `!confirmar` em 30s.');
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
            await message.reply('✅ Ranking resetado.');
        });
        collector.on('end', collected => { if (!collected.size) message.reply('⏰ Cancelado.'); });
    }
});

// ============================
// RESTAURAR RANKING DO CANAL
// ============================
async function restaurarRankingDoCanal() {
    const channel = client.channels.cache.get(CHANNEL_RANKING);
    if (!channel) return false;
    try {
        let msg = null;
        if (db.ultimaMensagemRankingId) {
            try { msg = await channel.messages.fetch(db.ultimaMensagemRankingId); } catch (e) {}
        }
        if (!msg) {
            const msgs = await channel.messages.fetch({ limit: 10 });
            const botMsgs = msgs.filter(m => m.author.id === client.user.id && m.embeds.length);
            if (botMsgs.size) msg = botMsgs.first();
        }
        if (!msg) return false;
        const embed = msg.embeds[0];
        if (!embed?.description) return false;
        const linhas = embed.description.split('\n');
        const restaurado = {};
        for (const linha of linhas) {
            const match = linha.match(/(?:🥇|🥈|🥉|\d+°)\s+\*\*<@!?(\d+)>\*\*\s+—\s+(\d+)\s+jogos/);
            if (match) {
                const discordId = match[1];
                const jogos = parseInt(match[2]);
                for (const [sid, d] of Object.entries(discordUsers)) {
                    if (d === discordId) {
                        restaurado[sid] = { nome: steamNames[sid] || sid, jogos, steamId: sid, discordId };
                        break;
                    }
                }
            }
        }
        if (Object.keys(restaurado).length) {
            for (const [sid, d] of Object.entries(rankingPadrao)) {
                if (!restaurado[sid]) restaurado[sid] = d;
            }
            ranking = restaurado;
            db.ranking = ranking;
            db.ultimaMensagemRankingId = msg.id;
            ultimaMensagemRankingId = msg.id;
            db.ultimoRankingEnviado = { descricao: embed.description, timestamp: Date.now() };
            salvarDB(db);
            console.log('✅ Ranking restaurado do canal.');
            return true;
        }
        return false;
    } catch (e) { console.error('Erro ao restaurar ranking:', e); return false; }
}

// ============================
// HEALTH CHECK
// ============================
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
});
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`✅ Health check na porta ${PORT}`));

// ============================
// TRATAMENTO SIGTERM
// ============================
process.on('SIGTERM', async () => {
    console.log('⚠️ SIGTERM, salvando...');
    salvarDB(db);
    await client.destroy();
    process.exit(0);
});

// ============================
// READY
// ============================
client.once('clientReady', async () => {
    console.log(`✅ Bot online: ${client.user.tag}`);
    await registrarComandos();

    const ok = await restaurarRankingDoCanal();
    if (!ok) {
        carregarRanking();
        await enviarRanking(true);
    } else {
        const embed = gerarRanking();
        if (db.ultimoRankingEnviado?.descricao !== embed.data.description) {
            await enviarRanking(true);
        }
    }

    const steamIds = process.env.STEAM_IDS.split(',').map(id => id.trim());
    for (const sid of steamIds) {
        const did = discordUsers[sid];
        if (did && !db.steamLinks[did]) {
            db.steamLinks[did] = sid;
            console.log(`🔗 Vinculado: ${steamNames[sid]}`);
        }
    }
    salvarDB(db);

    try {
        const dono = await client.users.fetch(DONO_ID);
        if (dono) await dono.send('🚀 Bot Steam Família online! (IDs atualizados)');
    } catch (e) {}

    setImmediate(async () => {
        console.log('🎮 Iniciando verificação...');
        await checkSteamGames();
    });

    setInterval(async () => {
        try { await checkSteamGames(); } catch (e) { console.error('Erro no intervalo:', e); }
    }, INTERVALO_VERIFICACAO);

    setInterval(async () => {
        try { await verificarPromocoesQuero(); } catch (e) { console.error('Erro ao verificar promoções:', e); }
    }, INTERVALO_PROMOCOES);

    setInterval(async () => {
        try { await verificarLancamentosQuero(); } catch (e) { console.error('Erro ao verificar lançamentos:', e); }
    }, INTERVALO_LANCAMENTOS);

    setTimeout(async () => {
        await verificarLancamentosQuero();
    }, 2 * 60 * 1000);

    setTimeout(async () => {
        await verificarPromocoesQuero();
    }, 5 * 60 * 1000);
});

client.login(process.env.DISCORD_TOKEN)
    .then(() => console.log('🔑 Login realizado'))
    .catch(e => { console.error('❌ Erro ao login:', e); process.exit(1); });

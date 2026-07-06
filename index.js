require('dotenv').config();
const fs = require('fs');
const path = require('path');
const http = require('http');
const axios = require('axios');
const { Client, GatewayIntentBits, EmbedBuilder, MessageFlags } = require('discord.js');

// ============================
// CONFIGURAÇÕES BÁSICAS
// ============================
const INTERVALO_PROMOCOES = 60 * 60 * 1000;   // 1 hora
const INTERVALO_LANCAMENTOS = 6 * 60 * 60 * 1000; // 6 horas
const MAX_RETRIES = 2;
const REQUEST_TIMEOUT = 8000;

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
// IDS E MAPEAMENTO
// ============================
const CHANNEL_NOTIFICACOES = process.env.CHANNEL_ID;
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
// BANCO DE DADOS PERSISTENTE
// ============================
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || '/data';
const DB_FILE = path.join(DATA_DIR, 'steam_achievements_db.json');

try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
} catch (e) { console.error('Erro ao criar diretório:', e); }

function carregarDB() {
    try {
        if (fs.existsSync(DB_FILE)) {
            const parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
            if (!parsed.listaQuero) parsed.listaQuero = {};
            if (!parsed.steamLinks) parsed.steamLinks = {};
            if (!parsed.ultimasNotificacoesPromocao) parsed.ultimasNotificacoesPromocao = {};
            if (!parsed.ultimasNotificacoesLancamento) parsed.ultimasNotificacoesLancamento = {};
            return parsed;
        }
    } catch (e) { console.error('Erro ao carregar banco:', e); }
    return {
        listaQuero: {},
        steamLinks: {},
        ultimasNotificacoesPromocao: {},
        ultimasNotificacoesLancamento: {}
    };
}

function salvarDB(db) {
    try { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); } catch (e) { console.error('Erro ao salvar banco:', e); }
}

let db = carregarDB();

// ============================
// CLIENT DISCORD
// ============================
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
    const steamIds = process.env.STEAM_IDS ? process.env.STEAM_IDS.split(',').map(id => id.trim()) : [];
    for (const sid of steamIds) {
        try {
            const url = `https://api.steampowered.com/IPlayerService/GetOwnedGames/v0001/?key=${process.env.STEAM_KEY}&steamid=${sid}&include_appinfo=true&format=json`;
            const data = await fetchWithTimeout(url, 8000);
            if (data.response?.games?.some(g => g.appid === appid)) {
                const discordId = discordUsers[sid] || null;
                donos.push({ steamId: sid, nome: steamNames[sid] || sid, discordId });
            }
        } catch (e) {
            // ignora erro individual
        }
    }
    return donos;
}

// ============================
// VERIFICAÇÕES PERIÓDICAS
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
// REGISTRO DE COMANDOS SLASH
// ============================
async function registrarComandos() {
    try {
        await client.application.commands.set([
            {
                name: 'tem',
                description: 'Verifica se um jogo está na biblioteca da família',
                options: [
                    {
                        name: 'jogo',
                        type: 3,
                        required: true,
                        autocomplete: true,
                        description: 'Nome do jogo ou link da Steam'
                    }
                ]
            },
            {
                name: 'quero',
                description: 'Adiciona um jogo à sua lista /quero',
                options: [
                    {
                        name: 'jogo',
                        type: 3,
                        required: true,
                        description: 'Nome do jogo ou link da Steam'
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
                        type: 3,
                        required: true,
                        description: 'Nome do jogo ou número da posição (ex: 5)'
                    }
                ]
            }
        ]);
        console.log('✅ Comandos registrados.');
    } catch (e) { console.error('❌ Erro ao registrar comandos:', e); }
}

// ============================
// INTERAÇÕES
// ============================
client.on('interactionCreate', async (interaction) => {
    // Autocomplete
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

    // ============================
    // COMANDO /tem
    // ============================
    if (interaction.commandName === 'tem') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const input = interaction.options.getString('jogo');
        const jogo = await buscarJogoCompleto(input);
        if (!jogo) {
            await interaction.editReply('❌ Jogo não encontrado.');
            return;
        }
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

    // ============================
    // COMANDO /quero (adicionar)
    // ============================
    if (interaction.commandName === 'quero') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
            const input = interaction.options.getString('jogo');
            const jogo = await buscarJogoCompleto(input);
            if (!jogo) {
                await interaction.editReply('❌ Jogo não encontrado.');
                return;
            }

            if (!db.listaQuero[interaction.user.id]) db.listaQuero[interaction.user.id] = [];
            if (db.listaQuero[interaction.user.id].some(j => j.appid === jogo.appid)) {
                await interaction.editReply(`ℹ️ **${jogo.nome}** já está na sua lista /quero.`);
                return;
            }

            const donos = await verificarJogoFamilia(jogo.appid);
            if (donos.length) {
                const nomes = donos.map(d => d.discordId ? `<@${d.discordId}>` : d.nome).join(', ');
                await interaction.editReply(`ℹ️ **${jogo.nome}** já está na família! ${nomes} já possui.`);
                return;
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

            // Notifica lançamento imediato se já disponível
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
            await interaction.editReply('❌ Ocorreu um erro ao adicionar o jogo. Tente novamente.');
        }
    }

    // ============================
    // /quero-listar
    // ============================
    if (interaction.commandName === 'quero-listar') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const lista = db.listaQuero[interaction.user.id] || [];
        if (!lista.length) {
            await interaction.editReply('📭 Sua lista /quero está vazia.');
            return;
        }
        const embed = new EmbedBuilder()
            .setTitle(`📋 Sua lista /quero (${lista.length})`)
            .setDescription(lista.map((j, i) => `${i+1}. [${j.nome}](${j.link})`).join('\n'));
        await interaction.editReply({ embeds: [embed] });
    }

    // ============================
    // /quero-remover (aceita nome ou número)
    // ============================
    if (interaction.commandName === 'quero-remover') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const input = interaction.options.getString('jogo');
        const lista = db.listaQuero[interaction.user.id] || [];

        if (!lista.length) {
            await interaction.editReply('📭 Sua lista /quero está vazia.');
            return;
        }

        let jogoRemovido = null;
        let idx = -1;

        const posicao = parseInt(input);
        if (!isNaN(posicao) && posicao >= 1 && posicao <= lista.length) {
            idx = posicao - 1;
            jogoRemovido = lista[idx];
        } else {
            const jogoBuscado = await buscarJogoCompleto(input);
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
            await interaction.editReply(`❌ Não encontrei o jogo **${input}** na sua lista. Use o nome exato ou o número da posição (ex: 1, 2, 3...).`);
            return;
        }

        lista.splice(idx, 1);
        salvarDB(db);

        await interaction.editReply(`✅ **${jogoRemovido.nome}** removido da sua lista /quero!`);
    }
});

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
// READY - com tratamento de erro robusto
// ============================
client.once('clientReady', async () => {
    console.log(`✅ Bot online: ${client.user.tag}`);
    try {
        await registrarComandos();

        // Vinculação automática dos steamIds
        const steamIds = process.env.STEAM_IDS ? process.env.STEAM_IDS.split(',').map(id => id.trim()) : [];
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
            if (dono) await dono.send('🚀 Bot Steam Família online!');
        } catch (e) {}

        // Primeira verificação de lançamentos e promoções após alguns minutos
        setTimeout(async () => {
            try { await verificarLancamentosQuero(); } catch (e) { console.error('Erro na verificação de lançamentos:', e); }
        }, 2 * 60 * 1000);

        setTimeout(async () => {
            try { await verificarPromocoesQuero(); } catch (e) { console.error('Erro na verificação de promoções:', e); }
        }, 5 * 60 * 1000);

        // Intervalos
        setInterval(async () => {
            try { await verificarPromocoesQuero(); } catch (e) { console.error('Erro ao verificar promoções:', e); }
        }, INTERVALO_PROMOCOES);

        setInterval(async () => {
            try { await verificarLancamentosQuero(); } catch (e) { console.error('Erro ao verificar lançamentos:', e); }
        }, INTERVALO_LANCAMENTOS);

        console.log('✅ Bot pronto!');
    } catch (error) {
        console.error('❌ Erro fatal na inicialização:', error);
        // Não mata o processo, apenas loga
    }
});

// ============================
// TRATAMENTO DE ERROS GLOBAIS
// ============================
process.on('unhandledRejection', (error) => {
    console.error('❌ Unhandled Rejection:', error);
});

process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught Exception:', error);
    salvarDB(db);
});

// ============================
// LOGIN
// ============================
console.log('🔄 Iniciando login...');
client.login(process.env.DISCORD_TOKEN)
    .then(() => console.log('🔑 Login realizado'))
    .catch(e => {
        console.error('❌ Erro ao login:', e);
        process.exit(1);
    });

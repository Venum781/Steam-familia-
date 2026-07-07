require('dotenv').config();
const fs = require('fs');
const path = require('path');
const http = require('http');
const axios = require('axios');
const { Client, GatewayIntentBits, EmbedBuilder, REST, Routes } = require('discord.js');

// ============================================================
// CONFIGURAÇÕES
// ============================================================
const CONFIG = {
  DISCORD_TOKEN: process.env.DISCORD_TOKEN,
  STEAM_KEY: process.env.STEAM_KEY,
  STEAM_IDS: process.env.STEAM_IDS ? process.env.STEAM_IDS.split(',').map(id => id.trim()) : [],
  CHANNEL_NOTIFICACOES: process.env.CHANNEL_ID,
  CHANNEL_RANKING: process.env.RANKING_CHANNEL_ID || '1523067407474757672',
  CHANNEL_CONQUISTAS: process.env.ACHIEVEMENT_CHANNEL_ID || '1523080625802711150',
  DONO_ID: process.env.DONO_ID || '336204841972137995',
  DATA_DIR: process.env.DATA_DIR || './data',
  PORT: process.env.PORT || 3000,
  INTERVALO_VERIFICACAO: 15000,     // 15s
  INTERVALO_ACHIEVEMENTS: 300000,   // 5min
  MAX_RETRIES: 3,
  REQUEST_TIMEOUT: 10000,
};

// Mapeamento de nomes e Discord IDs
const STEAM_NAMES = {
  '76561198127320557': 'Gardemi',
  '76561197967265286': 'Marlon',
  '76561198446717315': 'WoollySkills',
  '76561198110004039': 'Venum',
  '76561198848231901': 'Mosk'
};
const DISCORD_USERS = {
  '76561198127320557': '663789211152941065',
  '76561197967265286': '1022183877114069083',
  '76561198446717315': '479817686218702849',
  '76561198110004039': '336204841972137995',
  '76561198848231901': '499311499504910344'
};

const RANKING_PADRAO = {
  "76561198127320557": { nome: "Gardemi", jogos: 0, steamId: "76561198127320557", discordId: "663789211152941065" },
  "76561197967265286": { nome: "Marlon", jogos: 0, steamId: "76561197967265286", discordId: "1022183877114069083" },
  "76561198848231901": { nome: "Mosk", jogos: 0, steamId: "76561198848231901", discordId: "499311499504910344" },
  "76561198446717315": { nome: "WoollySkills", jogos: 0, steamId: "76561198446717315", discordId: "479817686218702849" },
  "76561198110004039": { nome: "Venum", jogos: 0, steamId: "76561198110004039", discordId: "336204841972137995" }
};

// ============================================================
// BANCO DE DADOS
// ============================================================
const DB_FILE = path.join(CONFIG.DATA_DIR, 'steam_family_db.json');
if (!fs.existsSync(CONFIG.DATA_DIR)) fs.mkdirSync(CONFIG.DATA_DIR, { recursive: true });

function carregarDB() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const raw = fs.readFileSync(DB_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed.conquistas) parsed.conquistas = {};
      if (!parsed.ranking) parsed.ranking = {};
      if (!parsed.listaQuero) parsed.listaQuero = {};
      if (!parsed.ultimaMensagemRankingId) parsed.ultimaMensagemRankingId = null;
      if (!parsed.jogosSemConquistas) parsed.jogosSemConquistas = {};
      if (!parsed.historicoJogos) parsed.historicoJogos = {};
      return parsed;
    }
  } catch (err) {
    console.error('❌ Erro ao carregar banco, criando backup...', err);
    if (fs.existsSync(DB_FILE)) {
      fs.copyFileSync(DB_FILE, `${DB_FILE}.backup_${Date.now()}`);
    }
  }
  return {
    conquistas: {},
    ranking: {},
    listaQuero: {},
    ultimaMensagemRankingId: null,
    jogosSemConquistas: {},
    historicoJogos: {}
  };
}

function salvarDB(db) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
    console.log('💾 DB salvo');
  } catch (err) {
    console.error('❌ Erro ao salvar DB:', err);
  }
}

let db = carregarDB();
if (!db.ranking || Object.keys(db.ranking).length === 0) {
  db.ranking = { ...RANKING_PADRAO };
  salvarDB(db);
}

// ============================================================
// STEAM API
// ============================================================
let ultimaRequisicao = 0;
const MIN_INTERVALO = 1500;

async function fetchSteam(url, params = {}, retries = CONFIG.MAX_RETRIES) {
  const agora = Date.now();
  const espera = Math.max(0, MIN_INTERVALO - (agora - ultimaRequisicao));
  if (espera > 0) await new Promise(r => setTimeout(r, espera));
  ultimaRequisicao = Date.now();

  for (let i = 0; i < retries; i++) {
    try {
      const resp = await axios.get(url, {
        params: { ...params, key: CONFIG.STEAM_KEY },
        timeout: CONFIG.REQUEST_TIMEOUT,
        headers: { 'User-Agent': 'SteamFamilyBot/2.0' }
      });
      if (resp.status === 429) {
        const wait = 2000 * (i + 1);
        console.log(`⏳ Rate limit, esperando ${wait}ms...`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      return resp.data;
    } catch (err) {
      if (i < retries - 1) {
        console.warn(`⚠️ Tentativa ${i+1} falhou, retentando...`);
        await new Promise(r => setTimeout(r, 2000 * (i+1)));
      } else {
        throw err;
      }
    }
  }
}

async function getOwnedGames(steamId) {
  const data = await fetchSteam(
    'https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/',
    { steamid: steamId, include_appinfo: true, include_shared_games: true, format: 'json' }
  );
  return data?.response?.games || [];
}

async function getRecentlyPlayed(steamId) {
  const data = await fetchSteam(
    'https://api.steampowered.com/IPlayerService/GetRecentlyPlayedGames/v1/',
    { steamid: steamId, count: 50, format: 'json' }
  );
  return data?.response?.games || [];
}

async function getPlayerAchievements(steamId, appId) {
  const data = await fetchSteam(
    'https://api.steampowered.com/ISteamUserStats/GetPlayerAchievements/v1/',
    { steamid: steamId, appid: appId, format: 'json' }
  );
  return data?.playerstats?.achievements || [];
}

async function getGameDetails(appId) {
  try {
    const resp = await axios.get(
      `https://store.steampowered.com/api/appdetails?appids=${appId}&l=portuguese`,
      { timeout: 10000 }
    );
    if (resp.data && resp.data[appId]?.success) {
      return resp.data[appId].data;
    }
  } catch (_) { /* ignora */ }
  return null;
}

async function searchGameOnSteam(query) {
  const data = await fetchSteam(
    'https://store.steampowered.com/api/storesearch',
    { term: query, l: 'portuguese', cc: 'BR' },
    1
  );
  if (data?.items?.length) {
    const item = data.items[0];
    return {
      appid: item.id,
      nome: item.name,
      link: `https://store.steampowered.com/app/${item.id}`,
      capa: item.tiny_image || `https://cdn.cloudflare.steamstatic.com/steam/apps/${item.id}/header.jpg`
    };
  }
  return null;
}

function extrairAppIdDaUrl(url) {
  const match = url.match(/store\.steampowered\.com\/app\/(\d+)/);
  return match ? parseInt(match[1]) : null;
}

// ============================================================
// FUNÇÕES DE NEGÓCIO
// ============================================================
function adicionarQuero(discordId, appid, nome, link) {
  if (!db.listaQuero[discordId]) db.listaQuero[discordId] = [];
  if (db.listaQuero[discordId].some(j => j.appid === appid)) {
    return { sucesso: false, motivo: 'ja_na_lista' };
  }
  // Verifica se já está na família (usando o histórico)
  const historico = db.historicoJogos || {};
  for (const sid of CONFIG.STEAM_IDS) {
    if ((historico[sid] || []).includes(appid)) {
      const dono = STEAM_NAMES[sid] || sid;
      return { sucesso: false, motivo: 'ja_na_familia', dono };
    }
  }
  db.listaQuero[discordId].push({
    appid, nome, link,
    adicionado_em: new Date().toISOString()
  });
  salvarDB(db);
  return { sucesso: true };
}

function removerQuero(discordId, appid) {
  if (!db.listaQuero[discordId]) return false;
  const antes = db.listaQuero[discordId].length;
  db.listaQuero[discordId] = db.listaQuero[discordId].filter(j => j.appid !== appid);
  if (db.listaQuero[discordId].length < antes) {
    salvarDB(db);
    return true;
  }
  return false;
}

function listarQuero(discordId) {
  return db.listaQuero[discordId] || [];
}

// ============================================================
// CLIENT DISCORD
// ============================================================
if (!CONFIG.DISCORD_TOKEN || CONFIG.DISCORD_TOKEN === 'seu_token_aqui') {
  console.error('❌ Token do Discord não definido ou inválido!');
  console.error('   Verifique o .env ou as variáveis do Railway.');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

let primeiraVerificacaoConcluida = false;
let previousGames = {};
let ultimaMensagemRankingId = db.ultimaMensagemRankingId || null;

// ============================================================
// RANKING
// ============================================================
function gerarRankingEmbed() {
  const rankingArray = Object.values(db.ranking).sort((a, b) => b.jogos - a.jogos);
  const embed = new EmbedBuilder()
    .setColor(0x00AE86)
    .setTitle('🏆 Ranking da Biblioteca Steam 2026')
    .setThumbnail('https://upload.wikimedia.org/wikipedia/commons/thumb/8/83/Steam_icon_logo.svg/1200px-Steam_icon_logo.svg.png')
    .setTimestamp()
    .setFooter({ text: `Atualizado ${new Date().toLocaleTimeString()}` });
  const medalhas = ['🥇', '🥈', '🥉'];
  let desc = '';
  rankingArray.forEach((user, i) => {
    const pos = i < 3 ? medalhas[i] : `${i+1}°`;
    const mencao = user.discordId ? `<@${user.discordId}>` : user.nome;
    desc += `${pos} **${mencao}** — ${user.jogos} jogos\n`;
  });
  embed.setDescription(desc);
  return embed;
}

async function enviarRanking() {
  const channel = client.channels.cache.get(CONFIG.CHANNEL_RANKING);
  if (!channel) return;
  try {
    if (ultimaMensagemRankingId) {
      try {
        const antiga = await channel.messages.fetch(ultimaMensagemRankingId);
        if (antiga) await antiga.delete();
      } catch (_) { /* ignora */ }
    }
    const embed = gerarRankingEmbed();
    const nova = await channel.send({ embeds: [embed] });
    ultimaMensagemRankingId = nova.id;
    db.ultimaMensagemRankingId = ultimaMensagemRankingId;
    salvarDB(db);
  } catch (err) {
    console.error('❌ Erro ao enviar ranking:', err);
  }
}

// ============================================================
// VERIFICAÇÃO DE CONQUISTAS
// ============================================================
async function verificarConquistas(steamId, games, mention, userName) {
  if (!games?.length) return;
  const channel = client.channels.cache.get(CONFIG.CHANNEL_CONQUISTAS);
  if (!channel) return;

  if (!db.conquistas[steamId]) db.conquistas[steamId] = {};

  const recentes = games
    .filter(g => g.rtime_last_played > 0)
    .sort((a, b) => b.rtime_last_played - a.rtime_last_played)
    .slice(0, 3);

  for (const game of recentes) {
    const appid = game.appid;
    const gameName = game.name || `Jogo ${appid}`;
    if (db.jogosSemConquistas[appid]) continue;

    let conquistas;
    try {
      conquistas = await getPlayerAchievements(steamId, appid);
    } catch (_) {
      db.jogosSemConquistas[appid] = { nome: gameName, data: new Date().toISOString() };
      salvarDB(db);
      continue;
    }
    if (!conquistas || conquistas.length === 0) {
      db.jogosSemConquistas[appid] = { nome: gameName, data: new Date().toISOString() };
      salvarDB(db);
      continue;
    }

    const desbloqueadas = conquistas.filter(c => c.achieved === 1);
    const total = desbloqueadas.length;
    const totalJogo = conquistas.length;

    if (!db.conquistas[steamId][appid] || !primeiraVerificacaoConcluida) {
      db.conquistas[steamId][appid] = {
        total,
        nomes: desbloqueadas.map(c => c.apiname),
        totalJogo
      };
      salvarDB(db);
      continue;
    }

    const anterior = db.conquistas[steamId][appid];
    const antigos = anterior.nomes || [];
    const novas = desbloqueadas.filter(c => !antigos.includes(c.apiname));
    if (novas.length === 0) continue;

    const faltam = totalJogo - total;
    const progresso = `${total}/${totalJogo}`;

    for (const ach of novas) {
      const nomeConquista = ach.name || ach.apiname;
      const embed = new EmbedBuilder()
        .setColor(0xFFD700)
        .setTitle(`🏆 ${userName} desbloqueou uma conquista!`)
        .setDescription(`**${nomeConquista}**`)
        .addFields(
          { name: '🎮 Jogo', value: gameName, inline: true },
          { name: '👤 Jogador', value: mention, inline: true },
          { name: '📊 Progresso', value: `${progresso} ${faltam > 0 ? `(faltam ${faltam})` : '🎉 COMPLETO!'}`, inline: true }
        )
        .setFooter({ text: `+${novas.length} nova(s) conquista(s)` })
        .setTimestamp();
      const detalhes = await getGameDetails(appid);
      if (detalhes?.header_image) embed.setThumbnail(detalhes.header_image);
      await channel.send({ embeds: [embed] });
    }

    db.conquistas[steamId][appid] = {
      total,
      nomes: desbloqueadas.map(c => c.apiname),
      totalJogo
    };
    salvarDB(db);
  }
}

// ============================================================
// VERIFICAÇÃO DE NOVOS JOGOS
// ============================================================
async function checkSteamGames() {
  const inicio = Date.now();
  console.log(`🔄 [${new Date().toLocaleTimeString()}] VERIFICANDO...`);

  try {
    const channelNotificacoes = client.channels.cache.get(CONFIG.CHANNEL_NOTIFICACOES);
    if (!channelNotificacoes) {
      console.error('❌ Canal de notificações não encontrado!');
      return;
    }

    for (const steamId of CONFIG.STEAM_IDS) {
      try {
        const games = await getOwnedGames(steamId);
        if (!games.length) continue;

        const currentGames = games.map(g => ({ name: g.name, appid: g.appid, rtime_last_played: g.rtime_last_played || 0 }));
        const userName = STEAM_NAMES[steamId] || steamId;
        const discordId = DISCORD_USERS[steamId];
        const mention = discordId ? `<@${discordId}>` : userName;

        await verificarConquistas(steamId, currentGames, mention, userName);

        if (!previousGames[steamId]) {
          previousGames[steamId] = currentGames;
          console.log(`📊 ${userName}: ${currentGames.length} jogos`);
          continue;
        }

        const oldNames = previousGames[steamId].map(g => g.appid);
        const newGames = currentGames.filter(g => !oldNames.includes(g.appid));

        if (newGames.length) {
          console.log(`🎮 ${userName} +${newGames.length} novo(s) jogo(s)!`);

          for (const game of newGames) {
            const appid = game.appid;
            const nome = game.name || `App ${appid}`;
            const link = `https://store.steampowered.com/app/${appid}`;

            // Notifica no canal
            const embed = new EmbedBuilder()
              .setColor(0x00FF00)
              .setTitle(`🛒 NOVO JOGO NA FAMÍLIA!`)
              .setDescription(`**${userName}** agora tem acesso a **${nome}**!`)
              .addFields(
                { name: '🔗 Link', value: `[Ver na Steam](${link})`, inline: false }
              )
              .setTimestamp();
            const detalhes = await getGameDetails(appid);
            if (detalhes?.header_image) embed.setImage(detalhes.header_image);
            await channelNotificacoes.send({ content: mention, embeds: [embed] });

            // Atualiza ranking
            if (db.ranking[steamId]) {
              db.ranking[steamId].jogos += 1;
              salvarDB(db);
              await enviarRanking();
            }

            // Remove da lista /quero de quem tinha (incluindo o comprador)
            for (const [discordIdQuero, jogos] of Object.entries(db.listaQuero)) {
              for (const j of jogos) {
                if (j.appid === appid) {
                  removerQuero(discordIdQuero, appid);
                  try {
                    const user = await client.users.fetch(discordIdQuero);
                    await user.send(`🎮 **${nome}** foi removido da sua lista /quero!\n✅ **${userName}** adquiriu este jogo na Steam.`);
                  } catch (_) { /* ignora */ }
                }
              }
            }
          }
        }
        previousGames[steamId] = currentGames;
        // Atualiza histórico
        db.historicoJogos[steamId] = currentGames.map(g => g.appid);
        salvarDB(db);

      } catch (err) {
        console.error(`❌ Erro em ${steamId}:`, err.message);
      }
    }

    if (!primeiraVerificacaoConcluida) {
      primeiraVerificacaoConcluida = true;
      console.log('✅ PRIMEIRA VERIFICAÇÃO CONCLUÍDA!');
      console.log('🔍 Monitorando NOVOS jogos e conquistas em tempo real!');
    }

    const duracao = ((Date.now() - inicio) / 1000).toFixed(1);
    console.log(`✅ Verificação concluída em ${duracao}s`);

  } catch (err) {
    console.error('❌ Erro geral:', err);
  }
}

// ============================================================
// REGISTRO DE COMANDOS SLASH
// ============================================================
async function registrarComandos() {
  try {
    const commands = [
      {
        name: 'tem',
        description: 'Verifica se um jogo está na biblioteca da família',
        options: [{
          name: 'jogo',
          description: 'Nome do jogo ou link da Steam',
          type: 3,
          required: true
        }]
      },
      { name: 'ranking', description: 'Mostra o ranking da biblioteca da família' },
      {
        name: 'quero',
        description: 'Adiciona um jogo à sua lista de desejos personalizada',
        options: [{
          name: 'jogo',
          description: 'Nome do jogo que você quer',
          type: 3,
          required: true
        }]
      },
      { name: 'quero-listar', description: 'Lista todos os jogos da sua lista /quero' },
      {
        name: 'quero-remover',
        description: 'Remove um jogo da sua lista /quero',
        options: [{
          name: 'jogo',
          description: 'Nome do jogo para remover',
          type: 3,
          required: true
        }]
      },
      { name: 'dbstatus', description: '[DONO] Mostra o status do banco de dados' }
    ];

    const rest = new REST({ version: '10' }).setToken(CONFIG.DISCORD_TOKEN);
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log('✅ Comandos globais registrados');
  } catch (err) {
    console.error('❌ Erro ao registrar comandos:', err);
  }
}

// ============================================================
// EVENTOS
// ============================================================
client.once('ready', async () => {
  console.log(`✅ Bot online como ${client.user.tag}`);
  await registrarComandos();
  await enviarRanking();

  // Inicializa histórico
  if (!db.historicoJogos || Object.keys(db.historicoJogos).length === 0) {
    console.log('🔄 Inicializando histórico de jogos...');
    for (const steamId of CONFIG.STEAM_IDS) {
      try {
        const games = await getOwnedGames(steamId);
        db.historicoJogos[steamId] = games.map(g => g.appid);
        console.log(`   ${STEAM_NAMES[steamId] || steamId}: ${games.length} jogos`);
      } catch (_) { /* ignora */ }
    }
    salvarDB(db);
  }

  // Inicia a primeira verificação e o loop
  await checkSteamGames();
  setInterval(checkSteamGames, CONFIG.INTERVALO_VERIFICACAO);
  console.log(`🔄 Monitorando a cada ${CONFIG.INTERVALO_VERIFICACAO/1000}s`);

  try {
    const dono = await client.users.fetch(CONFIG.DONO_ID);
    await dono.send('🚀 Bot Steam Família está online! Monitorando jogos e conquistas.');
  } catch (_) { /* ignora */ }
});

// ============================================================
// COMANDOS SLASH
// ============================================================
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  // /tem
  if (interaction.commandName === 'tem') {
    await interaction.deferReply({ ephemeral: true });
    try {
      const input = interaction.options.getString('jogo');
      let info = null;
      if (input.includes('store.steampowered.com/app/')) {
        const appid = extrairAppIdDaUrl(input);
        if (appid) {
          const detalhes = await getGameDetails(appid);
          if (detalhes) info = { appid, nome: detalhes.name, link: `https://store.steampowered.com/app/${appid}`, capa: detalhes.header_image };
        }
      } else {
        info = await searchGameOnSteam(input);
      }
      if (!info) {
        await interaction.editReply(`❌ Não encontrei **${input}** na Steam.`);
        return;
      }
      // Verifica quem tem o jogo
      const donos = [];
      for (const steamId of CONFIG.STEAM_IDS) {
        const historico = db.historicoJogos || {};
        if ((historico[steamId] || []).includes(info.appid)) {
          donos.push({ nome: STEAM_NAMES[steamId] || steamId, discordId: DISCORD_USERS[steamId] });
        }
      }
      const embed = new EmbedBuilder()
        .setColor(donos.length > 0 ? 0x00FF00 : 0xFF0000)
        .setTitle(`${donos.length > 0 ? '✅' : '❌'} ${info.nome}`)
        .setURL(info.link)
        .setFooter({ text: 'Steam Família' });
      if (info.capa) embed.setThumbnail(info.capa);
      if (donos.length > 0) {
        let desc = `🎮 **${donos.length} membro(s) possui(em):**\n`;
        donos.forEach((d, i) => {
          const mention = d.discordId ? `<@${d.discordId}>` : d.nome;
          desc += `**${i+1}.** ${mention}\n`;
        });
        embed.setDescription(desc);
      } else {
        embed.setDescription('😕 **Nenhum membro da família possui este jogo.**');
      }
      await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      await interaction.editReply(`❌ Erro: ${err.message}`);
    }
  }

  // /ranking
  if (interaction.commandName === 'ranking') {
    await interaction.deferReply({ ephemeral: true });
    const embed = gerarRankingEmbed();
    await interaction.editReply({ embeds: [embed] });
  }

  // /quero
  if (interaction.commandName === 'quero') {
    await interaction.deferReply({ ephemeral: true });
    try {
      const nome = interaction.options.getString('jogo');
      const info = await searchGameOnSteam(nome);
      if (!info) {
        await interaction.editReply(`❌ Não encontrei **${nome}** na Steam.`);
        return;
      }
      // Verifica se o usuário já tem o jogo (usando o histórico)
      let userSteamId = null;
      for (const [sid, did] of Object.entries(DISCORD_USERS)) {
        if (did === interaction.user.id) { userSteamId = sid; break; }
      }
      if (userSteamId) {
        const historico = db.historicoJogos || {};
        if ((historico[userSteamId] || []).includes(info.appid)) {
          await interaction.editReply(`ℹ️ Você **já possui** **${info.nome}** na sua biblioteca!`);
          return;
        }
      }
      const resultado = adicionarQuero(interaction.user.id, info.appid, info.nome, info.link);
      if (!resultado.sucesso) {
        if (resultado.motivo === 'ja_na_lista') {
          await interaction.editReply(`ℹ️ O jogo **${info.nome}** já está na sua lista /quero.`);
        } else if (resultado.motivo === 'ja_na_familia') {
          await interaction.editReply(`ℹ️ O jogo **${info.nome}** **já está na família!**\n👤 ${resultado.dono} já possui este jogo.`);
        }
        return;
      }
      await interaction.editReply(`✅ **${info.nome}** adicionado à sua lista /quero!\n🔗 ${info.link}\n📢 Você será notificado quando estiver disponível ou alguém comprar.`);
    } catch (err) {
      await interaction.editReply(`❌ Erro: ${err.message}`);
    }
  }

  // /quero-listar
  if (interaction.commandName === 'quero-listar') {
    await interaction.deferReply({ ephemeral: true });
    const lista = listarQuero(interaction.user.id);
    if (!lista.length) {
      await interaction.editReply('📭 Sua lista /quero está vazia.');
      return;
    }
    const embed = new EmbedBuilder()
      .setColor(0x00AE86)
      .setTitle(`📋 Sua lista /quero (${lista.length} jogos)`)
      .setDescription(lista.slice(0, 20).map((j, i) => `**${i+1}.** [${j.nome}](${j.link})`).join('\n'))
      .setFooter({ text: lista.length > 20 ? `Mostrando 20 de ${lista.length}` : '' });
    await interaction.editReply({ embeds: [embed] });
  }

  // /quero-remover
  if (interaction.commandName === 'quero-remover') {
    await interaction.deferReply({ ephemeral: true });
    try {
      const nome = interaction.options.getString('jogo');
      const info = await searchGameOnSteam(nome);
      if (!info) {
        await interaction.editReply(`❌ Não encontrei **${nome}** na Steam.`);
        return;
      }
      const removido = removerQuero(interaction.user.id, info.appid);
      if (removido) {
        await interaction.editReply(`✅ **${info.nome}** removido da sua lista /quero.`);
      } else {
        await interaction.editReply(`ℹ️ **${info.nome}** não estava na sua lista /quero.`);
      }
    } catch (err) {
      await interaction.editReply(`❌ Erro: ${err.message}`);
    }
  }

  // /dbstatus (apenas dono)
  if (interaction.commandName === 'dbstatus') {
    if (interaction.user.id !== CONFIG.DONO_ID) {
      await interaction.reply({ content: '❌ Apenas o dono pode usar este comando.', ephemeral: true });
      return;
    }
    await interaction.deferReply({ ephemeral: true });
    const totalQuero = Object.values(db.listaQuero).reduce((acc, arr) => acc + arr.length, 0);
    const totalConquistas = Object.values(db.conquistas).reduce((acc, obj) => acc + Object.keys(obj).length, 0);
    const msg = `📊 **Status do DB:**\n📋 /quero: ${totalQuero} jogos\n🏆 Conquistas rastreadas: ${totalConquistas}\n👥 Membros: ${Object.keys(db.ranking).length}\n💾 Arquivo: ${DB_FILE}`;
    await interaction.editReply(msg);
  }
});

// ============================================================
// COMANDO !resetranking (apenas dono)
// ============================================================
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (message.content.toLowerCase() === '!resetranking' && message.author.id === CONFIG.DONO_ID) {
    await message.reply('⚠️ Tem certeza? Digite `!confirmar` em 30 segundos.');
    const collector = message.channel.createMessageCollector({
      filter: m => m.author.id === CONFIG.DONO_ID && m.content.toLowerCase() === '!confirmar',
      max: 1,
      time: 30000
    });
    collector.on('collect', async () => {
      for (const sid of CONFIG.STEAM_IDS) {
        if (db.ranking[sid]) db.ranking[sid].jogos = 0;
      }
      salvarDB(db);
      await enviarRanking();
      await message.reply('✅ Ranking resetado para 0.');
    });
    collector.on('end', collected => {
      if (collected.size === 0) message.reply('⏰ Cancelado.');
    });
  }
});

// ============================================================
// HEALTH CHECK
// ============================================================
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
});
server.listen(CONFIG.PORT, () => console.log(`✅ Health check na porta ${CONFIG.PORT}`));

// ============================================================
// LOGIN
// ============================================================
client.login(CONFIG.DISCORD_TOKEN)
  .then(() => console.log('✅ Login realizado com sucesso!'))
  .catch(err => {
    console.error('❌ Erro ao fazer login:', err.message);
    process.exit(1);
  });

// Salva DB ao sair
process.on('SIGTERM', () => { salvarDB(db); process.exit(0); });
process.on('SIGINT', () => { salvarDB(db); process.exit(0); });

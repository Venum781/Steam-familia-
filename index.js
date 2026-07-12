// ============================================================
// BOT STEAM FAMÍLIA - COM LOGS DE DEPURAÇÃO
// ============================================================

console.log('🚀 [1] Iniciando o bot...');

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { Client, GatewayIntentBits, EmbedBuilder, REST, Routes } = require('discord.js');

console.log('🚀 [2] Dependências carregadas.');

// ============================================================
// 1. VARIÁVEIS DE AMBIENTE
// ============================================================
const {
  DISCORD_TOKEN,
  STEAM_KEY,
  STEAM_IDS,
  CHANNEL_ID,
  RANKING_CHANNEL_ID,
  ACHIEVEMENT_CHANNEL_ID,
  DONO_ID,
  DATA_DIR = '/data'
} = process.env;

console.log('🚀 [3] Variáveis de ambiente lidas.');
console.log(`📌 DISCORD_TOKEN presente: ${DISCORD_TOKEN ? 'SIM' : 'NÃO'}`);
console.log(`📌 STEAM_KEY presente: ${STEAM_KEY ? 'SIM' : 'NÃO'}`);
console.log(`📌 STEAM_IDS: ${STEAM_IDS}`);

if (!DISCORD_TOKEN || !STEAM_KEY || !STEAM_IDS || !CHANNEL_ID) {
  console.error('❌ Variáveis obrigatórias ausentes:');
  console.error('  DISCORD_TOKEN, STEAM_KEY, STEAM_IDS, CHANNEL_ID');
  process.exit(1);
}

console.log('🚀 [4] Variáveis validadas.');

const STEAM_IDS_ARRAY = STEAM_IDS.split(',').map(id => id.trim());

// ============================================================
// 2. MAPEAMENTO DOS MEMBROS
// ============================================================
const MEMBROS = {
  '76561198127320557': { nome: 'Gardemi', discordId: '663789211152941065' },
  '76561197967265286': { nome: 'Marlon', discordId: '1022183877114069083' },
  '76561198446717315': { nome: 'WoollySkills', discordId: '479817686218702849' },
  '76561198110004039': { nome: 'Venum', discordId: '336204841972137995' },
  '76561198848231901': { nome: 'Mosk', discordId: '499311499504910344' },
  '76561198406551864': { nome: 'DollynhoMococa', discordId: '340610951193690113' }
};

console.log('🚀 [5] Membros carregados.');

// ============================================================
// 3. CONSTANTES
// ============================================================
const RANKING_VERSION = 7;
const RANKING_VALUES = {
  '76561198127320557': 127,
  '76561197967265286': 127,
  '76561198848231901': 15,
  '76561198446717315': 17,
  '76561198110004039': 12,
  '76561198406551864': 0
};
const ACHIEVEMENT_EMOJI = '<:Trofeu:1525724119142891571>';

console.log('🚀 [6] Constantes definidas.');

// ============================================================
// 4. BANCO DE DADOS PERSISTENTE
// ============================================================
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  console.log(`📁 Pasta ${DATA_DIR} criada.`);
} else {
  console.log(`✅ Pasta ${DATA_DIR} existe.`);
}

const DB_FILE = path.join(DATA_DIR, 'steam_family_db.json');
console.log(`💾 Banco de dados em: ${DB_FILE}`);

function carregarDB() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const raw = fs.readFileSync(DB_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      console.log(`✅ DB carregado de ${DB_FILE}`);
      if (!parsed.ranking) parsed.ranking = {};
      if (!parsed.conquistas) parsed.conquistas = {};
      if (!parsed.listaQuero) parsed.listaQuero = {};
      if (!parsed.historicoJogos) parsed.historicoJogos = {};
      if (!parsed.ultimaMensagemRankingId) parsed.ultimaMensagemRankingId = null;
      if (!parsed.lancamentosNotificados) parsed.lancamentosNotificados = {};
      if (!parsed.jogosSemConquistas) parsed.jogosSemConquistas = {};
      if (!parsed.rankingVersion) parsed.rankingVersion = 0;
      
      if (Object.keys(parsed.ranking).length === 0) {
        console.log('📊 Inicializando ranking com valores fornecidos...');
        for (const [steamId, jogos] of Object.entries(RANKING_VALUES)) {
          const member = MEMBROS[steamId];
          if (member) {
            parsed.ranking[steamId] = {
              nome: member.nome,
              jogos: jogos,
              steamId: steamId,
              discordId: member.discordId
            };
          }
        }
        parsed.rankingVersion = RANKING_VERSION;
        salvarDB(parsed);
      }
      return parsed;
    } else {
      console.log(`ℹ️ DB não encontrado em ${DB_FILE}, criando novo...`);
    }
  } catch (e) {
    console.warn('⚠️ Banco corrompido, criando backup...', e);
    if (fs.existsSync(DB_FILE)) {
      fs.copyFileSync(DB_FILE, `${DB_FILE}.backup_${Date.now()}`);
    }
  }
  const novoDB = {
    ranking: {},
    conquistas: {},
    listaQuero: {},
    historicoJogos: {},
    ultimaMensagemRankingId: null,
    lancamentosNotificados: {},
    jogosSemConquistas: {},
    rankingVersion: 0
  };
  for (const [steamId, jogos] of Object.entries(RANKING_VALUES)) {
    const member = MEMBROS[steamId];
    if (member) {
      novoDB.ranking[steamId] = {
        nome: member.nome,
        jogos: jogos,
        steamId: steamId,
        discordId: member.discordId
      };
    }
  }
  novoDB.rankingVersion = RANKING_VERSION;
  console.log('📊 Ranking inicial criado com os valores fornecidos.');
  salvarDB(novoDB);
  return novoDB;
}

function salvarDB(db) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
    const totalQuero = Object.values(db.listaQuero || {}).reduce((acc, arr) => acc + (arr ? arr.length : 0), 0);
    console.log(`💾 DB salvo em ${DB_FILE} | /quero: ${totalQuero} jogos | Ranking: ${Object.keys(db.ranking || {}).length} membros`);
  } catch (err) {
    console.error('❌ Erro ao salvar DB:', err);
  }
}

console.log('🚀 [7] Carregando banco de dados...');
let db = carregarDB();
console.log('🚀 [8] Banco de dados carregado.');

// ============================================================
// 5. FUNÇÕES DA STEAM API (RESUMIDAS PARA ECONOMIZAR ESPAÇO)
// ============================================================
let ultimaRequisicao = 0;
const MIN_INTERVALO = 1500;

async function fetchSteam(url, params = {}, retries = 3) {
  const agora = Date.now();
  const espera = Math.max(0, MIN_INTERVALO - (agora - ultimaRequisicao));
  if (espera > 0) await new Promise(r => setTimeout(r, espera));
  ultimaRequisicao = Date.now();

  for (let i = 0; i < retries; i++) {
    try {
      const resp = await axios.get(url, {
        params: { ...params, key: STEAM_KEY },
        timeout: 10000,
        headers: { 'User-Agent': 'SteamFamilyBot/2.0' }
      });
      if (resp.status === 429) {
        await new Promise(r => setTimeout(r, 2000 * (i + 1)));
        continue;
      }
      return resp.data;
    } catch (e) {
      if (i === retries - 1) throw e;
      await new Promise(r => setTimeout(r, 2000 * (i + 1)));
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

async function getRecentlyPlayedGames(steamId, limit = 3) {
  const data = await fetchSteam(
    'https://api.steampowered.com/IPlayerService/GetRecentlyPlayedGames/v1/',
    { steamid: steamId, count: limit, format: 'json' }
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
  } catch (_) {}
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

async function getPriceOverview(appId) {
  try {
    const resp = await axios.get(
      `https://store.steampowered.com/api/appdetails?appids=${appId}&cc=br`,
      { timeout: 10000 }
    );
    if (resp.data && resp.data[appId]?.success) {
      const game = resp.data[appId].data;
      const price = game.price_overview;
      if (price) {
        return {
          nome: game.name,
          appid: appId,
          link: `https://store.steampowered.com/app/${appId}`,
          precoAtual: price.final_formatted,
          precoAntigo: price.initial_formatted,
          emPromocao: price.final < price.initial,
          desconto: price.discount_percent || 0
        };
      }
    }
  } catch (_) {}
  return null;
}

async function getCurrentGame(steamId) {
  try {
    const url = `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/`;
    const params = { key: STEAM_KEY, steamids: steamId };
    const data = await fetchSteam(url, params, 2);
    if (data?.response?.players?.length) {
      const player = data.response.players[0];
      if (player.gameid) {
        return {
          appid: parseInt(player.gameid),
          name: player.gameextrainfo || `Jogo ${player.gameid}`
        };
      }
    }
  } catch (e) {
    console.error(`❌ Erro ao buscar jogo atual de ${steamId}:`, e.message);
  }
  return null;
}

const achievementNameCache = {};

async function getAchievementDisplayName(appId, apiname) {
  const cacheKey = `${appId}_${apiname}`;
  if (achievementNameCache[cacheKey]) {
    return achievementNameCache[cacheKey];
  }

  try {
    const url = `https://api.steampowered.com/ISteamUserStats/GetSchemaForGame/v2/`;
    const params = { key: STEAM_KEY, appid: appId, l: 'portuguese' };
    const data = await fetchSteam(url, params, 2);

    if (data?.game?.availableGameStats?.achievements) {
      const ach = data.game.availableGameStats.achievements.find(a => a.name === apiname);
      if (ach && ach.displayName) {
        achievementNameCache[cacheKey] = ach.displayName;
        return ach.displayName;
      }
    }
  } catch (_) {}

  achievementNameCache[cacheKey] = apiname;
  return apiname;
}

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

async function verificarCompatibilidadeFamilia(appId) {
  if (JOGOS_INCOMPATIVEIS[appId]) {
    return {
      compatível: false,
      motivo: `Este jogo (${JOGOS_INCOMPATIVEIS[appId]}) NÃO é compatível com Family Sharing (lista conhecida)`
    };
  }

  try {
    const detalhes = await getGameDetails(appId);
    if (detalhes) {
      const publishers = detalhes.publishers || [];
      const developers = detalhes.developers || [];

      const isEA = publishers.some(p => 
        p.toLowerCase().includes('ea ') || 
        p.toLowerCase().includes('electronic arts') ||
        p === 'EA' ||
        p === 'Electronic Arts'
      ) || developers.some(d => 
        d.toLowerCase().includes('ea ') || 
        d.toLowerCase().includes('electronic arts') ||
        d === 'EA' ||
        d === 'Electronic Arts'
      );

      if (isEA) {
        return {
          compatível: false,
          motivo: 'Jogos da Electronic Arts (EA) NÃO são compatíveis com Family Sharing'
        };
      }

      const isRockstar = publishers.some(p => 
        p.toLowerCase().includes('rockstar')
      ) || developers.some(d => 
        d.toLowerCase().includes('rockstar')
      );

      if (isRockstar) {
        return {
          compatível: false,
          motivo: 'Jogos da Rockstar Games NÃO são compatíveis com Family Sharing'
        };
      }

      const isUbisoft = publishers.some(p => 
        p.toLowerCase().includes('ubisoft')
      ) || developers.some(d => 
        d.toLowerCase().includes('ubisoft')
      );

      if (isUbisoft) {
        return {
          compatível: false,
          motivo: 'Jogos da Ubisoft NÃO são compatíveis com Family Sharing'
        };
      }

      if (detalhes.is_free) {
        return { compatível: false, motivo: 'Jogo gratuito não requer Family Sharing' };
      }
      
      if (detalhes.exclude_from_family_sharing === true) {
        return { compatível: false, motivo: 'Este jogo NÃO é compatível com Family Sharing' };
      }
      
      if (!detalhes.price_overview) {
        return { compatível: false, motivo: 'Jogo sem preço definido' };
      }

      return { compatível: true, motivo: null };
    }
  } catch (e) {
    console.error(`❌ Erro ao verificar compatibilidade do jogo ${appId}:`, e.message);
  }
  
  return { compatível: true, motivo: null };
}

function extrairAppIdDaUrl(url) {
  const match = url.match(/store\.steampowered\.com\/app\/(\d+)/);
  return match ? parseInt(match[1]) : null;
}

console.log('🚀 [9] Funções da Steam API carregadas.');

// ============================================================
// 6. FUNÇÕES DE NEGÓCIO
// ============================================================
async function adicionarQuero(discordId, appid, nome, link) {
  if (!db.listaQuero[discordId]) db.listaQuero[discordId] = [];
  if (db.listaQuero[discordId].some(j => j.appid === appid)) {
    return { sucesso: false, motivo: 'ja_na_lista' };
  }
  for (const sid of STEAM_IDS_ARRAY) {
    if ((db.historicoJogos[sid] || []).includes(appid)) {
      const dono = MEMBROS[sid]?.nome || sid;
      return { sucesso: false, motivo: 'ja_na_familia', dono };
    }
  }

  let comingSoon = null;
  try {
    const detalhes = await getGameDetails(appid);
    if (detalhes && detalhes.release_date) {
      comingSoon = detalhes.release_date.coming_soon === true;
    }
  } catch (_) {
    comingSoon = null;
  }

  db.listaQuero[discordId].push({
    appid,
    nome,
    link,
    adicionado_em: new Date().toISOString(),
    coming_soon: comingSoon,
    ultimoEstadoPromocao: null
  });

  salvarDB(db);
  return { sucesso: true };
}

function removerQuero(discordId, appid) {
  if (!db.listaQuero[discordId]) return false;
  const antes = db.listaQuero[discordId].length;
  db.listaQuero[discordId] = db.listaQuero[discordId].filter(j => j.appid !== appid);
  if (db.listaQuero[discordId].length < antes) {
    const chave = `${discordId}_${appid}`;
    if (db.lancamentosNotificados && db.lancamentosNotificados[chave]) {
      delete db.lancamentosNotificados[chave];
    }
    salvarDB(db);
    return true;
  }
  return false;
}

function listarQuero(discordId) {
  return db.listaQuero[discordId] || [];
}

console.log('🚀 [10] Funções de negócio carregadas.');

// ============================================================
// 7. CLIENT DISCORD
// ============================================================
console.log('🚀 [11] Criando cliente Discord...');
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});
console.log('🚀 [12] Cliente Discord criado.');

let primeiraVerificacaoConcluida = false;
let previousGames = {};
let ultimaMensagemRankingId = db.ultimaMensagemRankingId || null;

// ============================================================
// 8. RANKING
// ============================================================
function gerarRankingEmbed() {
  const rankingArray = Object.values(db.ranking || {}).sort((a, b) => b.jogos - a.jogos);
  const embed = new EmbedBuilder()
    .setColor(0x00AE86)
    .setTitle('🏆 Ranking da Biblioteca Steam 2026')
    .setThumbnail('https://upload.wikimedia.org/wikipedia/commons/thumb/8/83/Steam_icon_logo.svg/1200px-Steam_icon_logo.svg.png')
    .setTimestamp();

  let desc = '';
  rankingArray.forEach((user, i) => {
    const pos = i + 1;
    const mencao = user.discordId ? `<@${user.discordId}>` : user.nome;
    desc += `${pos}º **${mencao}** — ${user.jogos} jogos\n`;
  });

  embed.setDescription(desc);

  const totalJogos = rankingArray.reduce((acc, user) => acc + user.jogos, 0);
  embed.setFooter({ text: `Total de jogos: ${totalJogos} • Atualizado ${new Date().toLocaleTimeString()}` });

  return embed;
}

function atualizarRanking() {
  console.log('📊 Atualizando ranking com os valores fornecidos...');
  for (const [steamId, jogos] of Object.entries(RANKING_VALUES)) {
    const member = MEMBROS[steamId];
    if (member && db.ranking[steamId]) {
      db.ranking[steamId].jogos = jogos;
    } else if (member && !db.ranking[steamId]) {
      db.ranking[steamId] = {
        nome: member.nome,
        jogos: jogos,
        steamId: steamId,
        discordId: member.discordId
      };
    }
  }
  db.rankingVersion = RANKING_VERSION;
  salvarDB(db);
  console.log('✅ Ranking atualizado com sucesso!');
}

async function enviarRanking() {
  const channel = client.channels.cache.get(RANKING_CHANNEL_ID);
  if (!channel) return;
  try {
    if (ultimaMensagemRankingId) {
      try {
        const antiga = await channel.messages.fetch(ultimaMensagemRankingId);
        if (antiga) await antiga.delete();
      } catch (_) {}
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

console.log('🚀 [13] Funções de ranking carregadas.');

// ============================================================
// 9. VERIFICAÇÃO DE CONQUISTAS (SIMPLIFICADA PARA TESTE)
// ============================================================
async function verificarConquistas(steamId, gamesToCheck, mention, userName) {
  // Versão simplificada para teste – apenas log
  console.log(`🏆 ${userName}: verificação de conquistas (simplificada)`);
  return;
}

// ============================================================
// 10. VERIFICAÇÃO DE LANÇAMENTOS, PROMOÇÕES E NOVOS JOGOS (SIMPLIFICADAS)
// ============================================================
async function verificarLancamentosQuero() {
  console.log('🔄 Verificando lançamentos (simplificado)');
}

async function verificarPromocoesQuero() {
  console.log('🔄 Verificando promoções (simplificado)');
}

async function checkNewGames() {
  console.log('🔄 Verificando novos jogos (simplificado)');
}

async function checkAchievements() {
  console.log('🔄 Verificando conquistas (simplificado)');
}

console.log('🚀 [14] Funções simplificadas carregadas.');

// ============================================================
// 11. REGISTRO DE COMANDOS SLASH (SIMPLIFICADO)
// ============================================================
async function registrarComandos() {
  console.log('📝 Registrando comandos (simplificado)...');
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
      {
        name: 'ranking',
        description: 'Mostra o ranking da biblioteca da família'
      }
    ];

    const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log('✅ Comandos registrados (simplificado)');
  } catch (err) {
    console.error('❌ Erro ao registrar comandos:', err);
  }
}

console.log('🚀 [15] Tudo carregado. Aguardando evento ready...');

// ============================================================
// 12. EVENTO READY (VERSÃO SIMPLIFICADA PARA TESTE)
// ============================================================
client.once('ready', async () => {
  console.log('✅ [EVENTO ready] Bot online como', client.user.tag);
  console.log('💾 Usando banco de dados em:', DB_FILE);

  console.log('📝 Registrando comandos...');
  await registrarComandos();

  console.log('📊 Atualizando ranking...');
  if (!db.rankingVersion || db.rankingVersion < RANKING_VERSION) {
    atualizarRanking();
    await enviarRanking();
  }

  console.log('🔄 Iniciando verificações...');
  await checkAchievements();
  setInterval(checkAchievements, 30000);

  await checkNewGames();
  setInterval(checkNewGames, 300000);

  await verificarLancamentosQuero();
  setInterval(verificarLancamentosQuero, 5 * 60 * 1000);

  await verificarPromocoesQuero();
  setInterval(verificarPromocoesQuero, 5 * 60 * 1000);

  console.log('✅ Bot completamente inicializado!');

  try {
    const dono = await client.users.fetch(DONO_ID);
    await dono.send('🚀 Bot Steam Família está online!');
  } catch (_) {}
});

// ============================================================
// 13. EVENTO INTERACTION CREATE (SIMPLIFICADO)
// ============================================================
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'tem') {
    await interaction.reply({ content: 'Comando /tem funcionando!', ephemeral: true });
  }

  if (interaction.commandName === 'ranking') {
    await interaction.reply({ content: 'Comando /ranking funcionando!', ephemeral: true });
  }
});

// ============================================================
// 14. !resetranking (SIMPLIFICADO)
// ============================================================
client.on('messageCreate', async (message) => {
  if (message.author.bot || message.author.id !== DONO_ID) return;
  if (message.content.toLowerCase() !== '!resetranking') return;

  await message.reply('⚠️ Tem certeza? Digite `!confirmar` em 30 segundos.');
  const collector = message.channel.createMessageCollector({
    filter: m => m.author.id === DONO_ID && m.content.toLowerCase() === '!confirmar',
    max: 1,
    time: 30000
  });
  collector.on('collect', async () => {
    for (const sid of STEAM_IDS_ARRAY) {
      if (db.ranking[sid]) db.ranking[sid].jogos = 0;
    }
    db.rankingVersion = 0;
    salvarDB(db);
    await enviarRanking();
    db.rankingVersion = RANKING_VERSION;
    salvarDB(db);
    await message.reply('✅ Ranking resetado.');
  });
  collector.on('end', collected => {
    if (collected.size === 0) message.reply('⏰ Cancelado.');
  });
});

console.log('🚀 [16] Eventos registrados. Preparando para login...');

// ============================================================
// 15. LOGIN
// ============================================================
console.log('🔑 Tentando login com o token...');
console.log(`📌 Token presente: ${DISCORD_TOKEN ? 'SIM' : 'NÃO'}`);
console.log(`📌 Primeiros 10 caracteres do token: ${DISCORD_TOKEN ? DISCORD_TOKEN.substring(0, 10) + '...' : 'N/A'}`);

client.login(DISCORD_TOKEN)
  .then(() => console.log('✅ Login bem-sucedido!'))
  .catch(err => {
    console.error('❌ Erro ao fazer login:', err.message);
    console.error('❌ Stack:', err.stack);
    process.exit(1);
  });

process.on('SIGTERM', () => { salvarDB(db); process.exit(0); });
process.on('SIGINT', () => { salvarDB(db); process.exit(0); });

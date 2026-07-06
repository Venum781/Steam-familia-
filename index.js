require('dotenv').config();
const fs = require('fs');
const path = require('path');

const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');

// 🔹 CONFIGURAÇÕES OTIMIZADAS
const INTERVALO_VERIFICACAO = 15 * 1000;
const MAX_JOGOS_POR_USUARIO = 8;
const MAX_CONQUISTAS_POR_JOGO = 30;

const client = new Client({ 
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ] 
});

// 🔹 IDs dos canais
const CHANNEL_NOTIFICACOES = process.env.CHANNEL_ID;
const CHANNEL_RANKING = "1523067407474757672";
const CHANNEL_CONQUISTAS = "1523080625802711150";
const CHANNEL_PROMOCOES = "1523668313094225961";

// 🔹 ID do dono do bot (para receber DMs de status)
const DONO_ID = "336204841972137995";

// 🔹 CONFIGURAÇÃO DE TESTE (APENAS VENUM)
const TEST_STEAM_ID = "76561198110004039";
const TEST_DISCORD_ID = "336204841972137995";

const DB_FILE = path.join(__dirname, 'steam_achievements_db.json');

// 🔹 Cache de compatibilidade
const compatibilidadeCache = {};

// 🔹 ============================================
// 🔹 LISTA DE JOGOS NÃO COMPATÍVEIS COM FAMÍLIA STEAM
// 🔹 ============================================
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
      if (!parsed.promocoes) parsed.promocoes = {};
      if (!parsed.steamLinks) parsed.steamLinks = {};
      if (!parsed.jogosNotificados) parsed.jogosNotificados = {};
      if (!parsed.listaQuero) parsed.listaQuero = {};
      return parsed;
    }
  } catch (error) {
    console.error('❌ Erro ao carregar banco:', error);
  }
  return { conquistas: {}, jogosRecentes: {}, ranking: {}, promocoes: {}, steamLinks: {}, jogosNotificados: {}, listaQuero: {} };
}

function salvarDB(db) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
    console.log('💾 Banco de dados salvo!');
  } catch (error) {
    console.error('❌ Erro ao salvar banco:', error);
  }
}

let db = carregarDB();
if (!db.conquistas) db.conquistas = {};
if (!db.jogosRecentes) db.jogosRecentes = {};
if (!db.ranking) db.ranking = {};
if (!db.promocoes) db.promocoes = {};
if (!db.steamLinks) db.steamLinks = {};
if (!db.jogosNotificados) db.jogosNotificados = {};
if (!db.listaQuero) db.listaQuero = {};

// 🔹 ============================================
// 🔹 RANKING (COM PERSISTÊNCIA CORRIGIDA)
// 🔹 ============================================

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
    db.ranking = ranking;
    salvarDB(db);
    console.log(`📊 Ranking carregado do banco de dados: ${Object.keys(ranking).length} usuários`);
    return;
  }
  
  console.log('📊 Nenhum ranking salvo encontrado. Usando valores padrão...');
  ranking = JSON.parse(JSON.stringify(rankingPadrao));
  db.ranking = ranking;
  salvarDB(db);
}

carregarRanking();

let previousGames = {};
let ultimaMensagemRankingId = null;
let primeiraVerificacaoConcluida = false;

// 🔹 Caches
const gameNameCache = {};
const achievementNameCache = {};

// 🔹 ============================================
// 🔹 FUNÇÕES AUXILIARES
// 🔹 ============================================

async function fetchWithTimeout(url, timeout = 5000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);
    return response;
  } catch (error) {
    clearTimeout(timeoutId);
    throw error;
  }
}

async function getGameDetails(appid) {
  if (gameNameCache[appid]) return gameNameCache[appid];
  try {
    const url = `https://store.steampowered.com/api/appdetails?appids=${appid}&l=portuguese`;
    const response = await fetchWithTimeout(url);
    const data = await response.json();
    if (data[appid]?.success) {
      const info = {
        name: data[appid].data.name,
        icon: data[appid].data.header_image || data[appid].data.capsule_image
      };
      gameNameCache[appid] = info;
      return info;
    }
  } catch (error) {
    console.error(`❌ Erro ao buscar jogo ${appid}:`, error.message);
  }
  return { name: `Jogo ${appid}`, icon: null };
}

async function getAchievementName(steamId, appid, apiname) {
  const cacheKey = `${appid}_${apiname}`;
  if (achievementNameCache[cacheKey]) return achievementNameCache[cacheKey];
  try {
    const url = `https://api.steampowered.com/ISteamUserStats/GetSchemaForGame/v2/?key=${process.env.STEAM_KEY}&appid=${appid}&l=portuguese`;
    const response = await fetchWithTimeout(url);
    const data = await response.json();
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
    const response = await fetchWithTimeout(url, 4000);
    const data = await response.json();
    if (data.playerstats?.achievements) {
      return data.playerstats.achievements;
    }
  } catch (error) {
    console.error(`❌ Erro ao buscar conquistas ${appid}:`, error.message);
  }
  return [];
}

async function buscarIconeConquista(appid, apiname) {
  try {
    const url = `https://api.steampowered.com/ISteamUserStats/GetSchemaForGame/v2/?key=${process.env.STEAM_KEY}&appid=${appid}&l=portuguese`;
    const response = await fetchWithTimeout(url, 3000);
    const data = await response.json();
    
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
    const response = await fetchWithTimeout(url, 3000);
    const data = await response.json();
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
    const response = await fetchWithTimeout(url, 5000);
    const data = await response.json();
    
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
    const response = await fetchWithTimeout(url, 5000);
    const data = await response.json();
    
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

// 🔹 ============================================
// 🔹 FUNÇÃO: buscarAppIdPorNome
// 🔹 ============================================
async function buscarAppIdPorNome(nomeJogo) {
  try {
    const url = `https://store.steampowered.com/api/storesearch?term=${encodeURIComponent(nomeJogo)}&l=portuguese&cc=BR&max=1`;
    const response = await fetchWithTimeout(url, 3000);
    const data = await response.json();
    
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

// 🔹 ============================================
// 🔹 FUNÇÃO: buscarListaDesejosSteam
// 🔹 ============================================
async function buscarListaDesejosSteam(steamId) {
  try {
    const url = `https://api.steampowered.com/IWishlistService/GetWishlist/v1/?key=${process.env.STEAM_KEY}&steamid=${steamId}`;
    const response = await fetchWithTimeout(url, 5000);
    const data = await response.json();
    
    if (data.response && data.response.items) {
      return data.response.items.map(item => item.appid);
    }
    return [];
  } catch (error) {
    console.error(`❌ Erro ao buscar lista de desejos de ${steamId}:`, error.message);
    return [];
  }
}

// 🔹 ============================================
// 🔹 FUNÇÃO: verificarPrecoJogo
// 🔹 ============================================
async function verificarPrecoJogo(appid) {
  try {
    const url = `https://store.steampowered.com/api/appdetails?appids=${appid}&cc=br`;
    const response = await fetchWithTimeout(url, 5000);
    const data = await response.json();
    
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

// 🔹 ============================================
// 🔹 FUNÇÃO: verificarDisponibilidadeJogo (CORRIGIDA)
// 🔹 ============================================
async function verificarDisponibilidadeJogo(appid) {
  try {
    const url = `https://store.steampowered.com/api/appdetails?appids=${appid}&l=portuguese`;
    const response = await fetchWithTimeout(url, 5000);
    const data = await response.json();
    
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

// 🔹 ============================================
// 🔹 FUNÇÃO: verificarJogoFamilia
// 🔹 ============================================
async function verificarJogoFamilia(appid) {
  const donos = [];
  const steamIds = process.env.STEAM_IDS.split(',').map(id => id.trim());
  const apiKey = process.env.STEAM_KEY;
  
  for (const steamId of steamIds) {
    try {
      const url = `https://api.steampowered.com/IPlayerService/GetOwnedGames/v0001/?key=${apiKey}&steamid=${steamId}&include_appinfo=true&include_played_free_games=true&format=json`;
      const response = await fetchWithTimeout(url, 5000);
      const data = await response.json();
      
      if (data.response?.games) {
        const temJogo = data.response.games.some(g => g.appid === appid);
        if (temJogo) {
          const userName = steamNames[steamId] || `Usuário ${steamId.substring(0, 8)}`;
          donos.push({ steamId, nome: userName });
        }
      }
    } catch (error) {
      console.error(`❌ Erro ao verificar ${steamId}:`, error.message);
    }
  }
  
  return donos;
}

// 🔹 ============================================
// 🔹 FUNÇÃO: adicionarQuero
// 🔹 ============================================
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
      const response = await fetchWithTimeout(url, 5000);
      const data = await response.json();
      
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

// 🔹 ============================================
// 🔹 FUNÇÃO: removerQuero
// 🔹 ============================================
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

// 🔹 ============================================
// 🔹 FUNÇÃO: listarQuero
// 🔹 ============================================
function listarQuero(discordId) {
  if (!db.listaQuero[discordId] || db.listaQuero[discordId].length === 0) {
    return [];
  }
  return db.listaQuero[discordId];
}

// 🔹 ============================================
// 🔹 FUNÇÃO: verificarListaDesejosComprados
// 🔹 ============================================
async function verificarListaDesejosComprados(jogoAppid, jogoNome, compradorSteamId, compradorNome) {
  console.log(`🔍 Verificando lista de desejos para ${jogoNome}...`);
  
  try {
    const steamIds = process.env.STEAM_IDS.split(',').map(id => id.trim());
    
    for (const steamId of steamIds) {
      if (steamId === compradorSteamId) continue;
      
      const listaDesejos = await buscarListaDesejosSteam(steamId);
      
      if (listaDesejos.includes(jogoAppid)) {
        const discordId = discordUsers[steamId];
        if (!discordId) continue;
        
        try {
          const usuario = await client.users.fetch(discordId).catch(() => null);
          if (usuario) {
            await usuario.send(
              `🎮 **${jogoNome}** foi comprado por **${compradorNome}**!\n` +
              `📢 Este jogo estava na sua lista de desejos da Steam.\n` +
              `🔗 https://store.steampowered.com/app/${jogoAppid}`
            );
            console.log(`✅ DM enviada para ${usuario.username}: ${jogoNome} comprado por ${compradorNome}`);
          }
        } catch (error) {
          console.error(`❌ Erro ao enviar DM para ${discordId}:`, error.message);
        }
      }
    }
  } catch (error) {
    console.error('❌ Erro ao verificar lista de desejos:', error);
  }
}

// 🔹 ============================================
// 🔹 FUNÇÃO: podeNotificarPromocao
// 🔹 ============================================
function podeNotificarPromocao(steamId) {
  const hoje = new Date().toLocaleDateString('pt-BR');
  
  if (!db.promocoes[steamId]) {
    db.promocoes[steamId] = {
      data: hoje,
      contador: 0
    };
    return true;
  }
  
  if (db.promocoes[steamId].data !== hoje) {
    db.promocoes[steamId].data = hoje;
    db.promocoes[steamId].contador = 0;
    return true;
  }
  
  if (db.promocoes[steamId].contador >= 2) {
    return false;
  }
  
  return true;
}

// 🔹 ============================================
// 🔹 FUNÇÃO: registrarNotificacaoPromocao
// 🔹 ============================================
function registrarNotificacaoPromocao(steamId) {
  const hoje = new Date().toLocaleDateString('pt-BR');
  
  if (!db.promocoes[steamId]) {
    db.promocoes[steamId] = {
      data: hoje,
      contador: 1
    };
  } else {
    db.promocoes[steamId].contador += 1;
  }
  
  salvarDB(db);
}

// 🔹 ============================================
// 🔹 FUNÇÃO: jogoJaNotificado
// 🔹 ============================================
function jogoJaNotificado(steamId, appid) {
  const hoje = new Date().toLocaleDateString('pt-BR');
  
  if (!db.jogosNotificados[steamId]) {
    db.jogosNotificados[steamId] = {};
  }
  
  if (!db.jogosNotificados[steamId][hoje]) {
    db.jogosNotificados[steamId][hoje] = [];
  }
  
  return db.jogosNotificados[steamId][hoje].includes(appid);
}

// 🔹 ============================================
// 🔹 FUNÇÃO: registrarJogoNotificado
// 🔹 ============================================
function registrarJogoNotificado(steamId, appid) {
  const hoje = new Date().toLocaleDateString('pt-BR');
  
  if (!db.jogosNotificados[steamId]) {
    db.jogosNotificados[steamId] = {};
  }
  
  if (!db.jogosNotificados[steamId][hoje]) {
    db.jogosNotificados[steamId][hoje] = [];
  }
  
  db.jogosNotificados[steamId][hoje].push(appid);
  salvarDB(db);
}

// 🔹 ============================================
// 🔹 FUNÇÃO: verificarPromocoes (AUTOMÁTICA)
// 🔹 ============================================
async function verificarPromocoes() {
  console.log(`🔄 Verificando promoções automaticamente...`);
  
  const channelPromocoes = client.channels.cache.get(CHANNEL_PROMOCOES);
  if (!channelPromocoes) {
    console.error('❌ Canal de promoções não encontrado!');
    return;
  }
  
  try {
    const steamId = TEST_STEAM_ID;
    const userName = steamNames[steamId] || 'Venum';
    const mention = `<@${TEST_DISCORD_ID}>`;
    
    const lista = await buscarListaDesejosSteam(steamId);
    
    if (lista.length === 0) {
      console.log(`ℹ️ Sua lista de desejos está vazia.`);
      return;
    }
    
    console.log(`📋 ${userName} tem ${lista.length} jogos na lista de desejos`);
    
    const listaEmbaralhada = lista.sort(() => Math.random() - 0.5);
    
    let notificacoesEnviadas = 0;
    
    for (const appid of listaEmbaralhada) {
      if (jogoJaNotificado(steamId, appid)) {
        console.log(`ℹ️ Jogo ${appid} já foi notificado hoje.`);
        continue;
      }
      
      const preco = await verificarPrecoJogo(appid);
      
      if (!preco) continue;
      
      const donos = await verificarJogoFamilia(appid);
      
      if (preco.emPromocao && donos.length === 0) {
        if (!podeNotificarPromocao(steamId)) {
          console.log(`ℹ️ Você já atingiu o limite de 2 promoções hoje.`);
          break;
        }
        
        const embed = new EmbedBuilder()
          .setColor(0x00FF00)
          .setTitle(`🎉 ${preco.nome} está em promoção!`)
          .setURL(preco.link)
          .setDescription(
            `💸 **${preco.desconto}% de desconto!**\n\n` +
            `💰 Preço antigo: ~~${preco.precoAntigo}~~\n` +
            `💰 Preço atual: **${preco.precoAtual}**\n` +
            `👤 Membro: ${mention}\n` +
            `📢 **Ninguém na família possui este jogo!**\n\n` +
            `🔗 **[Comprar na Steam](${preco.link})**`
          )
          .setThumbnail(`https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/header.jpg`)
          .setFooter({ text: 'Steam Família - Promoções' })
          .setTimestamp();
        
        await channelPromocoes.send({ 
          content: `${mention} 🎮`,
          embeds: [embed] 
        });
        
        console.log(`✅ Promoção detectada: ${preco.nome} (${preco.desconto}%) para ${userName}`);
        notificacoesEnviadas++;
        
        registrarNotificacaoPromocao(steamId);
        registrarJogoNotificado(steamId, appid);
      }
      
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    if (notificacoesEnviadas === 0) {
      console.log(`ℹ️ Nenhuma promoção nova encontrada para ${userName} hoje.`);
    } else {
      console.log(`✅ ${notificacoesEnviadas} promoções notificadas para ${userName}`);
    }
    
  } catch (error) {
    console.error('❌ Erro ao verificar promoções:', error);
  }
}

// 🔹 ============================================
// 🔹 FUNÇÃO: verificarPromocoesQuero
// 🔹 ============================================
async function verificarPromocoesQuero() {
  console.log(`🔄 Verificando promoções da lista /quero...`);
  
  try {
    for (const [discordId, jogos] of Object.entries(db.listaQuero)) {
      if (!jogos || jogos.length === 0) continue;
      
      const usuario = await client.users.fetch(discordId).catch(() => null);
      if (!usuario) continue;
      
      for (const jogo of jogos) {
        const preco = await verificarPrecoJogo(jogo.appid);
        if (!preco) continue;
        
        if (preco.emPromocao) {
          const hoje = new Date().toLocaleDateString('pt-BR');
          const chaveNotificacao = `quero_${discordId}_${jogo.appid}`;
          
          if (!db.jogosNotificados) db.jogosNotificados = {};
          if (!db.jogosNotificados[chaveNotificacao]) {
            db.jogosNotificados[chaveNotificacao] = {};
          }
          
          if (db.jogosNotificados[chaveNotificacao][hoje]) {
            continue;
          }
          
          try {
            const embed = new EmbedBuilder()
              .setColor(0x00FF00)
              .setTitle(`🎉 ${preco.nome} está em promoção!`)
              .setURL(preco.link)
              .setDescription(
                `💸 **${preco.desconto}% de desconto!**\n\n` +
                `💰 Preço antigo: ~~${preco.precoAntigo}~~\n` +
                `💰 Preço atual: **${preco.precoAtual}**\n` +
                `📢 **Este jogo estava na sua lista /quero!**\n\n` +
                `🔗 **[Comprar na Steam](${preco.link})**`
              )
              .setThumbnail(`https://cdn.cloudflare.steamstatic.com/steam/apps/${jogo.appid}/header.jpg`)
              .setFooter({ text: 'Steam Família - Promoções /quero' })
              .setTimestamp();
            
            await usuario.send({ embeds: [embed] });
            console.log(`✅ DM enviada para ${usuario.username}: ${preco.nome} em promoção!`);
            
            db.jogosNotificados[chaveNotificacao][hoje] = true;
            salvarDB(db);
          } catch (error) {
            console.error(`❌ Erro ao enviar DM para ${usuario.username}:`, error.message);
          }
        }
      }
      
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
  } catch (error) {
    console.error('❌ Erro ao verificar promoções /quero:', error);
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
      
      const steamId = db.steamLinks?.[discordId];
      if (!steamId) {
        console.log(`⚠️ Usuário ${discordId} não vinculou a Steam.`);
        continue;
      }
      
      const url = `https://api.steampowered.com/IPlayerService/GetOwnedGames/v0001/?key=${process.env.STEAM_KEY}&steamid=${steamId}&include_appinfo=true&format=json`;
      const response = await fetchWithTimeout(url, 5000);
      const data = await response.json();
      
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
        const response = await fetchWithTimeout(url, 5000);
        const data = await response.json();
        
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
// 🔹 FUNÇÃO: verificarJogosNaoLancadosQuero (ATUALIZADA)
// 🔹 ============================================
async function verificarJogosNaoLancadosQuero() {
  console.log(`🔄 Verificando jogos não lançados da lista /quero...`);
  
  try {
    for (const [discordId, jogos] of Object.entries(db.listaQuero)) {
      if (!jogos || jogos.length === 0) continue;
      
      const usuario = await client.users.fetch(discordId).catch(() => null);
      if (!usuario) continue;
      
      for (const jogo of jogos) {
        const info = await verificarDisponibilidadeJogo(jogo.appid);
        if (!info) continue;
        
        const deveNotificar = info.disponivel || info.preVenda;
        
        if (deveNotificar) {
          const hoje = new Date().toLocaleDateString('pt-BR');
          const chaveNotificacao = `lancamento_${discordId}_${jogo.appid}`;
          
          if (!db.jogosNotificados) db.jogosNotificados = {};
          if (!db.jogosNotificados[chaveNotificacao]) {
            db.jogosNotificados[chaveNotificacao] = {};
          }
          
          if (db.jogosNotificados[chaveNotificacao][hoje]) {
            continue;
          }
          
          try {
            const embed = new EmbedBuilder()
              .setColor(0x00FF00)
              .setTitle(`🎮 **${info.nome}** está disponível!`)
              .setURL(info.link)
              .setDescription(
                `📢 **${info.nome}** agora está disponível para compra na Steam!\n\n` +
                `${info.preVenda ? '🛒 **Pré-venda disponível!**' : '✅ **Jogo lançado!**'}\n` +
                `📅 Data de lançamento: ${info.dataLancamento}\n\n` +
                `🔗 **[Comprar na Steam](${info.link})**`
              )
              .setThumbnail(`https://cdn.cloudflare.steamstatic.com/steam/apps/${jogo.appid}/header.jpg`)
              .setFooter({ text: 'Steam Família - Lançamentos /quero' })
              .setTimestamp();
            
            await usuario.send({ embeds: [embed] });
            console.log(`✅ DM enviada para ${usuario.username}: ${info.nome} disponível!`);
            
            removerQuero(discordId, jogo.appid);
            
            db.jogosNotificados[chaveNotificacao][hoje] = true;
            salvarDB(db);
          } catch (error) {
            console.error(`❌ Erro ao enviar DM para ${usuario.username}:`, error.message);
          }
        }
      }
    }
  } catch (error) {
    console.error('❌ Erro ao verificar jogos não lançados:', error);
  }
}

// 🔹 ============================================
// 🔹 FUNÇÃO: verificarCompatibilidadeFamilia
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
    const response = await fetchWithTimeout(url, 5000);
    const data = await response.json();
    
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

// 🔹 ============================================
// 🔹 FUNÇÃO: contarDLCs
// 🔹 ============================================
async function contarDLCs(appid) {
  try {
    const url = `https://store.steampowered.com/api/appdetails?appids=${appid}&l=portuguese`;
    const response = await fetchWithTimeout(url, 5000);
    const data = await response.json();
    
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

// 🔹 ============================================
// 🔹 FUNÇÃO: formatarRespostaJogo
// 🔹 ============================================
function formatarRespostaJogo(jogo, donos, totalDLCs, compativel) {
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
      descricao += `\n`;
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
  
  return embed;
}

// 🔹 ============================================
// 🔹 FUNÇÃO: buscarSugestoesJogos
// 🔹 ============================================
async function buscarSugestoesJogos(termo) {
  try {
    if (!termo || termo.length === 0) {
      return [
        { name: 'Elden Ring', value: 'Elden Ring' },
        { name: 'Counter-Strike 2', value: 'Counter-Strike 2' },
        { name: 'Dying Light', value: 'Dying Light' },
        { name: 'Sonic Frontiers', value: 'Sonic Frontiers' },
        { name: 'Stardew Valley', value: 'Stardew Valley' },
        { name: 'Hollow Knight', value: 'Hollow Knight' },
        { name: 'Cyberpunk 2077', value: 'Cyberpunk 2077' },
        { name: 'Grand Theft Auto V', value: 'Grand Theft Auto V' },
        { name: 'Red Dead Redemption 2', value: 'Red Dead Redemption 2' },
        { name: 'The Witcher 3', value: 'The Witcher 3' }
      ];
    }

    const termoLower = termo.toLowerCase();
    const url = `https://store.steampowered.com/api/storesearch?term=${encodeURIComponent(termo)}&l=portuguese&cc=BR&max=50`;
    const response = await fetchWithTimeout(url, 3000);
    const data = await response.json();
    
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
// 🔹 FUNÇÃO: verificarConquistas (SEM RANKING)
// 🔹 ============================================
async function verificarConquistas(steamId, games, mention, userName) {
  if (!games?.length) return;

  const channelConquistas = client.channels.cache.get(CHANNEL_CONQUISTAS);
  if (!channelConquistas) return;

  if (!db.conquistas[steamId]) db.conquistas[steamId] = {};
  if (!db.jogosRecentes[steamId]) db.jogosRecentes[steamId] = [];

  const jogosRecentes = [];
  const agora = Math.floor(Date.now() / 1000);
  const ultimas24h = agora - (24 * 60 * 60);
  const ultimas72h = agora - (72 * 60 * 60);

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

    try {
      if (!db.jogosRecentes[steamId].includes(appid)) {
        db.jogosRecentes[steamId].push(appid);
        console.log(`📝 NOVO JOGO: ${gameName}`);
      }

      const conquistas = await getAchievements(steamId, appid);
      if (!conquistas?.length) {
        console.log(`   ⏭️ ${gameName} sem conquistas`);
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
      console.error(`   ❌ Erro em ${gameName}:`, error.message);
    }
  }

  if (!novasConquistas && primeiraVerificacaoConcluida) {
    console.log(`ℹ️ Nenhuma conquista nova para ${userName}`);
  }
}

// 🔹 ============================================
// 🔹 FUNÇÃO: gerarRanking
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
      } catch (e) {}
    }
    const novaMensagem = await channel.send({ embeds: [embedRanking] });
    ultimaMensagemRankingId = novaMensagem.id;
  } catch (error) {
    console.error('❌ Erro ao enviar ranking:', error);
  }
}

async function verificarSuporteFamilia(appid) {
  try {
    const url = `https://store.steampowered.com/app/${appid}`;
    const response = await fetchWithTimeout(url, 3000);
    const html = await response.text();

    const temCompartilhamento = html.includes('Compartilhamento em família') || html.includes('Family Sharing');
    const naoCompativel = html.includes('Compartilhamento em família não disponível') || html.includes('Family Sharing not available');

    if (temCompartilhamento && !naoCompativel) return true;
    if (naoCompativel) return false;
    return true;
  } catch (error) {
    return true;
  }
}

// 🔹 ============================================
// 🔹 FUNÇÃO: checkSteamGames (COM NOTIFICAÇÃO DE LISTA DE DESEJOS)
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

    for (const trimmedId of steamIds) {
      try {
        const url = `https://api.steampowered.com/IPlayerService/GetOwnedGames/v0001/?key=${apiKey}&steamid=${trimmedId}&include_appinfo=true&format=json`;
        const response = await fetchWithTimeout(url, 5000);
        const data = await response.json();

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
              
              await verificarListaDesejosComprados(appid, nome, trimmedId, userName);
              
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
      console.log('✅ SISTEMA INICIALIZADO! Conquistas salvas. Monitorando novas conquistas!');
      
      await verificarPromocoes();
    }

    const duracao = ((Date.now() - inicio) / 1000).toFixed(1);
    console.log(`✅ [${new Date().toLocaleTimeString()}] CONCLUÍDO em ${duracao}s`);

  } catch (error) {
    console.error('❌ Erro geral:', error);
  }
}

// 🔹 ============================================
// 🔹 FUNÇÃO: registrarComandos
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
        name: 'limparnotificados',
        description: '[DONO] Limpa a lista de jogos notificados hoje'
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
// 🔹 EVENTO: INTERACTION CREATE
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

  // 🔹 COMANDO /tem
  if (interaction.isChatInputCommand() && interaction.commandName === 'tem') {
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
      
      const embed = formatarRespostaJogo(jogo, donos, totalDLCs, compativel);
      
      await interaction.editReply({
        embeds: [embed]
      });
      
    } catch (error) {
      console.error('❌ Erro no comando /tem:', error);
      await interaction.editReply({
        content: `❌ Ocorreu um erro ao buscar o jogo. Tente novamente mais tarde.`
      });
    }
  }

  // 🔹 COMANDO /ranking
  if (interaction.isChatInputCommand() && interaction.commandName === 'ranking') {
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

  // 🔹 COMANDO /quero (ADICIONAR)
  if (interaction.isChatInputCommand() && interaction.commandName === 'quero') {
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
      
      const steamId = db.steamLinks?.[interaction.user.id];
      if (steamId) {
        const url = `https://api.steampowered.com/IPlayerService/GetOwnedGames/v0001/?key=${process.env.STEAM_KEY}&steamid=${steamId}&include_appinfo=true&format=json`;
        const response = await fetchWithTimeout(url, 5000);
        const data = await response.json();
        
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

  // 🔹 COMANDO /quero-listar
  if (interaction.isChatInputCommand() && interaction.commandName === 'quero-listar') {
    await interaction.deferReply({ ephemeral: true });
    
    try {
      const lista = listarQuero(interaction.user.id);
      
      if (lista.length === 0) {
        await interaction.editReply({
          content: '📭 Sua lista /quero está vazia. Use `/quero [nome do jogo]` para adicionar jogos.'
        });
        return;
      }
      
      let mensagem = `📋 **Sua lista /quero (${lista.length} jogos):**\n\n`;
      
      for (let i = 0; i < lista.length; i++) {
        const jogo = lista[i];
        const preco = await verificarPrecoJogo(jogo.appid);
        const disponivel = await verificarDisponibilidadeJogo(jogo.appid);
        let status = '⏳ Aguardando...';
        
        if (preco && preco.emPromocao) {
          status = '🟢 EM PROMOÇÃO!';
        } else if (disponivel && (disponivel.disponivel || disponivel.preVenda)) {
          status = '🟢 DISPONÍVEL!';
        }
        
        mensagem += `**${i + 1}.** ${jogo.nome}\n`;
        mensagem += `   🔗 ${jogo.link}\n`;
        mensagem += `   📊 Status: ${status}\n\n`;
      }
      
      if (mensagem.length > 1900) {
        mensagem = mensagem.substring(0, 1900) + '\n... (lista muito longa)';
      }
      
      await interaction.editReply({
        content: mensagem
      });
      
    } catch (error) {
      console.error('❌ Erro no comando /quero-listar:', error);
      await interaction.editReply({
        content: '❌ Ocorreu um erro ao listar os jogos.'
      });
    }
  }

  // 🔹 COMANDO /quero-remover
  if (interaction.isChatInputCommand() && interaction.commandName === 'quero-remover') {
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

  // 🔹 COMANDO /limparnotificados
  if (interaction.isChatInputCommand() && interaction.commandName === 'limparnotificados') {
    if (interaction.user.id !== TEST_DISCORD_ID) {
      await interaction.reply({
        content: '❌ Apenas o dono pode usar este comando.',
        ephemeral: true
      });
      return;
    }
    
    await interaction.deferReply({ ephemeral: true });
    
    try {
      const hoje = new Date().toLocaleDateString('pt-BR');
      if (db.jogosNotificados[TEST_STEAM_ID]) {
        db.jogosNotificados[TEST_STEAM_ID][hoje] = [];
        salvarDB(db);
        await interaction.editReply({
          content: '✅ Lista de jogos notificados hoje foi limpa!'
        });
      } else {
        await interaction.editReply({
          content: 'ℹ️ Nenhum jogo foi notificado hoje ainda.'
        });
      }
    } catch (error) {
      console.error('❌ Erro no comando /limparnotificados:', error);
      await interaction.editReply({
        content: '❌ Ocorreu um erro ao limpar a lista.'
      });
    }
  }
});

// 🔹 ============================================
// 🔹 COMANDOS NO CHAT
// 🔹 ============================================
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
      await enviarRanking();
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
// 🔹 EVENTO: DESLIGAMENTO
// 🔹 ============================================
process.on('SIGINT', async () => {
  console.log('⚠️ Bot sendo desligado...');
  try {
    const dono = await client.users.fetch(DONO_ID);
    if (dono) {
      await dono.send('🛑 **Bot Steam Família foi desligado!**');
    }
  } catch (error) {
    console.error('❌ Erro ao enviar DM:', error);
  }
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('⚠️ Bot sendo encerrado...');
  try {
    const dono = await client.users.fetch(DONO_ID);
    if (dono) {
      await dono.send('🛑 **Bot Steam Família foi encerrado!**');
    }
  } catch (error) {
    console.error('❌ Erro ao enviar DM:', error);
  }
  process.exit(0);
});

// 🔹 ============================================
// 🔹 READY
// 🔹 ============================================
client.once('ready', async () => {
  console.log(`✅ Bot online como ${client.user.tag}`);
  console.log(`📡 Conectado em ${client.guilds.cache.size} servidor(es)`);

  await registrarComandos();

  console.log(`⏰ Intervalo: ${INTERVALO_VERIFICACAO / 1000} segundos`);
  console.log(`💾 Banco de dados: ${DB_FILE}`);

  try {
    const dono = await client.users.fetch(DONO_ID);
    if (dono) {
      await dono.send(`🚀 **Bot Steam Família está online!**\n⏰ Verificando a cada ${INTERVALO_VERIFICACAO / 1000} segundos\n🔍 Monitorando jogos e conquistas\n📊 Digite /ranking\n🔎 Use /tem [jogo]\n🛒 Use /quero [jogo] para ser notificado de promoções e lançamentos!`);
    }
  } catch (error) {
    console.error('❌ Erro ao enviar DM para o dono:', error);
  }

  console.log(`🏆 SISTEMA DE CONQUISTAS ATIVADO! Verificando a cada ${INTERVALO_VERIFICACAO / 1000} segundos`);

  console.log('🎮 Iniciando verificação inicial...');
  await checkSteamGames();

  console.log(`🔄 Iniciando monitoramento contínuo (${INTERVALO_VERIFICACAO / 1000}s)...`);

  setInterval(async () => {
    try {
      await checkSteamGames();
      await verificarPromocoes();
      await verificarPromocoesQuero();
      await verificarJogosCompradosQuero();
      await verificarJogosCompradosFamiliaQuero();
      await verificarJogosNaoLancadosQuero();
    } catch (error) {
      console.error('❌ Erro no intervalo:', error);
    }
  }, INTERVALO_VERIFICACAO);
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

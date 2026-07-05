require('dotenv').config();
const fs = require('fs');
const path = require('path');

const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');

// 🔹 CONFIGURAÇÕES OTIMIZADAS
const INTERVALO_VERIFICACAO = 15 * 1000; // 15 segundos
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

// 🔹 Arquivo do banco de dados
const DB_FILE = path.join(__dirname, 'steam_achievements_db.json');

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
// 🔹 BANCO DE DADOS (COM RANKING PERSISTENTE)
// 🔹 ============================================

function carregarDB() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const data = fs.readFileSync(DB_FILE, 'utf8');
      const parsed = JSON.parse(data);
      if (!parsed.ranking) parsed.ranking = {};
      if (!parsed.conquistas) parsed.conquistas = {};
      if (!parsed.jogosRecentes) parsed.jogosRecentes = {};
      return parsed;
    }
  } catch (error) {
    console.error('❌ Erro ao carregar banco:', error);
  }
  return { conquistas: {}, jogosRecentes: {}, ranking: {} };
}

function salvarDB(db) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
    console.log('💾 Banco de dados salvo!');
  } catch (error) {
    console.error('❌ Erro ao salvar banco:', error);
  }
}

// 🔹 Inicializar banco de dados
let db = carregarDB();
if (!db.conquistas) db.conquistas = {};
if (!db.jogosRecentes) db.jogosRecentes = {};
if (!db.ranking) db.ranking = {};

// 🔹 ============================================
// 🔹 RANKING (COM PERSISTÊNCIA)
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
  } else {
    console.log('📊 Nenhum ranking salvo encontrado. Usando valores padrão...');
    ranking = JSON.parse(JSON.stringify(rankingPadrao));
    db.ranking = ranking;
    salvarDB(db);
  }
}

carregarRanking();

// 🔹 Estruturas de dados
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

// 🔹 ============================================
// 🔹 FUNÇÃO: extrairAppIdDaUrl
// 🔹 ============================================
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

// 🔹 ============================================
// 🔹 FUNÇÃO: buscarJogoPorAppId
// 🔹 ============================================
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

// 🔹 ============================================
// 🔹 FUNÇÃO: buscarJogoSteam
// 🔹 ============================================
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
// 🔹 FUNÇÃO: buscarDLCsCompletas
// 🔹 ============================================
async function buscarDLCsCompletas(appid) {
  try {
    const url = `https://store.steampowered.com/api/appdetails?appids=${appid}&l=portuguese`;
    const response = await fetchWithTimeout(url, 5000);
    const data = await response.json();
    
    if (!data[appid]?.success) {
      console.log(`⚠️ Jogo ${appid} não encontrado`);
      return [];
    }
    
    const gameData = data[appid].data;
    
    if (!gameData.dlc || gameData.dlc.length === 0) {
      console.log(`ℹ️ ${gameData.name} não possui DLCs`);
      return [];
    }
    
    console.log(`📦 ${gameData.name} possui ${gameData.dlc.length} DLC(s)`);
    
    const dlcsCompletas = [];
    for (const dlcAppid of gameData.dlc) {
      try {
        const dlcUrl = `https://store.steampowered.com/api/appdetails?appids=${dlcAppid}&l=portuguese`;
        const dlcResponse = await fetchWithTimeout(dlcUrl, 3000);
        const dlcData = await dlcResponse.json();
        
        if (dlcData[dlcAppid]?.success) {
          const dlcInfo = dlcData[dlcAppid].data;
          dlcsCompletas.push({
            appid: dlcAppid,
            nome: dlcInfo.name || `DLC ${dlcAppid}`,
            capa: dlcInfo.header_image || dlcInfo.capsule_image || `https://cdn.cloudflare.steamstatic.com/steam/apps/${dlcAppid}/header.jpg`
          });
          console.log(`   ✅ DLC: ${dlcInfo.name}`);
        }
      } catch (error) {
        console.error(`   ❌ Erro na DLC ${dlcAppid}:`, error.message);
      }
    }
    
    return dlcsCompletas;
  } catch (error) {
    console.error(`❌ Erro ao buscar DLCs:`, error.message);
    return [];
  }
}

// 🔹 ============================================
// 🔹 FUNÇÃO: verificarJogoFamilia
// 🔹 ============================================
async function verificarJogoFamilia(appid) {
  const resultados = [];
  const steamIds = process.env.STEAM_IDS.split(',').map(id => id.trim());
  const apiKey = process.env.STEAM_KEY;
  
  const todasDLCs = await buscarDLCsCompletas(appid);
  console.log(`📦 Total de DLCs: ${todasDLCs.length}`);
  
  for (const steamId of steamIds) {
    try {
      const url = `https://api.steampowered.com/IPlayerService/GetOwnedGames/v0001/?key=${apiKey}&steamid=${steamId}&include_appinfo=true&include_played_free_games=true&format=json`;
      const response = await fetchWithTimeout(url, 5000);
      const data = await response.json();
      
      if (data.response?.games) {
        const jogo = data.response.games.find(g => g.appid === appid);
        
        if (jogo) {
          const userName = steamNames[steamId] || `Usuário ${steamId.substring(0, 8)}`;
          const discordId = discordUsers[steamId];
          
          const dlcsDoUsuario = [];
          if (todasDLCs.length > 0) {
            for (const dlc of todasDLCs) {
              const temDlc = data.response.games.some(g => g.appid === dlc.appid);
              if (temDlc) {
                dlcsDoUsuario.push(dlc);
                console.log(`   ✅ ${userName} tem: ${dlc.nome}`);
              }
            }
          }
          
          resultados.push({
            nome: userName,
            discordId: discordId,
            steamId: steamId,
            dlcs: dlcsDoUsuario,
            totalDlcs: dlcsDoUsuario.length
          });
        }
      }
    } catch (error) {
      console.error(`❌ Erro ao verificar ${steamId}:`, error.message);
    }
  }
  
  return resultados;
}

// 🔹 ============================================
// 🔹 FUNÇÃO: formatarRespostaJogo
// 🔹 ============================================
function formatarRespostaJogo(jogo, donos) {
  const embed = new EmbedBuilder()
    .setColor(donos.length > 0 ? 0x00FF00 : 0xFF0000)
    .setTitle(`${donos.length > 0 ? '✅' : '❌'} ${jogo.nome}`)
    .setURL(jogo.url)
    .setFooter({ text: 'Steam Família - Consulta' })
    .setTimestamp();

  if (jogo.capa) {
    embed.setThumbnail(jogo.capa);
  }
  
  if (donos.length > 0) {
    let descricao = `🎮 **Encontrado na família!**\n👤 **${donos.length} membro(s) possui(em):**\n\n`;
    
    donos.forEach((dono, index) => {
      const mencao = dono.discordId ? `<@${dono.discordId}>` : dono.nome;
      descricao += `**${index + 1}. ${mencao}**\n`;
      
      if (dono.totalDlcs > 0) {
        descricao += `   📦 DLCs (${dono.totalDlcs}):\n`;
        const dlcsMostrar = dono.dlcs.slice(0, 5);
        dlcsMostrar.forEach(dlc => {
          descricao += `      • ${dlc.nome}\n`;
        });
        if (dono.dlcs.length > 5) {
          descricao += `      • + ${dono.dlcs.length - 5} DLC(s) mais\n`;
        }
      } else {
        descricao += `   📦 Nenhuma DLC\n`;
      }
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
// 🔹 FUNÇÃO: buscarSugestoesJogos (NOVA)
// 🔹 ============================================
async function buscarSugestoesJogos(termo) {
  try {
    if (!termo || termo.length < 2) {
      return [
        { name: 'Elden Ring', value: 'Elden Ring' },
        { name: 'Counter-Strike 2', value: 'Counter-Strike 2' },
        { name: 'Dying Light', value: 'Dying Light' },
        { name: 'Sonic Frontiers', value: 'Sonic Frontiers' },
        { name: 'Stardew Valley', value: 'Stardew Valley' }
      ];
    }

    const url = `https://store.steampowered.com/api/storesearch?term=${encodeURIComponent(termo)}&l=portuguese&cc=BR`;
    const response = await fetchWithTimeout(url, 3000);
    const data = await response.json();
    
    if (data.items && data.items.length > 0) {
      const jogos = data.items
        .filter(item => item.type === 'game')
        .slice(0, 10)
        .map(item => ({
          name: item.name,
          value: item.name
        }));
      
      return jogos;
    }
    
    return [];
  } catch (error) {
    console.error('❌ Erro ao buscar sugestões:', error);
    return [];
  }
}

// 🔹 ============================================
// 🔹 FUNÇÃO: verificarConquistas
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
      if (!conquistas?.length) continue;

      const desbloqueadas = conquistas.filter(c => c.achieved === 1);
      const total = desbloqueadas.length;

      if (!db.conquistas[steamId][appid] || !primeiraVerificacaoConcluida) {
        db.conquistas[steamId][appid] = {
          total: total,
          nomes: desbloqueadas.map(c => c.apiname)
        };
        continue;
      }

      const dadosSalvos = db.conquistas[steamId][appid];
      const totalAntigo = dadosSalvos.total || 0;

      if (total > totalAntigo) {
        const nomesAntigos = dadosSalvos.nomes || [];
        const novas = desbloqueadas.filter(c => !nomesAntigos.includes(c.apiname));

        if (novas.length) {
          novasConquistas += novas.length;
          console.log(`🎮 ${userName} +${novas.length} conquista(s) em ${gameName}!`);

          const gameInfo = await getGameDetails(appid);

          for (const conquista of novas.slice(0, MAX_CONQUISTAS_POR_JOGO)) {
            const nomeConquista = await getAchievementName(steamId, appid, conquista.apiname);
            const embed = new EmbedBuilder()
              .setColor(0xFFD700)
              .setTitle(`🏆 ${userName} desbloqueou uma conquista!`)
              .setDescription(`**${nomeConquista}**`)
              .setThumbnail(gameInfo.icon)
              .addFields(
                { name: '🎮 Jogo', value: gameName, inline: true },
                { name: '👤 Jogador', value: mention, inline: true },
                { name: '📅 Data', value: new Date().toLocaleDateString('pt-BR'), inline: true }
              )
              .setTimestamp();

            await channelConquistas.send({
              content: `🎉 **NOVA CONQUISTA!**`,
              embeds: [embed]
            });
          }

          db.conquistas[steamId][appid] = {
            total: total,
            nomes: desbloqueadas.map(c => c.apiname)
          };
          await enviarRanking();
          salvarDB(db);
        }
      }
    } catch (error) {
      console.error(`❌ Erro em ${gameName}:`, error.message);
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

// 🔹 ============================================
// 🔹 FUNÇÃO: enviarRanking (COM SALVAMENTO)
// 🔹 ============================================
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

// 🔹 ============================================
// 🔹 FUNÇÃO: verificarSuporteFamilia
// 🔹 ============================================
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
// 🔹 FUNÇÃO: checkSteamGames (PRINCIPAL)
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
              const link = `https://store.steampowered.com/app/${game.appid}`;
              const isCompatible = await verificarSuporteFamilia(game.appid);
              if (isCompatible) {
                await channelNotificacoes.send(
                  `@everyone 🎉 ${mention} comprou o jogo: **${game.name}**\n🔗 ${link}\n✅ **Compatível com Família Steam!**`
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
      try {
        const channelConquistas = client.channels.cache.get(CHANNEL_CONQUISTAS);
        if (channelConquistas) {
          await channelConquistas.send('✅ **SISTEMA INICIALIZADO!**\n📊 Conquistas salvas\n🔍 Monitorando novas conquistas!');
        }
      } catch (e) {}
    }

    const duracao = ((Date.now() - inicio) / 1000).toFixed(1);
    console.log(`✅ [${new Date().toLocaleTimeString()}] CONCLUÍDO em ${duracao}s`);

  } catch (error) {
    console.error('❌ Erro geral:', error);
  }
}

// 🔹 ============================================
// 🔹 FUNÇÃO: registrarComandos (COM AUTOCOMPLETE)
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
      }
    ];

    const guild = client.guilds.cache.first();
    if (guild) {
      await guild.commands.set(commands);
      console.log(`✅ /tem registrado no servidor: ${guild.name}`);
    } else {
      await client.application.commands.set(commands);
      console.log('✅ /tem registrado globalmente');
    }
  } catch (error) {
    console.error('❌ Erro ao registrar /tem:', error);
  }
}

// 🔹 ============================================
// 🔹 EVENTO: INTERACTION CREATE (COM AUTOCOMPLETE)
// 🔹 ============================================
client.on('interactionCreate', async (interaction) => {
  // 🔹 AUTOCOMPLETE
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
      const embed = formatarRespostaJogo(jogo, donos);
      
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
});

// 🔹 ============================================
// 🔹 COMANDOS NO CHAT
// 🔹 ============================================
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  
  if (message.content.toLowerCase() === '!ranking' || message.content.toLowerCase() === '!rank') {
    await enviarRanking();
  }
  
  if (message.content.toLowerCase() === '!resetranking') {
    if (message.author.id !== 'SEU_ID_DISCORD_AQUI') {
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
// 🔹 READY
// 🔹 ============================================
client.once('ready', async () => {
  console.log(`✅ Bot online como ${client.user.tag}`);
  console.log(`📡 Conectado em ${client.guilds.cache.size} servidor(es)`);

  await registrarComandos();

  console.log(`⏰ Intervalo: ${INTERVALO_VERIFICACAO / 1000} segundos`);
  console.log(`💾 Banco de dados: ${DB_FILE}`);

  const channelNotificacoes = client.channels.cache.get(CHANNEL_NOTIFICACOES);
  if (channelNotificacoes) {
    await channelNotificacoes.send(`🚀 **Bot Steam Família está online!**\n⏰ Verificando a cada ${INTERVALO_VERIFICACAO / 1000} segundos\n🔍 Monitorando jogos e conquistas\n📊 Digite !ranking\n🔎 Use /tem [jogo] - com sugestões automáticas!`);
  }

  const channelConquistas = client.channels.cache.get(CHANNEL_CONQUISTAS);
  if (channelConquistas) {
    await channelConquistas.send(`🏆 **SISTEMA DE CONQUISTAS ATIVADO!**\n⏰ Verificando a cada ${INTERVALO_VERIFICACAO / 1000} segundos\n📝 Salvando conquistas existentes...`);
  }

  console.log('🎮 Iniciando verificação inicial...');
  await checkSteamGames();

  console.log(`🔄 Iniciando monitoramento contínuo (${INTERVALO_VERIFICACAO / 1000}s)...`);

  setInterval(() => {
    console.log(`💚 [${new Date().toLocaleTimeString()}] Bot saudável - ${client.ws.ping}ms`);
  }, 30000);

  setInterval(async () => {
    try {
      await checkSteamGames();
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

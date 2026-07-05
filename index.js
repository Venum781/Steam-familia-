require('dotenv').config();
const fs = require('fs');
const path = require('path');

const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');

// 🔹 CONFIGURAÇÕES OTIMIZADAS
const INTERVALO_VERIFICACAO = 15 * 1000; // 15 segundos
const MAX_JOGOS_POR_USUARIO = 8; // Limita a 8 jogos por usuário para ser mais rápido
const MAX_CONQUISTAS_POR_JOGO = 30; // Limita a 30 conquistas por jogo

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

// 🔹 Ranking inicial
let ranking = {
  "76561198127320557": { nome: "Gardemi", jogos: 98, steamId: "76561198127320557", discordId: "663789211152941065" },
  "76561197967265286": { nome: "Marlon", jogos: 56, steamId: "76561197967265286", discordId: "1022183877114069083" },
  "76561198848231901": { nome: "Mosk", jogos: 15, steamId: "76561198848231901", discordId: "499311499504910344" },
  "76561198446717315": { nome: "WoollySkills", jogos: 11, steamId: "76561198446717315", discordId: "479817686218702849" },
  "76561198110004039": { nome: "Venum", jogos: 8, steamId: "76561198110004039", discordId: "336204841972137995" }
};

// 🔹 Estruturas de dados
let previousGames = {};
let ultimaMensagemRankingId = null;
let primeiraVerificacaoConcluida = false;

// 🔹 Caches
const gameNameCache = {};
const achievementNameCache = {};

// 🔹 Carregar banco de dados
function carregarDB() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const data = fs.readFileSync(DB_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (error) {
    console.error('❌ Erro ao carregar banco:', error);
  }
  return { conquistas: {}, jogosRecentes: {} };
}

function salvarDB(db) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
  } catch (error) {
    console.error('❌ Erro ao salvar banco:', error);
  }
}

let db = carregarDB();
if (!db.conquistas) db.conquistas = {};
if (!db.jogosRecentes) db.jogosRecentes = {};

// 🔹 Função com timeout para evitar travamentos
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

// 🔹 Buscar detalhes do jogo (com cache)
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

// 🔹 Buscar nome da conquista (com cache)
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

// 🔹 Buscar conquistas (com timeout)
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

// 🔹 Buscar jogo atual (com timeout)
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

// 🔹 Função principal de verificação (OTIMIZADA)
async function verificarConquistas(steamId, games, mention, userName) {
  if (!games?.length) return;

  const channelConquistas = client.channels.cache.get(CHANNEL_CONQUISTAS);
  if (!channelConquistas) return;

  if (!db.conquistas[steamId]) db.conquistas[steamId] = {};
  if (!db.jogosRecentes[steamId]) db.jogosRecentes[steamId] = [];

  // 🔹 DETECÇÃO RÁPIDA DE JOGOS RECENTES
  const jogosRecentes = [];
  const agora = Math.floor(Date.now() / 1000);

  // 1. Jogo atual (prioridade máxima)
  const jogoAtual = await getCurrentGame(steamId);
  if (jogoAtual) {
    const jogo = games.find(g => g.appid === jogoAtual.gameid);
    if (jogo && !jogosRecentes.find(g => g.appid === jogo.appid)) {
      jogosRecentes.push(jogo);
      console.log(`🎮 ${userName} está JOGANDO: ${jogoAtual.gameextrainfo}`);
    }
  }

  // 2. Últimos jogos com rtime_last_played (ordenados)
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

  // 3. Histórico (aprendizado)
  if (jogosRecentes.length < 3) {
    for (const appid of db.jogosRecentes[steamId].slice(-5)) {
      const jogo = games.find(g => g.appid === appid);
      if (jogo && !jogosRecentes.find(g => g.appid === appid)) {
        jogosRecentes.push(jogo);
      }
    }
  }

  // 🔹 Limita para ser rápido
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
      // 🔹 Aprende jogos novos
      if (!db.jogosRecentes[steamId].includes(appid)) {
        db.jogosRecentes[steamId].push(appid);
        console.log(`📝 NOVO JOGO: ${gameName}`);
      }

      const conquistas = await getAchievements(steamId, appid);
      if (!conquistas?.length) continue;

      const desbloqueadas = conquistas.filter(c => c.achieved === 1);
      const total = desbloqueadas.length;

      // 🔹 Primeira verificação ou jogo novo
      if (!db.conquistas[steamId][appid] || !primeiraVerificacaoConcluida) {
        db.conquistas[steamId][appid] = {
          total: total,
          nomes: desbloqueadas.map(c => c.apiname)
        };
        continue;
      }

      // 🔹 Comparação rápida
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
              content: `@everyone 🎉 **NOVA CONQUISTA!**`,
              embeds: [embed]
            });

            if (ranking[steamId]) ranking[steamId].jogos += 0.1;
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

// 🔹 Funções de ranking (otimizadas)
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
    description += `${posicao} **${mencao}** — ${user.jogos} jogos\n`;
  });

  embed.setDescription(description);
  return embed;
}

async function enviarRanking() {
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

// 🔹 Função de suporte familiar (com timeout)
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

// 🔹 Função principal (OTIMIZADA)
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

        // 🔹 Verifica conquistas
        await verificarConquistas(trimmedId, currentGames, mention, userName);

        // 🔹 Verifica novos jogos
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

// 🔹 Comandos
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (message.content.toLowerCase() === '!ranking' || message.content.toLowerCase() === '!rank') {
    await enviarRanking();
  }
  if (message.content.toLowerCase() === '!reset') {
    if (message.author.id !== 'SEU_ID_DISCORD_AQUI') {
      await message.reply('❌ Sem permissão!');
      return;
    }
    try {
      if (fs.existsSync(DB_FILE)) {
        fs.unlinkSync(DB_FILE);
        await message.reply('✅ Banco de dados resetado! Reinicie o bot.');
      }
    } catch (error) {
      await message.reply('❌ Erro ao resetar.');
    }
  }
});

// 🔹 READY
client.once('ready', async () => {
  console.log(`✅ Bot online como ${client.user.tag}`);
  console.log(`📡 Conectado em ${client.guilds.cache.size} servidor(es)`);
  console.log(`⏰ Intervalo: ${INTERVALO_VERIFICACAO / 1000} segundos`);
  console.log(`📝 Máximo de jogos por usuário: ${MAX_JOGOS_POR_USUARIO}`);

  const channelNotificacoes = client.channels.cache.get(CHANNEL_NOTIFICACOES);
  if (channelNotificacoes) {
    await channelNotificacoes.send(`🚀 **Bot Steam Família está online!**\n⏰ Verificando a cada ${INTERVALO_VERIFICACAO / 1000} segundos\n🔍 Monitorando jogos e conquistas\n📊 Digite !ranking`);
  }

  const channelConquistas = client.channels.cache.get(CHANNEL_CONQUISTAS);
  if (channelConquistas) {
    await channelConquistas.send(`🏆 **SISTEMA DE CONQUISTAS ATIVADO!**\n⏰ Verificando a cada ${INTERVALO_VERIFICACAO / 1000} segundos\n📝 Salvando conquistas existentes...`);
  }

  console.log('🎮 Iniciando verificação inicial...');
  await checkSteamGames();

  console.log(`🔄 Iniciando monitoramento contínuo (${INTERVALO_VERIFICACAO / 1000}s)...`);

  // 🔹 Monitor de saúde
  setInterval(() => {
    console.log(`💚 [${new Date().toLocaleTimeString()}] Bot saudável - ${client.ws.ping}ms`);
  }, 30000);

  // 🔹 Loop principal
  setInterval(async () => {
    try {
      await checkSteamGames();
    } catch (error) {
      console.error('❌ Erro no intervalo:', error);
    }
  }, INTERVALO_VERIFICACAO);
});

// 🔹 LOGIN
client.login(process.env.DISCORD_TOKEN)
  .then(() => console.log('🔑 Login realizado com sucesso'))
  .catch(error => {
    console.error('❌ Erro ao fazer login:', error);
    process.exit(1);
  });
// ============================================================
// BOT STEAM FAMÍLIA - VERSÃO FINAL COMPLETA
// ============================================================

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const http = require('http');
const axios = require('axios');
const { Client, GatewayIntentBits, EmbedBuilder, REST, Routes } = require('discord.js');

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
  DATA_DIR = '/data',
  PORT = 3000
} = process.env;

if (!DISCORD_TOKEN || !STEAM_KEY || !STEAM_IDS || !CHANNEL_ID) {
  console.error('❌ Variáveis obrigatórias ausentes:');
  console.error('  DISCORD_TOKEN, STEAM_KEY, STEAM_IDS, CHANNEL_ID');
  process.exit(1);
}

const STEAM_IDS_ARRAY = STEAM_IDS.split(',').map(id => id.trim());

// ============================================================
// 2. MAPEAMENTO DOS MEMBROS
// ============================================================
const MEMBROS = {
  '76561198127320557': { nome: 'Gardemi', discordId: '663789211152941065' },
  '76561197967265286': { nome: 'Marlon', discordId: '1022183877114069083' },
  '76561198446717315': { nome: 'WoollySkills', discordId: '479817686218702849' },
  '76561198110004039': { nome: 'Venum', discordId: '336204841972137995' },
  '76561198848231901': { nome: 'Mosk', discordId: '499311499504910344' }
};

// ============================================================
// 3. BANCO DE DADOS PERSISTENTE
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
  return {
    ranking: {},
    conquistas: {},
    listaQuero: {},
    historicoJogos: {},
    ultimaMensagemRankingId: null,
    lancamentosNotificados: {}
  };
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

let db = carregarDB();

if (!db.ranking || Object.keys(db.ranking).length === 0) {
  console.log('📊 Inicializando ranking...');
  db.ranking = {};
  for (const [steamId, info] of Object.entries(MEMBROS)) {
    db.ranking[steamId] = {
      nome: info.nome,
      jogos: 0,
      steamId,
      discordId: info.discordId
    };
  }
  salvarDB(db);
}

// ============================================================
// 4. FUNÇÕES DA STEAM API
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

// 🔥 FUNÇÃO PARA VERIFICAR COMPATIBILIDADE COM FAMILY SHARING
async function verificarCompatibilidadeFamilia(appId) {
  try {
    const url = `https://store.steampowered.com/api/appdetails?appids=${appId}&l=portuguese`;
    const resp = await axios.get(url, { timeout: 10000 });
    if (resp.data && resp.data[appId]?.success) {
      const game = resp.data[appId].data;
      
      if (game.is_free) {
        return { compatível: false, motivo: 'Jogo gratuito não requer Family Sharing' };
      }
      
      if (game.exclude_from_family_sharing === true) {
        return { compatível: false, motivo: 'Este jogo NÃO é compatível com Family Sharing' };
      }
      
      if (!game.price_overview) {
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

// ============================================================
// 5. FUNÇÕES DE NEGÓCIO (lista /quero)
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

// ============================================================
// 6. CLIENT DISCORD
// ============================================================
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
// 7. RANKING
// ============================================================
function gerarRankingEmbed() {
  const rankingArray = Object.values(db.ranking || {}).sort((a, b) => b.jogos - a.jogos);
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

// ============================================================
// 8. VERIFICAÇÃO DE CONQUISTAS
// ============================================================
async function verificarConquistas(steamId, games, mention, userName) {
  if (!games?.length) return;
  const channel = client.channels.cache.get(ACHIEVEMENT_CHANNEL_ID);
  if (!channel) return;

  if (!db.conquistas[steamId]) db.conquistas[steamId] = {};

  const recentes = games
    .filter(g => g.rtime_last_played > 0)
    .sort((a, b) => b.rtime_last_played - a.rtime_last_played)
    .slice(0, 3);

  for (const game of recentes) {
    const appid = game.appid;
    const gameName = game.name || `Jogo ${appid}`;

    let conquistas;
    try {
      conquistas = await getPlayerAchievements(steamId, appid);
    } catch (_) {
      continue;
    }
    if (!conquistas || conquistas.length === 0) continue;

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
      const nomeBonito = await getAchievementDisplayName(appid, ach.apiname);
      const embed = new EmbedBuilder()
        .setColor(0xFFD700)
        .setTitle(`🏆 ${userName} desbloqueou uma conquista!`)
        .setDescription(`**${nomeBonito}**`)
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
// 9. VERIFICAÇÃO DE LANÇAMENTOS
// ============================================================
async function verificarLancamentosQuero() {
  console.log(`🔄 [${new Date().toLocaleTimeString()}] Verificando lançamentos...`);

  for (const [discordId, jogos] of Object.entries(db.listaQuero || {})) {
    if (!jogos || jogos.length === 0) continue;

    let usuario;
    try {
      usuario = await client.users.fetch(discordId);
    } catch (_) {
      console.warn(`⚠️ Não foi possível buscar o usuário ${discordId}`);
      continue;
    }

    for (const jogo of jogos) {
      const chave = `${discordId}_${jogo.appid}`;
      if (db.lancamentosNotificados?.[chave]) continue;
      if (jogo.coming_soon === false) continue;

      const detalhes = await getGameDetails(jogo.appid);
      if (!detalhes) continue;

      const isComingSoon = detalhes.release_date?.coming_soon;
      const hasPrice = !!detalhes.price_overview;
      const isAvailable = (isComingSoon === false) && hasPrice;

      if (jogo.coming_soon === true && isAvailable) {
        console.log(`🎉 ${usuario.username} - ${jogo.nome} FOI LANÇADO!`);

        const embed = new EmbedBuilder()
          .setColor(0x00FF00)
          .setTitle(`🎮 ${jogo.nome} FOI LANÇADO!`)
          .setURL(jogo.link)
          .setThumbnail(`https://cdn.cloudflare.steamstatic.com/steam/apps/${jogo.appid}/header.jpg`)
          .addFields(
            { name: '💰 Preço', value: detalhes.price_overview?.final_formatted || 'Ver na loja', inline: true },
            { name: '🔗 Link', value: `[Comprar na Steam](${jogo.link})`, inline: false }
          )
          .setFooter({ text: 'Steam Família - Lançamentos /quero' })
          .setTimestamp();

        try {
          await usuario.send({ embeds: [embed] });
          console.log(`✅ DM de lançamento enviada para ${usuario.username}: ${jogo.nome}`);
          if (!db.lancamentosNotificados) db.lancamentosNotificados = {};
          db.lancamentosNotificados[chave] = Date.now();
          jogo.coming_soon = false;
          salvarDB(db);
          await new Promise(r => setTimeout(r, 1000));
        } catch (err) {
          console.error(`❌ Erro ao enviar DM para ${usuario.username}:`, err.message);
        }
      }
    }
  }
}

// ============================================================
// 10. VERIFICAÇÃO DE PROMOÇÕES COM DETECÇÃO DE MUDANÇA DE ESTADO
// ============================================================
async function verificarPromocoesQuero() {
  console.log(`🔄 [${new Date().toLocaleTimeString()}] Verificando promoções...`);

  for (const [discordId, jogos] of Object.entries(db.listaQuero || {})) {
    if (!jogos || jogos.length === 0) continue;

    let usuario;
    try {
      usuario = await client.users.fetch(discordId);
    } catch (_) {
      console.warn(`⚠️ Não foi possível buscar o usuário ${discordId}`);
      continue;
    }

    for (const jogo of jogos) {
      const preco = await getPriceOverview(jogo.appid);
      if (!preco) continue;

      const estaEmPromocao = preco.emPromocao && preco.desconto > 0;
      const estadoAnterior = jogo.ultimoEstadoPromocao;

      if (estaEmPromocao && (estadoAnterior === false || estadoAnterior === null)) {
        console.log(`🎉 ${usuario.username} - ${jogo.nome} ENTROU EM PROMOÇÃO! (${preco.desconto}% OFF)`);

        const embed = new EmbedBuilder()
          .setColor(0x00FF00)
          .setTitle(`🎉 ${jogo.nome} está em promoção!`)
          .setURL(jogo.link)
          .setThumbnail(`https://cdn.cloudflare.steamstatic.com/steam/apps/${jogo.appid}/header.jpg`)
          .addFields(
            { name: '💰 Preço antigo', value: `~~${preco.precoAntigo}~~`, inline: true },
            { name: '💰 Preço atual', value: `**${preco.precoAtual}**`, inline: true },
            { name: '📉 Desconto', value: `**${preco.desconto}% OFF**`, inline: true },
            { name: '🔗 Link', value: `[Comprar na Steam](${preco.link})`, inline: false }
          )
          .setFooter({ text: 'Steam Família - Promoções /quero' })
          .setTimestamp();

        try {
          await usuario.send({ embeds: [embed] });
          console.log(`✅ DM de promoção enviada para ${usuario.username}: ${jogo.nome}`);
        } catch (err) {
          console.error(`❌ Erro ao enviar DM para ${usuario.username}:`, err.message);
        }

        jogo.ultimoEstadoPromocao = true;
        salvarDB(db);
        await new Promise(r => setTimeout(r, 1000));

      } else if (!estaEmPromocao && estadoAnterior === true) {
        console.log(`📉 ${usuario.username} - ${jogo.nome} saiu da promoção.`);
        jogo.ultimoEstadoPromocao = false;
        salvarDB(db);

      } else if (estadoAnterior === null) {
        console.log(`📊 ${usuario.username} - ${jogo.nome}: estado inicial = ${estaEmPromocao ? 'em promoção' : 'não em promoção'}`);
        jogo.ultimoEstadoPromocao = estaEmPromocao;
        salvarDB(db);
      }
    }
  }
}

// ============================================================
// 11. VERIFICAÇÃO DE NOVOS JOGOS (COM @everyone E COMPATIBILIDADE)
// ============================================================
async function checkSteamGames() {
  const inicio = Date.now();
  console.log(`🔄 [${new Date().toLocaleTimeString()}] Verificando...`);

  const channelNotificacoes = client.channels.cache.get(CHANNEL_ID);
  if (!channelNotificacoes) {
    console.error('❌ Canal de notificações não encontrado!');
    return;
  }

  for (const steamId of STEAM_IDS_ARRAY) {
    try {
      const games = await getOwnedGames(steamId);
      if (!games.length) continue;

      const currentGames = games.map(g => ({ name: g.name, appid: g.appid, rtime_last_played: g.rtime_last_played || 0 }));
      const member = MEMBROS[steamId];
      if (!member) {
        console.warn(`⚠️ Steam ID ${steamId} não mapeado`);
        continue;
      }
      const userName = member.nome;
      const discordId = member.discordId;
      const mention = `<@${discordId}>`;

      await verificarConquistas(steamId, currentGames, mention, userName);

      if (!previousGames[steamId]) {
        previousGames[steamId] = currentGames;
        console.log(`📊 ${userName}: ${currentGames.length} jogos (histórico inicial salvo)`);
        db.historicoJogos[steamId] = currentGames.map(g => g.appid);
        salvarDB(db);
        continue;
      }

      const oldIds = previousGames[steamId].map(g => g.appid);
      const newGames = currentGames.filter(g => !oldIds.includes(g.appid));

      if (newGames.length) {
        console.log(`🎮 ${userName} +${newGames.length} novo(s) jogo(s)!`);

        for (const game of newGames) {
          const appid = game.appid;
          const nome = game.name || `App ${appid}`;
          const link = `https://store.steampowered.com/app/${appid}`;

          // 🔥 VERIFICA COMPATIBILIDADE
          const compat = await verificarCompatibilidadeFamilia(appid);

          // 🔥 SÓ ANUNCIA SE FOR COMPATÍVEL
          if (compat.compatível) {
            const embed = new EmbedBuilder()
              .setColor(0x00FF00)
              .setTitle(`🛒 NOVO JOGO NA FAMÍLIA!`)
              .setDescription(`**${userName}** agora tem acesso a **${nome}**!`)
              .addFields(
                { name: '🔗 Link', value: `[Ver na Steam](${link})`, inline: false },
                { name: '✅ Compatibilidade', value: '✅ **Compatível com Família Steam!**', inline: false }
              )
              .setTimestamp();
            const detalhes = await getGameDetails(appid);
            if (detalhes?.header_image) embed.setImage(detalhes.header_image);

            // 🔥 ENVIA COM @everyone E MENÇÃO AO COMPRADOR
            await channelNotificacoes.send({
              content: `@everyone 🎉 **${userName}** comprou um novo jogo!`,
              embeds: [embed]
            });

            if (db.ranking[steamId]) {
              db.ranking[steamId].jogos += 1;
              salvarDB(db);
              await enviarRanking();
            }

            // Remove da lista /quero de quem tinha
            for (const [discordIdQuero, jogos] of Object.entries(db.listaQuero || {})) {
              if (!jogos) continue;
              for (const j of jogos) {
                if (j.appid === appid) {
                  removerQuero(discordIdQuero, appid);
                  try {
                    const user = await client.users.fetch(discordIdQuero);
                    await user.send(`🎮 **${nome}** foi removido da sua lista /quero!\n✅ **${userName}** adquiriu este jogo.`);
                  } catch (_) {}
                }
              }
            }
          } else {
            // 🔥 JOGO INCOMPATÍVEL - NÃO ANUNCIA COM @everyone, apenas log
            console.log(`⚠️ Jogo ${nome} (${appid}) é INCOMPATÍVEL com Family Sharing - não anunciado. Motivo: ${compat.motivo}`);
          }
        }
      }
      previousGames[steamId] = currentGames;
      db.historicoJogos[steamId] = currentGames.map(g => g.appid);
      salvarDB(db);

    } catch (err) {
      console.error(`❌ Erro em ${steamId}:`, err.message);
    }
  }

  if (!primeiraVerificacaoConcluida) {
    primeiraVerificacaoConcluida = true;
    console.log('✅ PRIMEIRA VERIFICAÇÃO CONCLUÍDA!');
  }

  const duracao = ((Date.now() - inicio) / 1000).toFixed(1);
  console.log(`✅ Verificação concluída em ${duracao}s`);
}

// ============================================================
// 12. REGISTRO DE COMANDOS SLASH
// ============================================================
async function registrarComandos() {
  try {
    const commands = [
      {
        name: 'tem',
        description: 'Verifica se um jogo está na biblioteca da família (com compatibilidade)',
        options: [{
          name: 'jogo',
          description: 'Nome do jogo ou link da Steam',
          type: 3,
          required: true
        }]
      },
      {
        name: 'ranking',
        description: 'Mostra o ranking da biblioteca da família (apenas para você)'
      },
      {
        name: 'quero',
        description: 'Adiciona um jogo à sua lista de desejos personalizada (nome ou link)',
        options: [{
          name: 'jogo',
          description: 'Nome do jogo ou link da Steam',
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

    const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log('✅ Comandos globais registrados');
  } catch (err) {
    console.error('❌ Erro ao registrar comandos:', err);
  }
}

// ============================================================
// 13. EVENTOS
// ============================================================
client.once('ready', async () => {
  console.log(`✅ Bot online como ${client.user.tag}`);
  console.log(`💾 Usando banco de dados em: ${DB_FILE}`);
  await registrarComandos();

  if (db.historicoJogos && Object.keys(db.historicoJogos).length > 0) {
    console.log('📚 Histórico de jogos carregado do banco de dados.');
    for (const steamId of STEAM_IDS_ARRAY) {
      if (db.historicoJogos[steamId]) {
        const games = await getOwnedGames(steamId);
        const historicoIds = db.historicoJogos[steamId];
        previousGames[steamId] = games
          .filter(g => historicoIds.includes(g.appid))
          .map(g => ({ name: g.name, appid: g.appid, rtime_last_played: g.rtime_last_played || 0 }));
        const currentIds = games.map(g => g.appid);
        const missingIds = historicoIds.filter(id => !currentIds.includes(id));
        if (missingIds.length > 0) {
          db.historicoJogos[steamId] = currentIds;
          salvarDB(db);
        }
        console.log(`   ${MEMBROS[steamId]?.nome || steamId}: ${previousGames[steamId].length} jogos no histórico`);
      }
    }
  } else {
    console.log('🔄 Nenhum histórico encontrado. Criando histórico inicial (sem notificações)...');
    for (const steamId of STEAM_IDS_ARRAY) {
      try {
        const games = await getOwnedGames(steamId);
        db.historicoJogos[steamId] = games.map(g => g.appid);
        previousGames[steamId] = games.map(g => ({ name: g.name, appid: g.appid, rtime_last_played: g.rtime_last_played || 0 }));
        console.log(`   ${MEMBROS[steamId]?.nome || steamId}: ${games.length} jogos (inicializado)`);
      } catch (_) {}
    }
    salvarDB(db);
  }

  await checkSteamGames();
  setInterval(checkSteamGames, 15000);
  console.log(`🔄 Monitorando jogos a cada 15 segundos`);

  await verificarLancamentosQuero();
  setInterval(verificarLancamentosQuero, 5 * 60 * 1000);
  console.log(`🔄 Verificando lançamentos a cada 5 minutos`);

  await verificarPromocoesQuero();
  setInterval(verificarPromocoesQuero, 5 * 60 * 1000);
  console.log(`🔄 Verificando promoções a cada 5 minutos`);

  try {
    const dono = await client.users.fetch(DONO_ID);
    await dono.send('🚀 Bot Steam Família está online! @everyone ativado para jogos compatíveis.');
  } catch (_) {}
});

// ============================================================
// 14. COMANDOS SLASH
// ============================================================
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  // /tem (COM COMPATIBILIDADE NA DESCRIÇÃO - SEM CAMPO SEPARADO)
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

      const compat = await verificarCompatibilidadeFamilia(info.appid);

      const donos = [];
      for (const sid of STEAM_IDS_ARRAY) {
        if ((db.historicoJogos[sid] || []).includes(info.appid)) {
          const m = MEMBROS[sid];
          if (m) donos.push({ nome: m.nome, discordId: m.discordId });
        }
      }

      const embed = new EmbedBuilder()
        .setColor(donos.length > 0 ? 0x00FF00 : 0xFF0000)
        .setTitle(`${donos.length > 0 ? '✅' : '❌'} ${info.nome}`)
        .setURL(info.link)
        .setFooter({ text: 'Steam Família' });
      if (info.capa) embed.setThumbnail(info.capa);

      // 🔥 CONSTRÓI A DESCRIÇÃO COM OS DONOS E COMPATIBILIDADE
      let descricao = '';
      if (donos.length) {
        descricao = `🎮 **${donos.length} membro(s) possui(em):**\n`;
        donos.forEach((d, i) => descricao += `**${i+1}.** <@${d.discordId}>\n`);
      } else {
        descricao = '😕 **Nenhum membro da família possui este jogo.**';
      }

      // 🔥 ADICIONA A COMPATIBILIDADE DIRETAMENTE NA DESCRIÇÃO (SEM CAMPO SEPARADO)
      if (compat.compatível) {
        descricao += '\n✅ **Compatível com Família Steam!**';
      } else {
        descricao += `\n\n⚠️ **ATENÇÃO:** ❌ **${compat.motivo || 'Este jogo NÃO é compatível com Family Sharing'}**\nVerifique a página do jogo na Steam para mais informações.`;
      }

      embed.setDescription(descricao);

      await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      console.error('❌ Erro no /tem:', err);
      await interaction.editReply(`❌ Erro: ${err.message}`);
    }
  }

  // /ranking (EFÊMERO)
  if (interaction.commandName === 'ranking') {
    await interaction.deferReply({ ephemeral: true });
    const embed = gerarRankingEmbed();
    await interaction.editReply({ embeds: [embed] });
  }

  // /quero
  if (interaction.commandName === 'quero') {
    await interaction.deferReply({ ephemeral: true });
    try {
      const input = interaction.options.getString('jogo');
      let info = null;

      if (input.includes('store.steampowered.com/app/')) {
        const appid = extrairAppIdDaUrl(input);
        if (appid) {
          const detalhes = await getGameDetails(appid);
          if (detalhes) {
            info = {
              appid: appid,
              nome: detalhes.name,
              link: `https://store.steampowered.com/app/${appid}`,
              capa: detalhes.header_image || `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/header.jpg`,
              release_date: detalhes.release_date
            };
          }
        }
      } else {
        const searchResult = await searchGameOnSteam(input);
        if (searchResult) {
          const detalhes = await getGameDetails(searchResult.appid);
          info = {
            appid: searchResult.appid,
            nome: searchResult.nome,
            link: searchResult.link,
            capa: searchResult.capa,
            release_date: detalhes?.release_date
          };
        }
      }

      if (!info) {
        await interaction.editReply(`❌ Não encontrei **${input}** na Steam.`);
        return;
      }

      let userSteamId = null;
      for (const [sid, m] of Object.entries(MEMBROS)) {
        if (m.discordId === interaction.user.id) { userSteamId = sid; break; }
      }
      if (userSteamId && (db.historicoJogos[userSteamId] || []).includes(info.appid)) {
        await interaction.editReply(`ℹ️ Você **já possui** **${info.nome}**.`);
        return;
      }

      const resultado = await adicionarQuero(interaction.user.id, info.appid, info.nome, info.link);
      if (!resultado.sucesso) {
        if (resultado.motivo === 'ja_na_lista') {
          await interaction.editReply(`ℹ️ **${info.nome}** já está na sua lista /quero.`);
        } else if (resultado.motivo === 'ja_na_familia') {
          await interaction.editReply(`ℹ️ **${info.nome}** já está na família! 👤 ${resultado.dono}`);
        }
        return;
      }

      const isComingSoon = info.release_date?.coming_soon;
      let mensagemAdicional = '';
      if (isComingSoon === true) {
        mensagemAdicional = '🔔 Você receberá DM assim que este jogo for **LANÇADO**!';
      } else {
        mensagemAdicional = '🔔 Você receberá DM sempre que este jogo entrar em **PROMOÇÃO**!';
      }

      await interaction.editReply(`✅ **${info.nome}** adicionado à sua lista /quero!\n🔗 ${info.link}\n${mensagemAdicional}`);
    } catch (err) {
      console.error('❌ Erro no /quero:', err);
      await interaction.editReply(`❌ Erro ao adicionar o jogo: ${err.message}`);
    }
  }

  // /quero-listar
  if (interaction.commandName === 'quero-listar') {
    await interaction.deferReply({ ephemeral: true });
    try {
      const lista = listarQuero(interaction.user.id);
      if (!lista || !Array.isArray(lista) || lista.length === 0) {
        await interaction.editReply('📭 Sua lista /quero está vazia.');
        return;
      }

      const jogosExibir = lista.slice(0, 10);
      const totalJogos = lista.length;

      let descricao = jogosExibir
        .filter(j => j && j.nome && j.link)
        .map((j, i) => `**${i+1}.** [${j.nome}](${j.link})`)
        .join('\n');

      if (!descricao) {
        await interaction.editReply('📭 Sua lista /quero contém dados inválidos.');
        return;
      }

      if (descricao.length > 4000) {
        descricao = descricao.substring(0, 4000) + '\n... (lista truncada)';
      }

      const embed = new EmbedBuilder()
        .setColor(0x00AE86)
        .setTitle(`📋 Sua lista /quero (${totalJogos} jogos)`)
        .setDescription(descricao);

      if (totalJogos > 10) {
        embed.setFooter({ text: `Mostrando 10 de ${totalJogos}` });
      }

      await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      console.error('❌ Erro no /quero-listar:', err);
      try {
        const lista = listarQuero(interaction.user.id);
        if (lista && lista.length) {
          const texto = lista.map((j, i) => `${i+1}. ${j.nome} - ${j.link}`).join('\n');
          await interaction.editReply(`📋 **Sua lista /quero (${lista.length} jogos)**\n\`\`\`\n${texto.substring(0, 1900)}\n\`\`\``);
        } else {
          await interaction.editReply('❌ Erro ao listar. Tente novamente.');
        }
      } catch (_) {
        await interaction.editReply('❌ Erro ao listar seus jogos. Tente novamente.');
      }
    }
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
        await interaction.editReply(`ℹ️ **${info.nome}** não estava na sua lista.`);
      }
    } catch (err) {
      await interaction.editReply(`❌ Erro: ${err.message}`);
    }
  }

  // /dbstatus
  if (interaction.commandName === 'dbstatus') {
    if (interaction.user.id !== DONO_ID) {
      await interaction.reply({ content: '❌ Apenas o dono.', ephemeral: true });
      return;
    }
    await interaction.deferReply({ ephemeral: true });
    const totalQuero = Object.values(db.listaQuero || {}).reduce((acc, arr) => acc + (arr ? arr.length : 0), 0);
    const totalConquistas = Object.values(db.conquistas || {}).reduce((acc, obj) => acc + Object.keys(obj || {}).length, 0);
    const msg = `📊 **Status do DB:**\n📋 /quero: ${totalQuero} jogos\n🏆 Conquistas rastreadas: ${totalConquistas}\n👥 Membros: ${Object.keys(db.ranking || {}).length}\n💾 Arquivo: ${DB_FILE}`;
    await interaction.editReply(msg);
  }
});

// ============================================================
// 15. !resetranking
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
    salvarDB(db);
    await enviarRanking();
    await message.reply('✅ Ranking resetado.');
  });
  collector.on('end', collected => {
    if (collected.size === 0) message.reply('⏰ Cancelado.');
  });
});

// ============================================================
// 16. HEALTH CHECK
// ============================================================
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
});
server.listen(PORT, () => console.log(`✅ Health check na porta ${PORT}`));

// ============================================================
// 17. LOGIN
// ============================================================
client.login(DISCORD_TOKEN)
  .then(() => console.log('✅ Login bem-sucedido!'))
  .catch(err => {
    console.error('❌ Erro ao fazer login:', err.message);
    process.exit(1);
  });

process.on('SIGTERM', () => { salvarDB(db); process.exit(0); });
process.on('SIGINT', () => { salvarDB(db); process.exit(0); });

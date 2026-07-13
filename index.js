// ============================================================
// BOT STEAM FAMÍLIA - ÍCONES DE CONQUISTA CORRIGIDOS
// ============================================================

console.log('🚀 [1] Iniciando o script...');

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { Client, GatewayIntentBits, EmbedBuilder, REST, Routes, AttachmentBuilder } = require('discord.js');

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
  QUERO_CHANNEL_ID,
  RULES_CHANNEL_ID,
  DONO_ID
} = process.env;

console.log('🚀 [3] Variáveis lidas.');
console.log(`📌 DISCORD_TOKEN presente: ${DISCORD_TOKEN ? 'SIM' : 'NÃO'}`);
console.log(`📌 QUERO_CHANNEL_ID: ${QUERO_CHANNEL_ID || 'NÃO DEFINIDO'}`);
console.log(`📌 RULES_CHANNEL_ID: ${RULES_CHANNEL_ID || 'NÃO DEFINIDO'}`);

if (!DISCORD_TOKEN || !STEAM_KEY || !STEAM_IDS || !CHANNEL_ID || !QUERO_CHANNEL_ID || !RULES_CHANNEL_ID) {
  console.error('❌ Variáveis obrigatórias ausentes. Verifique .env');
  process.exit(1);
}

const STEAM_IDS_ARRAY = STEAM_IDS.split(',').map(id => id.trim());
const QUERO_CHANNEL = QUERO_CHANNEL_ID;
const RULES_CHANNEL = RULES_CHANNEL_ID;

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

console.log('🚀 [4] Membros carregados.');

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

console.log('🚀 [5] Constantes definidas.');

// ============================================================
// 4. BANCO DE DADOS (ANEXO NO CANAL PRIVADO)
// ============================================================
let db = null;
let dbMessageId = null;

function criarDBInicial() {
  const ranking = {};
  for (const [steamId, jogos] of Object.entries(RANKING_VALUES)) {
    const member = MEMBROS[steamId];
    if (member) {
      ranking[steamId] = {
        nome: member.nome,
        jogos: jogos,
        steamId: steamId,
        discordId: member.discordId
      };
    }
  }
  return {
    ranking,
    conquistas: {},
    historicoJogos: {},
    ultimaMensagemRankingId: null,
    lancamentosNotificados: {},
    jogosSemConquistas: {},
    rankingVersion: RANKING_VERSION
  };
}

async function carregarDBDoCanal() {
  const channel = client.channels.cache.get(QUERO_CHANNEL);
  if (!channel) {
    console.error('❌ Canal QUERO_CHANNEL não encontrado!');
    return null;
  }
  try {
    const messages = await channel.messages.fetch({ limit: 50 });
    const dbMsg = messages.find(m => m.content === 'DB_FILE' && m.attachments.size > 0);
    if (dbMsg) {
      dbMessageId = dbMsg.id;
      const attachment = dbMsg.attachments.first();
      if (attachment && attachment.url) {
        const response = await axios.get(attachment.url, { responseType: 'json' });
        console.log('✅ Banco de dados carregado do anexo do canal.');
        return response.data;
      }
    }
  } catch (e) {
    console.error('❌ Erro ao carregar banco do anexo:', e);
  }
  return null;
}

async function salvarDBNoCanal() {
  const channel = client.channels.cache.get(QUERO_CHANNEL);
  if (!channel) {
    console.error('❌ Canal QUERO_CHANNEL não encontrado!');
    return false;
  }
  try {
    if (dbMessageId) {
      try {
        const antiga = await channel.messages.fetch(dbMessageId);
        if (antiga) await antiga.delete();
      } catch (_) {}
    }
    const jsonData = JSON.stringify(db, null, 2);
    const buffer = Buffer.from(jsonData, 'utf-8');
    const attachment = new AttachmentBuilder(buffer, { name: 'db.json' });
    const novaMsg = await channel.send({
      content: 'DB_FILE',
      files: [attachment]
    });
    dbMessageId = novaMsg.id;
    return true;
  } catch (e) {
    console.error('❌ Erro ao salvar banco no anexo:', e);
    return false;
  }
}

async function inicializarDB() {
  const dados = await carregarDBDoCanal();
  if (dados) {
    db = dados;
    if (!db.ranking) db.ranking = {};
    if (!db.conquistas) db.conquistas = {};
    if (!db.historicoJogos) db.historicoJogos = {};
    if (!db.ultimaMensagemRankingId) db.ultimaMensagemRankingId = null;
    if (!db.lancamentosNotificados) db.lancamentosNotificados = {};
    if (!db.jogosSemConquistas) db.jogosSemConquistas = {};
    if (!db.rankingVersion) db.rankingVersion = 0;
    if (db.rankingVersion < RANKING_VERSION) {
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
      await salvarDBNoCanal();
    }
    console.log(`💾 Banco de dados carregado do anexo (versão ${db.rankingVersion})`);
  } else {
    db = criarDBInicial();
    await salvarDBNoCanal();
    console.log('📊 Banco de dados inicial criado como anexo no canal.');
  }
}

console.log('🚀 [6] Funções de banco de dados (anexo) definidas.');

// ============================================================
// 5. FUNÇÕES DE LISTA /quero
// ============================================================
async function getQueroMessage(discordId) {
  const channel = client.channels.cache.get(QUERO_CHANNEL);
  if (!channel) return null;
  try {
    const messages = await channel.messages.fetch({ limit: 100 });
    return messages.find(m => m.content.startsWith(`QUERO_${discordId}:`)) || null;
  } catch (_) { return null; }
}

async function loadQueroList(discordId) {
  const msg = await getQueroMessage(discordId);
  if (!msg) return [];
  try {
    const jsonPart = msg.content.substring(msg.content.indexOf(':') + 1).trim();
    const list = JSON.parse(jsonPart);
    return Array.isArray(list) ? list : [];
  } catch (_) { return []; }
}

async function saveQueroList(discordId, list) {
  const channel = client.channels.cache.get(QUERO_CHANNEL);
  if (!channel) return false;
  const content = `QUERO_${discordId}: ${JSON.stringify(list)}`;
  try {
    const msg = await getQueroMessage(discordId);
    if (msg) await msg.edit(content);
    else await channel.send(content);
    return true;
  } catch (_) { return false; }
}

async function adicionarQuero(discordId, appid, nome, link) {
  const lista = await loadQueroList(discordId);
  if (lista.some(j => j.appid === appid)) return { sucesso: false, motivo: 'ja_na_lista' };
  for (const sid of STEAM_IDS_ARRAY) {
    if ((db.historicoJogos[sid] || []).includes(appid)) {
      const dono = MEMBROS[sid]?.nome || sid;
      return { sucesso: false, motivo: 'ja_na_familia', dono };
    }
  }
  let comingSoon = null;
  try {
    const detalhes = await getGameDetails(appid);
    if (detalhes && detalhes.release_date) comingSoon = detalhes.release_date.coming_soon === true;
  } catch (_) {}
  lista.push({ appid, nome, link, adicionado_em: new Date().toISOString(), coming_soon: comingSoon, ultimoEstadoPromocao: null });
  await saveQueroList(discordId, lista);
  return { sucesso: true };
}

async function removerQuero(discordId, appid) {
  const lista = await loadQueroList(discordId);
  const novaLista = lista.filter(j => j.appid !== appid);
  if (novaLista.length < lista.length) {
    await saveQueroList(discordId, novaLista);
    return true;
  }
  return false;
}

async function listarQuero(discordId) {
  return await loadQueroList(discordId);
}

console.log('🚀 [7] Funções /quero carregadas.');

// ============================================================
// 6. FUNÇÕES DA STEAM API
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
  if (achievementNameCache[cacheKey]) return achievementNameCache[cacheKey];
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

console.log('🚀 [8] Funções da Steam API carregadas.');

// ============================================================
// 7. COMPATIBILIDADE
// ============================================================
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
    return { compatível: false, motivo: `Este jogo (${JOGOS_INCOMPATIVEIS[appId]}) NÃO é compatível com Family Sharing (lista conhecida)` };
  }
  try {
    const detalhes = await getGameDetails(appId);
    if (detalhes) {
      const pubs = detalhes.publishers || [];
      const devs = detalhes.developers || [];
      const all = [...pubs, ...devs].map(s => s.toLowerCase());
      if (all.some(s => s.includes('ea ') || s.includes('electronic arts') || s === 'ea' || s === 'electronic arts')) {
        return { compatível: false, motivo: 'Jogos da Electronic Arts (EA) NÃO são compatíveis com Family Sharing' };
      }
      if (all.some(s => s.includes('rockstar'))) {
        return { compatível: false, motivo: 'Jogos da Rockstar Games NÃO são compatíveis com Family Sharing' };
      }
      if (all.some(s => s.includes('ubisoft'))) {
        return { compatível: false, motivo: 'Jogos da Ubisoft NÃO são compatíveis com Family Sharing' };
      }
      if (detalhes.is_free) return { compatível: false, motivo: 'Jogo gratuito não requer Family Sharing' };
      if (detalhes.exclude_from_family_sharing === true) return { compatível: false, motivo: 'Este jogo NÃO é compatível com Family Sharing' };
      if (!detalhes.price_overview) return { compatível: false, motivo: 'Jogo sem preço definido' };
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

console.log('🚀 [9] Funções de compatibilidade carregadas.');

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

async function enviarRanking() {
  try {
    const channel = client.channels.cache.get(RANKING_CHANNEL_ID);
    if (!channel) return;
    if (db.ultimaMensagemRankingId) {
      try {
        const antiga = await channel.messages.fetch(db.ultimaMensagemRankingId);
        if (antiga) await antiga.delete();
      } catch (_) {}
    }
    const embed = gerarRankingEmbed();
    const nova = await channel.send({ embeds: [embed] });
    db.ultimaMensagemRankingId = nova.id;
    await salvarDBNoCanal();
  } catch (err) {
    console.error('❌ Erro ao enviar ranking:', err);
  }
}

console.log('🚀 [10] Funções de ranking carregadas.');

// ============================================================
// 9. FUNÇÃO DE REGRAS
// ============================================================
async function enviarRegras() {
  const channel = client.channels.cache.get(RULES_CHANNEL);
  if (!channel) {
    console.error('❌ Canal de regras não encontrado!');
    return;
  }

  const embed = new EmbedBuilder()
    .setColor(0x00AE86)
    .setTitle('📜 REGRAS DO SERVIDOR')
    .setThumbnail('https://upload.wikimedia.org/wikipedia/commons/thumb/8/83/Steam_icon_logo.svg/1200px-Steam_icon_logo.svg.png')
    .setDescription(
      '**Bem-vindo à Família Steam!** 🎮\n\n' +
      '**📌 REGRAS GERAIS**\n' +
      '1️⃣ **Respeito acima de tudo** – Nada de ofensas, discurso de ódio ou assédio.\n' +
      '2️⃣ **Sem spam ou flood** – Evite enviar mensagens repetitivas ou conteúdo irrelevante.\n' +
      '3️⃣ **Conteúdo apropriado** – Nada de NSFW, gore ou material impróprio.\n' +
      '4️⃣ **Divulgação proibida** – Não divulgue outros servidores, produtos ou serviços sem permissão.\n' +
      '5️⃣ **Use os canais certos** – Cada canal tem um propósito. Respeite as categorias.\n' +
      '6️⃣ **Seja ativo e participe** – A família cresce com a interação de todos!\n\n' +
      '**🤖 COMANDOS DISPONÍVEIS**\n' +
      '`/tem [jogo]` – Verifica se um jogo está na biblioteca da família.\n' +
      '`/ranking` – Mostra o ranking de jogos da família.\n' +
      '`/quero [jogo]` – Adiciona um jogo à sua lista de desejos.\n' +
      '`/quero-listar` – Lista os jogos da sua lista /quero.\n' +
      '`/quero-remover [jogo]` – Remove um jogo da sua lista /quero.\n' +
      '`/dbstatus` – Status do banco de dados (apenas dono).\n' +
      '`/regras` – Exibe esta mensagem novamente.\n\n' +
      '**🔔 NOTIFICAÇÕES**\n' +
      '• 🆕 Novos jogos compatíveis são anunciados com `@everyone`.\n' +
      '• 🏆 Conquistas são monitoradas e notificadas no canal de conquistas.\n' +
      '• 📢 Lançamentos e promoções de jogos da sua lista `/quero` são enviados por DM.\n\n' +
      '**📌 CANAIS IMPORTANTES**\n' +
      `• 📢 **Notificações:** <#${CHANNEL_ID}>\n` +
      `• 🏆 **Conquistas:** <#${ACHIEVEMENT_CHANNEL_ID}>\n` +
      `• 📋 **Ranking:** <#${RANKING_CHANNEL_ID}>\n` +
      `• 📜 **Regras:** <#${RULES_CHANNEL}>\n\n` +
      '**✅ REGRAS SUJEITAS A MUDANÇAS** – A administração pode atualizar as regras a qualquer momento.\n' +
      '**Divirta-se e bem-vindo à família!** 🚀'
    )
    .setTimestamp()
    .setFooter({ text: 'Steam Família - Regras e Comandos', iconURL: 'https://upload.wikimedia.org/wikipedia/commons/thumb/8/83/Steam_icon_logo.svg/1200px-Steam_icon_logo.svg.png' });

  try {
    await channel.send({ embeds: [embed] });
    console.log('📜 Mensagem de regras enviada no canal:', RULES_CHANNEL);
  } catch (err) {
    console.error('❌ Erro ao enviar regras:', err);
  }
}

// ============================================================
// 10. VERIFICAÇÃO DE CONQUISTAS (COM ÍCONE CORRIGIDO)
// ============================================================
async function verificarConquistas(steamId, gamesToCheck, mention, userName) {
  if (!gamesToCheck?.length) return;
  const channel = client.channels.cache.get(ACHIEVEMENT_CHANNEL_ID);
  if (!channel) return;
  if (!db.conquistas[steamId]) db.conquistas[steamId] = {};

  const jogosParaVerificar = gamesToCheck.filter(g => !db.jogosSemConquistas || !db.jogosSemConquistas[g.appid]);
  if (jogosParaVerificar.length === 0) return;

  for (const game of jogosParaVerificar) {
    const appid = game.appid;
    const gameName = game.name || `Jogo ${appid}`;
    let conquistas;
    try {
      conquistas = await getPlayerAchievements(steamId, appid);
    } catch (e) {
      if (!db.jogosSemConquistas) db.jogosSemConquistas = {};
      db.jogosSemConquistas[appid] = { nome: gameName, data: new Date().toISOString(), motivo: 'erro_na_api' };
      await salvarDBNoCanal();
      continue;
    }
    if (!conquistas || conquistas.length === 0) {
      if (!db.jogosSemConquistas) db.jogosSemConquistas = {};
      db.jogosSemConquistas[appid] = { nome: gameName, data: new Date().toISOString(), motivo: 'sem_conquistas' };
      await salvarDBNoCanal();
      continue;
    }
    const desbloqueadas = conquistas.filter(c => c.achieved === 1);
    const total = desbloqueadas.length;
    const totalJogo = conquistas.length;
    if (!db.conquistas[steamId][appid]) {
      db.conquistas[steamId][appid] = { total, nomes: desbloqueadas.map(c => c.apiname), totalJogo };
      await salvarDBNoCanal();
      continue;
    }
    const anterior = db.conquistas[steamId][appid];
    const totalAntigo = anterior.total || 0;
    const antigos = anterior.nomes || [];
    const novas = desbloqueadas.filter(c => !antigos.includes(c.apiname));
    if (novas.length === 0) continue;
    const faltam = totalJogo - total;
    let contador = 0;
    for (const ach of novas) {
      contador++;
      const progressoAtual = totalAntigo + contador;
      const progresso = `${progressoAtual}/${totalJogo}`;
      const nomeBonito = await getAchievementDisplayName(appid, ach.apiname);

      // 🔥 URL CORRIGIDA DO ÍCONE DA CONQUISTA (usando Cloudflare)
      const iconUrl = ach.icon ? `https://cdn.cloudflare.steamstatic.com/steamcommunity/public/images/apps/${appid}/${ach.icon}.jpg` : null;

      const embed = new EmbedBuilder()
        .setColor(0xFFD700)
        .setTitle(`${ACHIEVEMENT_EMOJI} ${userName} desbloqueou uma conquista!`)
        .setDescription(`**${nomeBonito}**`)
        .addFields(
          { name: '🎮 Jogo', value: gameName, inline: true },
          { name: '👤 Jogador', value: mention, inline: true },
          { name: '📊 Progresso', value: `${progresso} ${faltam > 0 ? `(faltam ${faltam - (contador - 1)})` : '🎉 COMPLETO!'}`, inline: true }
        )
        .setFooter({ text: `+${novas.length} nova(s) conquista(s)` })
        .setTimestamp();

      // 🔥 EXIBE O ÍCONE DA CONQUISTA (se disponível)
      if (iconUrl) {
        embed.setImage(iconUrl);
      } else {
        // Fallback: usa a capa do jogo se não houver ícone
        const detalhes = await getGameDetails(appid);
        if (detalhes?.header_image) {
          embed.setImage(detalhes.header_image);
        }
      }

      // Opcional: adiciona a capa do jogo como thumbnail
      const detalhes = await getGameDetails(appid);
      if (detalhes?.header_image) embed.setThumbnail(detalhes.header_image);

      await channel.send({ embeds: [embed] });
    }
    db.conquistas[steamId][appid] = { total, nomes: desbloqueadas.map(c => c.apiname), totalJogo };
    await salvarDBNoCanal();
  }
}

// ============================================================
// 11. VERIFICAÇÃO DE NOVOS JOGOS E TAREFAS
// ============================================================
async function verificarLancamentosQuero() {
  try {
    const channel = client.channels.cache.get(QUERO_CHANNEL);
    if (!channel) return;
    const messages = await channel.messages.fetch({ limit: 100 });
    const queroMessages = messages.filter(m => m.content.startsWith('QUERO_'));
    for (const [, msg] of queroMessages) {
      const discordId = msg.content.split(':')[0].replace('QUERO_', '');
      const lista = await loadQueroList(discordId);
      if (!lista.length) continue;
      let usuario;
      try { usuario = await client.users.fetch(discordId); } catch (_) { continue; }
      for (const jogo of lista) {
        const chave = `${discordId}_${jogo.appid}`;
        if (db.lancamentosNotificados?.[chave]) continue;
        if (jogo.coming_soon === false) continue;
        const detalhes = await getGameDetails(jogo.appid);
        if (!detalhes) continue;
        const isComingSoon = detalhes.release_date?.coming_soon;
        const hasPrice = !!detalhes.price_overview;
        const isAvailable = (isComingSoon === false) && hasPrice;
        if (jogo.coming_soon === true && isAvailable) {
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
            if (!db.lancamentosNotificados) db.lancamentosNotificados = {};
            db.lancamentosNotificados[chave] = Date.now();
            jogo.coming_soon = false;
            await saveQueroList(discordId, lista);
          } catch (err) {
            console.error(`❌ Erro ao enviar DM para ${usuario.username}:`, err.message);
          }
        }
      }
    }
  } catch (err) {
    console.error('❌ Erro em verificarLancamentosQuero:', err);
  }
}

async function verificarPromocoesQuero() {
  try {
    const channel = client.channels.cache.get(QUERO_CHANNEL);
    if (!channel) return;
    const messages = await channel.messages.fetch({ limit: 100 });
    const queroMessages = messages.filter(m => m.content.startsWith('QUERO_'));
    for (const [, msg] of queroMessages) {
      const discordId = msg.content.split(':')[0].replace('QUERO_', '');
      const lista = await loadQueroList(discordId);
      if (!lista.length) continue;
      let usuario;
      try { usuario = await client.users.fetch(discordId); } catch (_) { continue; }
      for (const jogo of lista) {
        const preco = await getPriceOverview(jogo.appid);
        if (!preco) continue;
        const estaEmPromocao = preco.emPromocao && preco.desconto > 0;
        const estadoAnterior = jogo.ultimoEstadoPromocao;
        if (estaEmPromocao && (estadoAnterior === false || estadoAnterior === null)) {
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
          } catch (err) {
            console.error(`❌ Erro ao enviar DM para ${usuario.username}:`, err.message);
          }
          jogo.ultimoEstadoPromocao = true;
          await saveQueroList(discordId, lista);
        } else if (!estaEmPromocao && estadoAnterior === true) {
          jogo.ultimoEstadoPromocao = false;
          await saveQueroList(discordId, lista);
        } else if (estadoAnterior === null) {
          jogo.ultimoEstadoPromocao = estaEmPromocao;
          await saveQueroList(discordId, lista);
        }
      }
    }
  } catch (err) {
    console.error('❌ Erro em verificarPromocoesQuero:', err);
  }
}

async function checkNewGames() {
  try {
    const channelNotificacoes = client.channels.cache.get(CHANNEL_ID);
    if (!channelNotificacoes) return;

    for (const steamId of STEAM_IDS_ARRAY) {
      try {
        const allGames = await getOwnedGames(steamId);
        if (!allGames.length) continue;
        const member = MEMBROS[steamId];
        if (!member) continue;
        const userName = member.nome;
        const discordId = member.discordId;
        const mention = `<@${discordId}>`;

        if (!db.historicoJogos[steamId]) {
          db.historicoJogos[steamId] = allGames.map(g => g.appid);
          await salvarDBNoCanal();
          continue;
        }
        const oldIds = db.historicoJogos[steamId] || [];
        const newGames = allGames.filter(g => !oldIds.includes(g.appid));
        if (newGames.length === 0) continue;

        for (const game of newGames) {
          const appid = game.appid;
          const nome = game.name || `App ${appid}`;
          const link = `https://store.steampowered.com/app/${appid}`;
          const compat = await verificarCompatibilidadeFamilia(appid);
          if (!compat.compatível) {
            console.log(`⚠️ Jogo ${nome} (${appid}) é INCOMPATÍVEL - não anunciado.`);
            continue;
          }
          const embed = new EmbedBuilder()
            .setColor(0x00FF00)
            .setTitle(`🛒 NOVO JOGO NA FAMÍLIA!`)
            .setDescription(`**${userName}** agora tem acesso a **${nome}**!\n\n✅ **Compatível com Família Steam!**`)
            .addFields({ name: '🔗 Link', value: `[Ver na Steam](${link})`, inline: false })
            .setTimestamp();
          const detalhes = await getGameDetails(appid);
          if (detalhes?.header_image) embed.setImage(detalhes.header_image);
          await channelNotificacoes.send({ content: `@everyone 🎉 **${userName}** comprou um novo jogo!`, embeds: [embed] });

          if (db.ranking[steamId]) {
            db.ranking[steamId].jogos += 1;
            await salvarDBNoCanal();
            await enviarRanking();
          }

          // Remove da lista /quero de quem tinha
          const channel = client.channels.cache.get(QUERO_CHANNEL);
          if (channel) {
            const messages = await channel.messages.fetch({ limit: 100 });
            const queroMessages = messages.filter(m => m.content.startsWith('QUERO_'));
            for (const [, msg] of queroMessages) {
              const dId = msg.content.split(':')[0].replace('QUERO_', '');
              const lista = await loadQueroList(dId);
              const temJogo = lista.some(j => j.appid === appid);
              if (temJogo) {
                await removerQuero(dId, appid);
                try {
                  const user = await client.users.fetch(dId);
                  await user.send(`🎮 **${nome}** foi removido da sua lista /quero!\n✅ **${userName}** adquiriu este jogo.`);
                } catch (_) {}
              }
            }
          }
        }
        db.historicoJogos[steamId] = allGames.map(g => g.appid);
        await salvarDBNoCanal();
      } catch (err) {
        console.error(`❌ Erro em ${steamId}:`, err.message);
      }
    }
  } catch (err) {
    console.error('❌ Erro em checkNewGames:', err);
  }
}

async function checkAchievements() {
  try {
    for (const steamId of STEAM_IDS_ARRAY) {
      try {
        const member = MEMBROS[steamId];
        if (!member) continue;
        const userName = member.nome;
        const discordId = member.discordId;
        const mention = `<@${discordId}>`;

        const currentGame = await getCurrentGame(steamId);
        let recentGames = await getRecentlyPlayedGames(steamId, 3);
        let gamesToCheck = [];
        if (currentGame) {
          const jaExiste = recentGames.some(g => g.appid === currentGame.appid);
          const currentGameObj = { appid: currentGame.appid, name: currentGame.name, rtime_last_played: Date.now() / 1000 };
          if (jaExiste) {
            recentGames = recentGames.filter(g => g.appid !== currentGame.appid);
          }
          gamesToCheck = [currentGameObj, ...recentGames.slice(0, 2)];
        } else {
          gamesToCheck = recentGames.slice(0, 3);
        }
        await verificarConquistas(steamId, gamesToCheck, mention, userName);
      } catch (err) {
        console.error(`❌ Erro em ${steamId}:`, err.message);
      }
    }
  } catch (err) {
    console.error('❌ Erro em checkAchievements:', err);
  }
}

console.log('🚀 [11] Tarefas periódicas carregadas.');

// ============================================================
// 12. CLIENT DISCORD
// ============================================================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

console.log('🚀 [12] Cliente Discord criado.');

// ============================================================
// 13. EVENTO clientReady
// ============================================================
client.once('clientReady', async () => {
  console.log(`✅ Bot online como ${client.user.tag}`);
  console.log(`📋 Banco de dados armazenado como anexo no canal: <#${QUERO_CHANNEL}>`);
  console.log(`📜 Canal de regras: <#${RULES_CHANNEL}> (envio manual via /regras)`);

  try {
    await inicializarDB();

    // Atualiza ranking se necessário
    if (db.rankingVersion < RANKING_VERSION) {
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
      await salvarDBNoCanal();
      await enviarRanking();
    }

    if (Object.keys(db.historicoJogos).length === 0) {
      console.log('🔄 Criando histórico inicial de jogos...');
      for (const steamId of STEAM_IDS_ARRAY) {
        try {
          const games = await getOwnedGames(steamId);
          db.historicoJogos[steamId] = games.map(g => g.appid);
          console.log(`   ${MEMBROS[steamId]?.nome || steamId}: ${games.length} jogos`);
        } catch (_) {}
      }
      await salvarDBNoCanal();
    }

    // Registra comandos
    console.log('🔄 Registrando comandos...');
    try {
      const commands = [
        { name: 'tem', description: 'Verifica se um jogo está na biblioteca da família', options: [{ name: 'jogo', description: 'Nome do jogo ou link da Steam', type: 3, required: true }] },
        { name: 'ranking', description: 'Mostra o ranking da biblioteca da família' },
        { name: 'quero', description: 'Adiciona um jogo à sua lista de desejos', options: [{ name: 'jogo', description: 'Nome do jogo ou link da Steam', type: 3, required: true }] },
        { name: 'quero-listar', description: 'Lista os jogos da sua lista /quero' },
        { name: 'quero-remover', description: 'Remove um jogo da sua lista /quero', options: [{ name: 'jogo', description: 'Nome do jogo para remover', type: 3, required: true }] },
        { name: 'dbstatus', description: '[DONO] Status do banco de dados' },
        { name: 'regras', description: 'Mostra as regras e comandos do servidor' }
      ];
      const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
      await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
      console.log('✅ Comandos registrados');
    } catch (err) {
      console.error('❌ Erro ao registrar comandos:', err);
    }

    setInterval(checkAchievements, 30000);
    setInterval(checkNewGames, 300000);
    setInterval(verificarLancamentosQuero, 5 * 60 * 1000);
    setInterval(verificarPromocoesQuero, 5 * 60 * 1000);
    console.log('🔄 Monitorando conquistas a cada 30s, novos jogos a cada 5min.');

    try {
      const dono = await client.users.fetch(DONO_ID);
      await dono.send('🚀 Bot Steam Família está online! Ícones de conquista corrigidos.');
    } catch (_) {}
  } catch (err) {
    console.error('❌ ERRO FATAL NO EVENTO clientReady:', err);
    console.error('❌ Stack:', err.stack);
  }
});

// ============================================================
// 14. COMANDOS SLASH
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
      let desc = donos.length ? `🎮 **${donos.length} membro(s) possui(em):**\n${donos.map((d, i) => `**${i+1}.** <@${d.discordId}>`).join('\n')}` : '😕 **Nenhum membro da família possui este jogo.**';
      if (compat.compatível) desc += '\n✅ **Compatível com Família Steam!**';
      else desc += `\n\n⚠️ **ATENÇÃO:** ❌ **${compat.motivo}**\nVerifique a página do jogo.`;
      embed.setDescription(desc);
      await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      await interaction.editReply(`❌ Erro: ${err.message}`);
    }
  }

  // /ranking
  if (interaction.commandName === 'ranking') {
    await interaction.deferReply({ ephemeral: true });
    await interaction.editReply({ embeds: [gerarRankingEmbed()] });
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
          if (detalhes) info = { appid, nome: detalhes.name, link: `https://store.steampowered.com/app/${appid}`, capa: detalhes.header_image, release_date: detalhes.release_date };
        }
      } else {
        const result = await searchGameOnSteam(input);
        if (result) {
          const detalhes = await getGameDetails(result.appid);
          info = { ...result, release_date: detalhes?.release_date };
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
      const msg = `✅ **${info.nome}** adicionado à sua lista /quero!\n🔗 ${info.link}\n🔔 Você receberá DM ${isComingSoon === true ? 'quando for **LANÇADO**' : 'em **PROMOÇÃO**'}.`;
      await interaction.editReply(msg);
    } catch (err) {
      await interaction.editReply(`❌ Erro: ${err.message}`);
    }
  }

  // /quero-listar (CORRIGIDO)
  if (interaction.commandName === 'quero-listar') {
    await interaction.deferReply({ ephemeral: true });
    try {
      const lista = await listarQuero(interaction.user.id);
      if (!lista || !Array.isArray(lista) || lista.length === 0) {
        await interaction.editReply('📭 Sua lista /quero está vazia.');
        return;
      }

      const jogosExibir = lista.slice(0, 20);
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

      if (totalJogos > 20) {
        embed.setFooter({ text: `Mostrando 20 de ${totalJogos}` });
      }

      await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      console.error('❌ Erro no /quero-listar:', err);
      try {
        const lista = await listarQuero(interaction.user.id);
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
      const input = interaction.options.getString('jogo');
      const info = await searchGameOnSteam(input);
      if (!info) {
        await interaction.editReply(`❌ Não encontrei **${input}** na Steam.`);
        return;
      }
      const removido = await removerQuero(interaction.user.id, info.appid);
      if (removido) await interaction.editReply(`✅ **${info.nome}** removido da sua lista /quero.`);
      else await interaction.editReply(`ℹ️ **${info.nome}** não estava na sua lista.`);
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
    const totalQuero = (await loadQueroList(interaction.user.id)).length;
    const totalConquistas = Object.values(db.conquistas || {}).reduce((acc, obj) => acc + Object.keys(obj || {}).length, 0);
    const msg = `📊 **Status do DB:**\n📋 /quero: ${totalQuero} jogos (canal privado)\n🏆 Conquistas rastreadas: ${totalConquistas}\n👥 Membros: ${Object.keys(db.ranking || {}).length}\n💾 Banco de dados salvo como anexo no canal <#${QUERO_CHANNEL}>`;
    await interaction.editReply(msg);
  }

  // /regras
  if (interaction.commandName === 'regras') {
    await interaction.deferReply({ ephemeral: true });
    try {
      await enviarRegras();
      await interaction.editReply('✅ Mensagem de regras enviada no canal <#' + RULES_CHANNEL + '>.');
    } catch (err) {
      await interaction.editReply(`❌ Erro ao enviar regras: ${err.message}`);
    }
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
    db.rankingVersion = RANKING_VERSION;
    await salvarDBNoCanal();
    await enviarRanking();
    await message.reply('✅ Ranking resetado.');
  });
  collector.on('end', collected => {
    if (collected.size === 0) message.reply('⏰ Cancelado.');
  });
});

// ============================================================
// 16. LOGIN
// ============================================================
console.log('🔑 Tentando login...');
client.login(DISCORD_TOKEN)
  .then(() => console.log('✅ Login chamado com sucesso'))
  .catch(err => {
    console.error('❌ Erro ao fazer login:', err.message);
    process.exit(1);
  });

process.on('SIGTERM', () => { process.exit(0); });
process.on('SIGINT', () => { process.exit(0); });

// ============================================================
// BOT STEAM FAMÍLIA - VERSÃO COM LOGS EXTENSIVOS
// ============================================================

console.log('🚀 [1] Iniciando o script...');

require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');

console.log('🚀 [2] Dependências carregadas.');

const {
  DISCORD_TOKEN,
  STEAM_KEY,
  STEAM_IDS,
  CHANNEL_ID,
  RANKING_CHANNEL_ID,
  ACHIEVEMENT_CHANNEL_ID,
  QUERO_CHANNEL_ID,
  DONO_ID
} = process.env;

console.log('🚀 [3] Variáveis lidas.');
console.log(`📌 DISCORD_TOKEN presente: ${DISCORD_TOKEN ? 'SIM' : 'NÃO'}`);
console.log(`📌 QUERO_CHANNEL_ID: ${QUERO_CHANNEL_ID || 'NÃO DEFINIDO'}`);

if (!DISCORD_TOKEN) {
  console.error('❌ DISCORD_TOKEN não definido!');
  process.exit(1);
}

console.log('🚀 [4] Criando cliente Discord...');
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

console.log('🚀 [5] Cliente criado. Definindo eventos...');

client.once('ready', () => {
  console.log(`✅ Bot online como ${client.user.tag}`);
  console.log('✅ Evento READY disparado com sucesso!');
  // A partir daqui, o bot está conectado – podemos continuar com o resto.
  // Por enquanto, apenas mantemos o bot vivo.
});

client.on('error', (err) => {
  console.error('❌ Erro no cliente:', err);
});

console.log('🚀 [6] Eventos definidos. Tentando login...');

client.login(DISCORD_TOKEN)
  .then(() => console.log('✅ Login chamado com sucesso'))
  .catch(err => {
    console.error('❌ Erro ao fazer login:', err.message);
    process.exit(1);
  });

console.log('🚀 [7] Script finalizado (aguardando eventos do Discord).');

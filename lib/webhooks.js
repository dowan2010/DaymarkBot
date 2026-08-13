const CMD_LOG_WEBHOOK        = 'https://discord.com/api/webhooks/1502569890647638067/SiGigkpk7IlpSf5VGThy4WDcoWyPltXtlexDmYyTpTqyoSlr5V5OPtrstLhz4UIHstxw';
const ADMIN_LOG_WEBHOOK      = 'https://discord.com/api/webhooks/1502572992339771453/-gknedBcAcSX5tWYf7t9zViFA82sJTaiPCoGUljG6XHotXtiGJJudfVgHvd0zBRRq08k';
export const REFLECTION_LOG_WEBHOOK = 'https://discord.com/api/webhooks/1503587658075476139/3rtkX4FoBmkvq9P0AhpugFD-gWlAJswKnEGwy_ENG3UJyausJwnaBX-TPWsVF97IE9Nx';

export function sendCmdLog(interaction, extra = '') {
  const now = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false });
  const user = interaction.user;
  const guild = interaction.guild?.name ?? 'DM';
  const channel = interaction.channel?.name ? `#${interaction.channel.name}` : '알 수 없음';
  const options = interaction.options?.data ?? [];
  const optStr = options.map(o => `${o.name}: ${o.value}`).join(', ');
  let desc = `<@${user.id}>`;
  if (optStr) desc += `\n> ${optStr}`;
  if (extra) desc += `\n> ${extra}`;
  fetch(CMD_LOG_WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ embeds: [{
      title: `📋 /${interaction.commandName}`,
      description: desc,
      color: 0x5865F2,
      fields: [
        { name: '유저', value: `${user.username} (\`${user.id}\`)`, inline: true },
        { name: '서버', value: guild, inline: true },
        { name: '채널', value: channel, inline: true },
        { name: '시간', value: now, inline: false },
      ],
    }] }),
  }).catch(() => {});
}

export function sendAdminLog(message, cmd, args = []) {
  const now = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false });
  const user = message.author;
  const isDM = !message.guild;
  const guild = message.guild?.name ?? 'DM';
  const channel = isDM ? 'DM' : (message.channel?.name ? `#${message.channel.name}` : '알 수 없음');
  const fullCmd = `!${cmd}${args.length ? ' ' + args.join(' ') : ''}`;
  fetch(ADMIN_LOG_WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ embeds: [{
      title: `🔧 !${cmd || '명령어'}`,
      description: `<@${user.id}>\n> \`${fullCmd}\``,
      color: 0xFFA500,
      fields: [
        { name: '유저', value: `${user.username} (\`${user.id}\`)`, inline: true },
        { name: '서버', value: guild, inline: true },
        { name: '채널', value: channel, inline: true },
        { name: '시간', value: now, inline: false },
      ],
    }] }),
  }).catch(() => {});
}

export async function sendExpiryLog(embed) {
  const url = process.env.EXPIRY_LOG_WEBHOOK;
  if (!url) return;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ embeds: [embed] }),
    });
  } catch (e) {
    console.error('[만료 로그] 전송 실패:', e.message);
  }
}

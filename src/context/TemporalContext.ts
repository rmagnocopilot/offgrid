export function buildTemporalContext(now = new Date()): string {
  const formatted = new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'full',
    timeStyle: 'long'
  }).format(now);

  return [
    '<contexto_temporal>',
    `Data e hora locais do sistema: ${formatted}.`,
    'Ao responder sobre hoje, ontem, amanhã, agora, datas ou horários, use esta informação do sistema e não uma data aprendida durante o treinamento.',
    '</contexto_temporal>'
  ].join('\n');
}

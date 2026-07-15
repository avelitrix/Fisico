FÍSICO v1 — AVELITRIX

Abra index.html por um servidor web/HTTPS.
Importa ZIP Garmin com FIT, ou FIT/TCX/GPX/CSV individuais.
Procura automaticamente jogos AveliCoach no localStorage do mesmo domínio.
O botão “Carregar exemplo” usa dados Garmin simulados e o jogo Caip Soyer fornecido pelo usuário.

A classificação “estado fisiológico estimado” é uma interpretação comparativa da FC por ponto, não diagnóstico emocional.


CORREÇÕES v1.1
- Service Worker somente em HTTP/HTTPS.
- Exemplo incorporado, sem fetch/CORS em file://.
- Leitura recursiva de jogos em diferentes estruturas do localStorage.
- Busca no armazenamento da janela, parent e top quando mesma origem.
- Diagnóstico de origem e armazenamento na faixa de status.
